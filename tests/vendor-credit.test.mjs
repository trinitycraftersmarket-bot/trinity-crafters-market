import test from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {readFile} from 'node:fs/promises';
import {adminSources, sourceRecord, eligibleEvents, issueCredit, redeemCredit, applicantCredits, redeemForApplication, applicationConflicts} from '../netlify/functions/vendor-credit.mjs';

// Same postgres.js tagged-template adapter as tests/features-a.test.mjs,
// plus .begin (PGlite is a single serialized connection, so explicit
// BEGIN/COMMIT around the callback is a faithful transaction here).
function pgliteSql(db) {
  const sql = async (strings, ...values) => {
    let text = '', params = [];
    strings.forEach((s, i) => { text += s; if (i < values.length) { params.push(values[i]); text += '$' + params.length; } });
    return (await db.query(text, params)).rows;
  };
  sql.json = v => JSON.stringify(v); // core.audit()/queue() call tx.json (postgres.js)
  sql.begin = async fn => {
    await db.exec('begin');
    try { const r = await fn(sql); await db.exec('commit'); return r; }
    catch (e) { await db.exec('rollback'); throw e; }
  };
  return sql;
}

async function seededDb() {
  const db = new PGlite();
  await db.exec('create role anon; create role authenticated; create schema storage; create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);');
  await db.exec(await readFile('database/setup.sql', 'utf8'));
  await db.exec(await readFile('database/codify-live-schema.sql', 'utf8'));
  await db.exec(await readFile('database/vendor-credits.sql', 'utf8'));
  await db.exec(await readFile('database/waitlist-offers.sql', 'utf8'));
  await db.exec(await readFile('database/vendor-profiles.sql', 'utf8'));
  const sql = pgliteSql(db);
  const [hampton] = await sql`insert into market.locations(name,address,indoor_capacity,outdoor_capacity,indoor_price,outdoor_price) values('Hampton Inn Odessa Trinity','11780 State Rd 54',9,3,4500,3500) returning id`;
  const [hilton] = await sql`insert into market.locations(name,address,indoor_capacity,outdoor_capacity,indoor_price,outdoor_price) values('Hilton Garden Inn Suncoast','1 Hilton Way',36,2,4500,3500) returning id`;
  await sql`update market.categories set vendor_limit = 10 where name = 'Bags'`;
  const cats = {};
  for (const row of await sql`select id,name from market.categories where name in ('Bags','Candles')`) cats[row.name] = row.id;
  async function event(date, locationId, indoorPrice = 4500) {
    const [e] = await sql`insert into market.events(location_id,date,indoor_capacity,outdoor_capacity,indoor_price,outdoor_price) values(${locationId},${date},2,1,${indoorPrice},3500) returning *`;
    return e;
  }
  async function booking({event: ev, email, business, category, status = 'paid', paid = true, description = 'Goods', price = 4500}) {
    const userId = crypto.randomUUID();
    const [app] = await sql`insert into market.applications(user_id,name,email,phone,business,description,category_id,photos,agreements) values(${userId},'Vendor',${email},'7275550100',${business},${description},${category},'{}','{}') returning id`;
    const [b] = await sql`insert into market.bookings(application_id,event_id,space,price,status) values(${app.id},${ev.id},'indoor',${price},${status}) returning *`;
    if (paid) await sql`update market.bookings set paid_at = now() where id = ${b.id}`;
    return {...b, user: {id: userId, email}};
  }
  async function imported({event: ev, email, business, category, paymentStatus = 'paid', paid = true, selling = ''}) {
    const [i] = await sql`insert into market.imported_attendees(event_id,name,business,email,phone,category_id,space,invoice_amount,payment_status,selling) values(${ev.id},'Vendor',${business},${email},'7275550100',${category},'indoor',4500,${paymentStatus},${selling}) returning *`;
    if (paid) await sql`update market.imported_attendees set paid_at = now() where id = ${i.id}`;
    await sql`insert into market.imported_category_reservations(imported_attendee_id,event_id,category_id,space) values(${i.id},${ev.id},${category},'indoor')`;
    return i;
  }
  // Mirror exactly what the Cancel Vendor actions do to paid evidence:
  // bookings keep paid_at/payment_reference; imported rows keep
  // payment_status/paid_at. (api.mjs 'booking' + 'imported-attendance'.)
  async function cancelBooking(id) {
    await sql`update market.bookings set status='cancelled',cancellation_reason='Vendor requested cancellation',cancelled_at=now(),cancelled_by='org@example.com' where id = ${id}`;
  }
  async function cancelImported(id) {
    await sql`update market.imported_attendees set cancelled=true,cancellation_reason='Vendor requested cancellation',cancelled_at=now(),cancelled_by='org@example.com' where id = ${id}`;
    await sql`delete from market.imported_category_reservations where imported_attendee_id = ${id}`;
  }
  async function directCredit({email, category, sourceEvent, sourceId, amount}) {
    const [c] = await sql`insert into market.vendor_credits(email,category_id,source_type,source_id,source_event_id,original_amount,remaining_amount,issued_by) values(${email},${category},'booking',${sourceId},${sourceEvent?.id ?? sourceEvent},${amount},${amount},'org@example.com') returning *`;
    return c;
  }
  return {db, sql, hampton, hilton, cats, event, booking, imported, cancelBooking, cancelImported, directCredit};
}

