import test from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {readFile} from 'node:fs/promises';
import {createMoveRequest, loadMoveSource, movableSources, organizerMove, organizerMoveTargets} from '../server/moves.mjs';

// Same postgres.js tagged-template adapter + seed helpers as
// tests/features-a.test.mjs.
function pgliteSql(db) {
  const sql = async (strings, ...values) => {
    let text = '', params = [];
    strings.forEach((s, i) => { text += s; if (i < values.length) { params.push(values[i]); text += '$' + params.length; } });
    return (await db.query(text, params)).rows;
  };
  sql.json = v => JSON.stringify(v);
  return sql;
}

async function seededDb() {
  const db = new PGlite();
  await db.exec('create role anon; create role authenticated; create schema storage; create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);');
  await db.exec(await readFile('database/setup.sql', 'utf8'));
  await db.exec(await readFile('database/codify-live-schema.sql', 'utf8'));
  await db.exec(await readFile('database/move-requests.sql', 'utf8'));
  await db.exec(await readFile('database/waitlist-offers.sql', 'utf8'));
  const sql = pgliteSql(db);
  const [loc] = await sql`insert into market.locations(name,address,indoor_capacity,outdoor_capacity,indoor_price,outdoor_price) values('Test Hall','1 Test Way',2,1,4500,3500) returning id`;
  await sql`update market.categories set vendor_limit = 10 where name = 'Bags'`;
  await sql`update market.categories set vendor_limit = 1 where name = 'Candles'`;
  const cats = {};
  for (const row of await sql`select id,name from market.categories where name in ('Bags','Candles')`) cats[row.name] = row.id;
  async function event(date, indoor = 2, outdoor = 1, locationId = null) {
    const [e] = await sql`insert into market.events(location_id,date,indoor_capacity,outdoor_capacity,indoor_price,outdoor_price) values(${locationId || loc.id},${date},${indoor},${outdoor},4500,3500) returning *`;
    return e;
  }
  async function booking({event: ev, email, business, category, status, space = 'indoor', waitlistedAt = null}) {
    const userId = crypto.randomUUID();
    const [app] = await sql`insert into market.applications(user_id,name,email,phone,business,description,category_id,photos,agreements) values(${userId},'Vendor',${email},'7275550100',${business},'Goods',${category},'{}','{}') returning id`;
    const [b] = await sql`insert into market.bookings(application_id,event_id,space,price,status,waitlisted_at) values(${app.id},${ev.id},${space},4500,${status},${waitlistedAt}) returning *`;
    return {...b, user: {id: userId, email}};
  }
  async function imported({event: ev, email, business, category, space = 'indoor'}) {
    const [i] = await sql`insert into market.imported_attendees(event_id,name,business,email,phone,category_id,space,invoice_amount,payment_status) values(${ev.id},'Vendor',${business},${email},'7275550100',${category},${space},4500,'paid') returning *`;
    await sql`insert into market.imported_category_reservations(imported_attendee_id,event_id,category_id,space) values(${i.id},${ev.id},${category},'indoor')`;
    return i;
  }
  return {db, sql, loc, cats, event, booking, imported};
}

const ORG = {email: 'org@example.com'};

test('organizer move: booking moves immediately, payment untouched, vendor emailed, audit marked organizer-initiated', async () => {
  const {sql, cats, event, booking} = await seededDb();
  const A = await event('2027-03-06'), C = await event('2027-03-20');
  const v = await booking({event: A, email: 'v@example.com', business: 'V Crafts', category: cats.Bags, status: 'paid'});
  await sql`insert into market.vendor_payments(booking_id,amount,payment_method) values(${v.id},4500,'card')`;
  await sql`update market.bookings set setup_checkin_at = now() where id = ${v.id}`;
  const out = await organizerMove(sql, {sourceType: 'booking', sourceId: v.id, targetEventId: C.id, actor: ORG});
  assert.equal(out.space, 'indoor');
  assert.equal(out.request, null);
  const [moved] = await sql`select * from market.bookings where id = ${v.id}`;
  assert.equal(moved.event_id, C.id);
  assert.equal(moved.status, 'paid');
  assert.equal(moved.price, 4500);
  assert.equal(moved.setup_checkin_at, null);
  const [pay] = await sql`select amount from market.vendor_payments where booking_id = ${v.id}`;
  assert.equal(pay.amount, 4500);
  const mail = await sql`select recipient,subject,body from market.outbox where subject like 'Date changed%'`;
  assert.equal(mail.length, 1);
  assert.equal(mail[0].recipient, 'v@example.com');
  assert.match(mail[0].body, /We moved your booking to a new date/);
  assert.match(mail[0].body, /Test Hall/);
  const [entry] = await sql`select detail from market.audit where action = 'booking date moved (organizer)'`;
  assert.ok(entry);
  assert.equal(entry.detail.organizer_initiated, true);
});

