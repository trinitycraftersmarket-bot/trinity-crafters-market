import test from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {readFile} from 'node:fs/promises';
import {adminSources, sourceRecord, eligibleEvents, issueCredit, redeemCredit} from '../netlify/functions/vendor-credit.mjs';

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
  async function booking({event: ev, email, business, category, status = 'paid', paid = true}) {
    const userId = crypto.randomUUID();
    const [app] = await sql`insert into market.applications(user_id,name,email,phone,business,description,category_id,photos,agreements) values(${userId},'Vendor',${email},'7275550100',${business},'Goods',${category},'{}','{}') returning id`;
    const [b] = await sql`insert into market.bookings(application_id,event_id,space,price,status) values(${app.id},${ev.id},'indoor',4500,${status}) returning *`;
    if (paid) await sql`update market.bookings set paid_at = now() where id = ${b.id}`;
    return {...b, user: {id: userId, email}};
  }
  async function imported({event: ev, email, business, category, paymentStatus = 'paid', paid = true}) {
    const [i] = await sql`insert into market.imported_attendees(event_id,name,business,email,phone,category_id,space,invoice_amount,payment_status) values(${ev.id},'Vendor',${business},${email},'7275550100',${category},'indoor',4500,${paymentStatus}) returning *`;
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
  return {db, sql, hampton, hilton, cats, event, booking, imported, cancelBooking, cancelImported};
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