const ORG = {email: 'org@example.com', admin: true};

test('cancelled-paid booking remains a credit source (the Cancel Vendor trap)', async () => {
  const {sql, hampton, cats, event, booking, cancelBooking} = await seededDb();
  const A = await event('2027-03-06', hampton.id);
  const v = await booking({event: A, email: 'susan@example.com', business: 'Susan Crafts', category: cats.Bags});
  await cancelBooking(v.id);
  const sources = await adminSources(sql);
  const mine = sources.find(x => x.id === v.id && !x.imported);
  assert.ok(mine, 'cancelled-paid booking must still surface in admin-sources');
  assert.equal(mine.credit_id, null);
  assert.equal(Number(mine.amount), 4500);
  const rec = await sourceRecord(sql, v.id, false);
  assert.equal(rec.status, 'cancelled');
  assert.equal(rec.was_paid, true);
  assert.equal(Number(rec.paid_amount), 4500);
});

test('cancelled-paid imported attendee remains a credit source', async () => {
  const {sql, hampton, cats, event, imported, cancelImported} = await seededDb();
  const A = await event('2027-03-06', hampton.id);
  const v = await imported({event: A, email: 'susan@example.com', business: 'Susan Crafts', category: cats.Bags});
  await cancelImported(v.id);
  const sources = await adminSources(sql);
  const mine = sources.find(x => x.id === v.id && x.imported);
  assert.ok(mine, 'cancelled-paid imported attendee must still surface in admin-sources');
  assert.equal(mine.status, 'cancelled');
  const rec = await sourceRecord(sql, v.id, true);
  assert.equal(rec.was_paid, true);
  assert.equal(Number(rec.paid_amount), 4500);
});

test('unpaid records are not credit sources and cannot be issued (was_paid not loosened)', async () => {
  const {sql, hampton, cats, event, booking, imported} = await seededDb();
  const A = await event('2027-03-06', hampton.id);
  const b = await booking({event: A, email: 'unpaid@example.com', business: 'Unpaid Crafts', category: cats.Bags, status: 'approved', paid: false});
  const i = await imported({event: A, email: 'unpaid2@example.com', business: 'Unpaid Imports', category: cats.Bags, paymentStatus: 'unpaid', paid: false});
  const sources = await adminSources(sql);
  assert.equal(sources.find(x => x.id === b.id), undefined);
  assert.equal(sources.find(x => x.id === i.id), undefined);
  assert.equal((await sourceRecord(sql, b.id, false)).was_paid, false);
  assert.equal((await sourceRecord(sql, i.id, true)).was_paid, false);
  await assert.rejects(() => issueCredit(sql, {id: b.id, imported: false}, ORG), /paid booking/);
});