test('organizer move: refusals carry the approval path reasons (not confirmed, full, category full, past)', async () => {
  const {sql, cats, event, booking} = await seededDb();
  const A = await event('2027-03-06');
  const held = await booking({event: A, email: 'h@example.com', business: 'Held', category: cats.Bags, status: 'held'});
  const C = await event('2027-03-20');
  await assert.rejects(() => organizerMove(sql, {sourceType: 'booking', sourceId: held.id, targetEventId: C.id, actor: ORG}), /not confirmed \(status: held\)/);
  // Indoor full on the target (cap 1, already taken).
  const B = await event('2027-03-13', 1, 1);
  await booking({event: B, email: 'f@example.com', business: 'Filler', category: cats.Bags, status: 'approved'});
  const v = await booking({event: A, email: 'v@example.com', business: 'V Crafts', category: cats.Bags, status: 'approved'});
  await assert.rejects(() => organizerMove(sql, {sourceType: 'booking', sourceId: v.id, targetEventId: B.id, actor: ORG}), /Cannot move: Indoor is full for that date/);
  // Category full (Candles limit 1) while the space itself has room.
  const D = await event('2027-03-27', 2, 1);
  await booking({event: D, email: 'c1@example.com', business: 'Candle One', category: cats.Candles, status: 'approved'});
  const candle = await booking({event: A, email: 'c2@example.com', business: 'Candle Two', category: cats.Candles, status: 'approved'});
  await assert.rejects(() => organizerMove(sql, {sourceType: 'booking', sourceId: candle.id, targetEventId: D.id, actor: ORG}), /Cannot move: Your category is full for that date/);
  // Past target date.
  const P = await event('2026-01-10');
  await assert.rejects(() => organizerMove(sql, {sourceType: 'booking', sourceId: v.id, targetEventId: P.id, actor: ORG}), /Cannot move: That date has already ended/);
  // None of the refused moves changed anything.
  const [row] = await sql`select event_id from market.bookings where id = ${v.id}`;
  assert.equal(row.event_id, A.id);
});

test('organizer move: no 48-hour cutoff for the organizer', async () => {
  const {sql, cats, event, booking} = await seededDb();
  const soon = new Date(Date.now() + 24 * 3600 * 1000).toISOString().slice(0, 10);
  const S = await event(soon), C = await event('2027-03-20');
  const v = await booking({event: S, email: 'v@example.com', business: 'V Crafts', category: cats.Bags, status: 'approved'});
  const out = await organizerMove(sql, {sourceType: 'booking', sourceId: v.id, targetEventId: C.id, actor: ORG});
  assert.equal(out.to.id, C.id);
});

test('organizer move: space override switches the stored space (booking + imported formats)', async () => {
  const {sql, cats, event, booking, imported} = await seededDb();
  const A = await event('2027-03-06'), C = await event('2027-03-20');
  const v = await booking({event: A, email: 'v@example.com', business: 'V Crafts', category: cats.Bags, status: 'paid', space: 'indoor'});
  await organizerMove(sql, {sourceType: 'booking', sourceId: v.id, targetEventId: C.id, space: 'outdoor', actor: ORG});
  const [b] = await sql`select event_id, space from market.bookings where id = ${v.id}`;
  assert.equal(b.event_id, C.id);
  assert.equal(b.space, 'outdoor');
  const D = await event('2027-03-27'); // C's single outdoor spot is now taken by the booking above
  const imp = await imported({event: A, email: 'imp@example.com', business: 'Imp Crafts', category: cats.Bags, space: 'indoor'});
  await organizerMove(sql, {sourceType: 'imported', sourceId: imp.id, targetEventId: D.id, space: 'outdoor', actor: ORG});
  const [row] = await sql`select event_id, space from market.imported_attendees where id = ${imp.id}`;
  assert.equal(row.event_id, D.id);
  assert.equal(row.space, 'Outside'); // imported rows store the twins format
  const res = await sql`select event_id, space from market.imported_category_reservations where imported_attendee_id = ${imp.id}`;
  assert.deepEqual(res.map(r => [r.event_id, r.space]), [[D.id, 'outdoor']]);
});