test('issue works on an already-cancelled paid booking, emails once, and is idempotent', async () => {
  const {sql, hampton, cats, event, booking, cancelBooking} = await seededDb();
  const A = await event('2027-03-06', hampton.id);
  const v = await booking({event: A, email: 'susan@example.com', business: 'Susan Crafts', category: cats.Bags});
  await cancelBooking(v.id);
  const credit = await issueCredit(sql, {id: v.id, imported: false}, ORG);
  assert.equal(Number(credit.original_amount), 4500);
  assert.equal(credit.status, 'available');
  const [b] = await sql`select status from market.bookings where id = ${v.id}`;
  assert.equal(b.status, 'cancelled');
  let mail = await sql`select recipient,subject from market.outbox where subject like 'Vendor credit available%'`;
  assert.equal(mail.length, 1);
  assert.equal(mail[0].recipient, 'susan@example.com');
  const again = await issueCredit(sql, {id: v.id, imported: false}, ORG);
  assert.equal(again.id, credit.id);
  const rows = await sql`select id from market.vendor_credits where source_type='booking' and source_id = ${v.id}`;
  assert.equal(rows.length, 1);
  mail = await sql`select recipient from market.outbox where subject like 'Vendor credit available%'`;
  assert.equal(mail.length, 1, 'idempotent re-issue must not re-email');
});

test('issue on a live paid imported attendee cancels it and releases the reservation', async () => {
  const {sql, hampton, cats, event, imported} = await seededDb();
  const A = await event('2027-03-06', hampton.id);
  const v = await imported({event: A, email: 'pat@example.com', business: 'Pat Potions', category: cats.Bags});
  const credit = await issueCredit(sql, {id: v.id, imported: true}, ORG);
  assert.equal(credit.source_type, 'imported');
  const [i] = await sql`select cancelled from market.imported_attendees where id = ${v.id}`;
  assert.equal(i.cancelled, true);
  const res = await sql`select imported_attendee_id from market.imported_category_reservations where imported_attendee_id = ${v.id}`;
  assert.equal(res.length, 0);
});

test('credit redeems at a different market/location, never expires, and marks the new booking paid from credit', async () => {
  const {sql, hampton, hilton, cats, event, booking} = await seededDb();
  const A = await event('2027-03-06', hampton.id);   // Trinity / Hampton Inn
  const B = await event('2027-03-20', hilton.id);    // Lutz / Hilton Garden Inn
  const v = await booking({event: A, email: 'susan@example.com', business: 'Susan Crafts', category: cats.Bags});
  const credit = await issueCredit(sql, {id: v.id, imported: false}, ORG);
  // Age the credit three years: availability must not depend on its age.
  await sql`update market.vendor_credits set issued_at = now() - interval '3 years' where id = ${credit.id}`;
  const [creditRow] = await sql`select * from market.vendor_credits where id = ${credit.id}`;
  assert.equal(creditRow.status, 'available');
  const eligible = await eligibleEvents(sql, creditRow, v.user);
  assert.ok(eligible.some(e => e.id === B.id), 'future date at the OTHER market must be eligible');
  assert.ok(!eligible.some(e => e.id === A.id), 'the source date itself stays excluded');
  const res = await redeemCredit(sql, {credit_id: credit.id, event_id: B.id, space: 'indoor'}, v.user);
  assert.equal(res.ok, true);
  assert.equal(res.remaining, 0);
  const [row] = await sql`select * from market.imported_attendees where id = ${res.booking_id}`;
  assert.equal(row.event_id, B.id);
  assert.equal(row.payment_status, 'paid');
  assert.equal(row.payment_method, 'Credit');
  assert.equal(row.payment_reference, 'CREDIT-' + credit.id.slice(0, 8));
  assert.equal(row.source_file, 'Vendor credit');
  assert.equal(Number(row.invoice_amount), 4500);
  const [c] = await sql`select status,remaining_amount from market.vendor_credits where id = ${credit.id}`;
  assert.equal(c.status, 'used');
  assert.equal(Number(c.remaining_amount), 0);
  const redemptions = await sql`select * from market.vendor_credit_redemptions where credit_id = ${credit.id}`;
  assert.equal(redemptions.length, 1);
  const mail = await sql`select recipient,subject from market.outbox where subject like 'Credit applied%'`;
  assert.equal(mail.length, 1);
  assert.equal(mail[0].recipient, 'susan@example.com');
});

test('credits carry no expiry in the schema, and a credit must fully cover the chosen space', async () => {
  const {sql, hampton, hilton, cats, event, booking} = await seededDb();
  const cols = await sql`select column_name from information_schema.columns where table_schema='market' and table_name='vendor_credits'`;
  assert.ok(!cols.some(c => /expir/i.test(c.column_name)), 'vendor_credits must not gain an expiry column');
  const A = await event('2027-03-06', hampton.id);
  const pricey = await event('2027-03-20', hilton.id, 5000);
  const v = await booking({event: A, email: 'susan@example.com', business: 'Susan Crafts', category: cats.Bags});
  const credit = await issueCredit(sql, {id: v.id, imported: false}, ORG);
  await assert.rejects(() => redeemCredit(sql, {credit_id: credit.id, event_id: pricey.id, space: 'indoor'}, v.user), /fully cover/);
});

test('Holly case: a category with vendor_limit 0 (no cap) still gets eligible dates and redeems', async () => {
  const {db, sql, hampton, hilton, cats, event, booking} = await seededDb();
  // Live categories sit at vendor_limit 0 (the live constraint was relaxed
  // out-of-band — codify-live-schema.sql §14a); mirror that here, then set
  // the category to 0 the way the owner's live data has it.
  await db.exec('alter table market.categories drop constraint if exists categories_vendor_limit_check');
  await sql`update market.categories set vendor_limit = 0 where id = ${cats.Candles}`;
  const A = await event('2027-03-06', hampton.id);
  const B = await event('2027-03-20', hilton.id);
  const v = await booking({event: A, email: 'holly@example.com', business: 'Holly Bell Designs', category: cats.Candles});
  const credit = await issueCredit(sql, {id: v.id, imported: false}, ORG);
  const [creditRow] = await sql`select * from market.vendor_credits where id = ${credit.id}`;
  const eligible = await eligibleEvents(sql, creditRow, v.user);
  assert.ok(eligible.some(e => e.id === B.id), 'limit 0 must not dead-end eligible dates');
  const res = await redeemCredit(sql, {credit_id: credit.id, event_id: B.id, space: 'indoor'}, v.user);
  assert.equal(res.ok, true);
  const [row] = await sql`select payment_status,payment_method from market.imported_attendees where id = ${res.booking_id}`;
  assert.equal(row.payment_status, 'paid');
  assert.equal(row.payment_method, 'Credit');
});

test('a real numeric category cap is still enforced (eligible dates + redeem)', async () => {
  const {sql, hampton, hilton, cats, event, booking} = await seededDb();
  // Candles has vendor_limit 1 in the seed. Another vendor fills it at B.
  const A = await event('2027-03-06', hampton.id);
  const B = await event('2027-03-20', hilton.id);
  await booking({event: B, email: 'other@example.com', business: 'Other Candles', category: cats.Candles});
  const v = await booking({event: A, email: 'susan@example.com', business: 'Susan Crafts', category: cats.Candles});
  const credit = await issueCredit(sql, {id: v.id, imported: false}, ORG);
  const [creditRow] = await sql`select * from market.vendor_credits where id = ${credit.id}`;
  const eligible = await eligibleEvents(sql, creditRow, v.user);
  assert.ok(!eligible.some(e => e.id === B.id), 'a full capped category must not be offered');
  await assert.rejects(() => redeemCredit(sql, {credit_id: credit.id, event_id: B.id, space: 'indoor'}, v.user), /category just filled/);
});

test('applicantCredits returns the review flag data for a credit-holding applicant', async () => {
  const {sql, hampton, cats, event, booking} = await seededDb();
  const A = await event('2027-03-06', hampton.id);
  const v = await booking({event: A, email: 'holly@example.com', business: 'Holly Bell Designs', category: cats.Bags});
  await issueCredit(sql, {id: v.id, imported: false}, ORG);
  const rows = await applicantCredits(sql);
  const mine = rows.find(x => x.email === 'holly@example.com');
  assert.ok(mine, 'available credit must surface for the Applications review flag');
  assert.equal(Number(mine.remaining_amount), 4500);
  assert.equal(mine.source_date, '2027-03-06');
});