test('organizer move: a pending vendor request is resolved as approved', async () => {
  const {sql, cats, event, booking} = await seededDb();
  const A = await event('2027-03-06'), X = await event('2027-03-13'), C = await event('2027-03-20');
  const v = await booking({event: A, email: 'v@example.com', business: 'V Crafts', category: cats.Bags, status: 'approved'});
  const source = await loadMoveSource(sql, 'booking', v.id);
  const {request} = await createMoveRequest(sql, {source, targetEventId: X.id, reason: '', user: v.user});
  const out = await organizerMove(sql, {sourceType: 'booking', sourceId: v.id, targetEventId: C.id, actor: ORG});
  assert.equal(out.request.id, request.id);
  assert.equal(out.request.status, 'approved');
  assert.equal(out.request.decided_by, ORG.email);
  assert.match(out.request.decision_note, /Superseded/);
  const [b] = await sql`select event_id from market.bookings where id = ${v.id}`;
  assert.equal(b.event_id, C.id);
});

test('organizer move targets: a date full for the current space is offered with the other space', async () => {
  const {sql, cats, event, booking} = await seededDb();
  const A = await event('2027-03-06');
  const B = await event('2027-03-13', 1, 1); // indoor cap 1
  await booking({event: B, email: 'f@example.com', business: 'Filler', category: cats.Bags, status: 'approved'});
  const C = await event('2027-03-20', 2, 1);
  const D = await event('2027-03-27', 0, 0); // no space at all
  const v = await booking({event: A, email: 'v@example.com', business: 'V Crafts', category: cats.Bags, status: 'approved'});
  const source = await loadMoveSource(sql, 'booking', v.id);
  const {targets, excluded} = await organizerMoveTargets(sql, source);
  const bT = targets.find(t => t.event.id === B.id);
  assert.ok(bT, 'date full indoors is still a target via outdoor');
  assert.deepEqual(bT.spaces.map(s => s.space), ['outdoor']);
  const cT = targets.find(t => t.event.id === C.id);
  assert.deepEqual(cT.spaces.map(s => s.space), ['indoor', 'outdoor']);
  const dX = excluded.find(t => t.event.id === D.id);
  assert.ok(dX, 'date with no space at all is excluded');
  assert.match(dX.problems[0], /Indoor is full/);
});

test('movableSources: only confirmed records on upcoming dates', async () => {
  const {sql, cats, event, booking, imported} = await seededDb();
  const A = await event('2027-03-06');
  const paid = await booking({event: A, email: 'p@example.com', business: 'Paid', category: cats.Bags, status: 'paid'});
  await booking({event: A, email: 'h@example.com', business: 'Held', category: cats.Bags, status: 'held'});
  const imp = await imported({event: A, email: 'imp@example.com', business: 'Imp', category: cats.Bags});
  const gone = await imported({event: A, email: 'gone@example.com', business: 'Gone', category: cats.Bags});
  await sql`update market.imported_attendees set cancelled = true where id = ${gone.id}`;
  const keys = (await movableSources(sql, A.id)).map(s => `${s.source_type}:${s.source_id}`);
  assert.deepEqual(keys.sort(), [`booking:${paid.id}`, `imported:${imp.id}`].sort());
  const P = await event('2026-01-10');
  await booking({event: P, email: 'old@example.com', business: 'Old', category: cats.Bags, status: 'paid'});
  assert.deepEqual(await movableSources(sql, P.id), []);
});