test('organizer override: Approve & apply credit settles a pending booking on a category-full date', async () => {
  const {sql, hampton, hilton, cats, event, booking} = await seededDb();
  // Candles limit is 1: another vendor's paid booking fills it at B.
  const A = await event('2027-03-06', hampton.id);
  const B = await event('2027-03-20', hilton.id);
  await booking({event: B, email: 'other@example.com', business: 'Other Candles', category: cats.Candles});
  const source = await booking({event: A, email: 'susan@example.com', business: 'Susan Crafts', category: cats.Candles});
  const credit = await issueCredit(sql, {id: source.id, imported: false}, ORG);
  const pending = await booking({event: B, email: 'susan@example.com', business: 'Susan Crafts', category: cats.Candles, status: 'pending', paid: false});
  // Automatic redeem would refuse this date (category full); the organizer
  // override must not.
  const r = await redeemForApplication(sql, {booking_id: pending.id, credit_id: credit.id}, ORG);
  assert.equal(r.applied, 4500);
  assert.equal(r.amount_due, 0);
  assert.equal(r.status, 'paid');
  const [b] = await sql`select status,payment_method,payment_reference,paid_at from market.bookings where id = ${pending.id}`;
  assert.equal(b.status, 'paid');
  assert.equal(b.payment_method, 'Credit');
  assert.equal(b.payment_reference, 'CREDIT-' + credit.id.slice(0, 8));
  assert.ok(b.paid_at, 'full settlement marks paid_at');
  const payments = await sql`select amount,payment_method,recorded_by from market.vendor_payments where booking_id = ${pending.id}`;
  assert.equal(payments.length, 1);
  assert.equal(Number(payments[0].amount), 4500);
  assert.equal(payments[0].payment_method, 'Credit');
  assert.equal(payments[0].recorded_by, 'org@example.com');
  const redemptions = await sql`select booking_id,amount from market.vendor_credit_redemptions where credit_id = ${credit.id}`;
  assert.equal(redemptions.length, 1);
  assert.equal(redemptions[0].booking_id, pending.id);
  assert.equal(Number(redemptions[0].amount), 4500);
  const [c] = await sql`select status,remaining_amount from market.vendor_credits where id = ${credit.id}`;
  assert.equal(c.status, 'used');
  assert.equal(Number(c.remaining_amount), 0);
  const mail = await sql`select recipient,subject from market.outbox where subject like 'Credit applied%'`;
  assert.equal(mail.length, 1);
  assert.equal(mail[0].recipient, 'susan@example.com');
});

test('organizer override: a short credit applies as partial payment and the rest stays due', async () => {
  const {sql, hampton, hilton, cats, event, booking, directCredit} = await seededDb();
  const A = await event('2027-03-06', hampton.id);
  const B = await event('2027-03-20', hilton.id);
  const source = await booking({event: A, email: 'pat@example.com', business: 'Pat Potions', category: cats.Bags});
  const credit = await directCredit({email: 'pat@example.com', category: cats.Bags, sourceEvent: A, sourceId: source.id, amount: 3000});
  const pending = await booking({event: B, email: 'pat@example.com', business: 'Pat Potions', category: cats.Bags, status: 'pending', paid: false});
  const r = await redeemForApplication(sql, {booking_id: pending.id}, ORG); // no credit_id: oldest available for the applicant's email
  assert.equal(r.applied, 3000);
  assert.equal(r.amount_due, 1500);
  assert.equal(r.remaining_credit, 0);
  assert.equal(r.status, 'approved');
  const [b] = await sql`select status,paid_at from market.bookings where id = ${pending.id}`;
  assert.equal(b.status, 'approved', 'partial settlement approves but does not mark paid');
  assert.equal(b.paid_at, null);
  const payments = await sql`select amount,payment_method from market.vendor_payments where booking_id = ${pending.id}`;
  assert.equal(payments.length, 1);
  assert.equal(Number(payments[0].amount), 3000);
  const [c] = await sql`select status,remaining_amount from market.vendor_credits where id = ${credit.id}`;
  assert.equal(c.status, 'used');
  assert.equal(Number(c.remaining_amount), 0);
});

test('redeem-for-application is organizer-only and rejects another vendor\'s credit', async () => {
  const {sql, hampton, hilton, cats, event, booking, directCredit} = await seededDb();
  const A = await event('2027-03-06', hampton.id);
  const B = await event('2027-03-20', hilton.id);
  const source = await booking({event: A, email: 'other@example.com', business: 'Other Crafts', category: cats.Bags});
  const othersCredit = await directCredit({email: 'other@example.com', category: cats.Bags, sourceEvent: A, sourceId: source.id, amount: 4500});
  const pending = await booking({event: B, email: 'susan@example.com', business: 'Susan Crafts', category: cats.Bags, status: 'pending', paid: false});
  await assert.rejects(() => redeemForApplication(sql, {booking_id: pending.id, credit_id: othersCredit.id}, {email: 'susan@example.com', admin: false}), /Organizer access only/);
  await assert.rejects(() => redeemForApplication(sql, {booking_id: pending.id, credit_id: othersCredit.id}, ORG), /different vendor/);
});

test('conflict panel: who sells what for a category-full date (counts semantics: pending excluded, twins deduped)', async () => {
  const {sql, hampton, cats, event, booking, imported} = await seededDb();
  // Candles limit is 1. Salty Luna Co holds it at B with a paid booking
  // whose application says "Sea Shell jewelry" (the owner's example), and
  // also exists as an imported twin for the same date — counted once.
  const B = await event('2027-03-20', hampton.id);
  await booking({event: B, email: 'salty@example.com', business: 'Salty Luna Co', category: cats.Candles, description: 'Sea Shell jewelry'});
  await imported({event: B, email: 'salty@example.com', business: 'Salty Luna Co', category: cats.Candles, selling: 'Sea Shell jewelry'});
  const applicant = await booking({event: B, email: 'holly@example.com', business: 'Holly Bell Designs', category: cats.Candles, status: 'pending', paid: false, description: 'Handmade beaded jewelry'});
  // A second PENDING applicant must not appear as a holder (pending does
  // not reserve) — but gets her own panel entry against Salty Luna.
  const pete = await booking({event: B, email: 'pete@example.com', business: 'Pending Pete', category: cats.Candles, status: 'pending', paid: false, description: 'Wax melts'});
  const conflicts = await applicationConflicts(sql);
  const mine = conflicts.find(x => x.booking_id === applicant.id);
  assert.ok(mine, 'pending applicant on a full category date gets a conflict panel');
  assert.equal(mine.category, 'Candles');
  assert.equal(mine.limit, 1);
  assert.equal(mine.used, 1, 'the twin records count once');
  assert.deepEqual(mine.applicant, {business: 'Holly Bell Designs', sells: 'Handmade beaded jewelry'});
  assert.deepEqual(mine.vendors, [{business: 'Salty Luna Co', sells: 'Sea Shell jewelry'}]);
  const petes = conflicts.find(x => x.booking_id === pete.id);
  assert.ok(petes, 'the second pending applicant also gets a panel');
  assert.deepEqual(petes.vendors, [{business: 'Salty Luna Co', sells: 'Sea Shell jewelry'}], 'pending applicants never list each other as holders');
});

test('conflict panel: imported holder sells text falls back selling -> profile, and limit 0 never conflicts', async () => {
  const {db, sql, hampton, cats, event, booking, imported} = await seededDb();
  const C = await event('2027-04-03', hampton.id);
  // Imported holder with an empty selling field; her profile carries the
  // products text, which is the documented fallback.
  await imported({event: C, email: 'imp@example.com', business: 'Imported Irene', category: cats.Candles, selling: ''});
  await sql`insert into market.vendor_profiles(email,business,description) values('imp@example.com','Imported Irene','Profile product line')`;
  const applicant = await booking({event: C, email: 'new@example.com', business: 'New Vendor', category: cats.Candles, status: 'pending', paid: false, description: 'Soy candles'});
  const conflicts = await applicationConflicts(sql);
  const mine = conflicts.find(x => x.booking_id === applicant.id);
  assert.ok(mine);
  assert.deepEqual(mine.vendors, [{business: 'Imported Irene', sells: 'Profile product line'}]);
  // Same shape at a limit-0 category: no cap, so no conflict even with a
  // holder present (mirrors the Holly ruling).
  await db.exec('alter table market.categories drop constraint if exists categories_vendor_limit_check');
  await sql`update market.categories set vendor_limit = 0 where id = ${cats.Bags}`;
  const D = await event('2027-04-17', hampton.id);
  await booking({event: D, email: 'bag@example.com', business: 'Bag Holder', category: cats.Bags});
  const bagApplicant = await booking({event: D, email: 'bag2@example.com', business: 'Bag Applicant', category: cats.Bags, status: 'pending', paid: false});
  const after = await applicationConflicts(sql);
  assert.equal(after.find(x => x.booking_id === bagApplicant.id), undefined, 'vendor_limit 0 means no cap and no conflict panel');
});
