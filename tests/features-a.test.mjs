import test from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {readFile} from 'node:fs/promises';
import {approveMoveRequest, cancelMoveRequest, createMoveRequest, declineMoveRequest, loadMoveSource} from '../server/moves.mjs';
import {acceptOffer, declineOffer, offerAnyway, scanWaitlist, sweepWaitlist} from '../server/waitlist.mjs';

// Same postgres.js tagged-template adapter as tests/counts.test.mjs.
function pgliteSql(db) {
  const sql = async (strings, ...values) => {
    let text = '', params = [];
    strings.forEach((s, i) => { text += s; if (i < values.length) { params.push(values[i]); text += '$' + params.length; } });
    return (await db.query(text, params)).rows;
  };
  sql.json = v => JSON.stringify(v); // core.audit()/queue() call tx.json (postgres.js)
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

test('move approve: happy path moves booking, clears old-date state, keeps payment, emails vendor', async () => {
  const {sql, cats, event, booking} = await seededDb();
  const A = await event('2027-03-06'), C = await event('2027-03-20');
  const v = await booking({event: A, email: 'v@example.com', business: 'V Crafts', category: cats.Bags, status: 'paid'});
  await sql`update market.bookings set setup_checkin_at = now(), setup_arrival_time = '08:30' where id = ${v.id}`;
  await sql`insert into market.floor_plan_areas(event_id,area_key,assignments) values(${A.id},'main',${JSON.stringify({S1: {vendor_id: v.id, x: 1, y: 1}, S2: {vendor_id: 'someone-else', x: 2, y: 2}})}::jsonb)`;
  const source = await loadMoveSource(sql, 'booking', v.id);
  const {request} = await createMoveRequest(sql, {source, targetEventId: C.id, reason: 'Family event that weekend', user: v.user});
  assert.equal(request.status, 'pending');
  const out = await approveMoveRequest(sql, {requestId: request.id, actor: ORG});
  assert.equal(out.request.status, 'approved');
  const [moved] = await sql`select * from market.bookings where id = ${v.id}`;
  assert.equal(moved.event_id, C.id);
  assert.equal(moved.status, 'paid');
  assert.equal(moved.price, 4500);
  assert.equal(moved.setup_checkin_at, null);
  assert.equal(moved.setup_arrival_time, null);
  const [plan] = await sql`select assignments from market.floor_plan_areas where event_id = ${A.id}`;
  assert.deepEqual(Object.keys(plan.assignments), ['S2']);
  const mail = await sql`select recipient,subject from market.outbox where subject like 'Date changed%'`;
  assert.equal(mail.length, 1);
  assert.equal(mail[0].recipient, 'v@example.com');
});

test('move approve: target filled meanwhile refuses with reason, request stays pending', async () => {
  const {sql, cats, event, booking} = await seededDb();
  const A = await event('2027-03-06'), B = await event('2027-03-13', 1, 1); // indoor cap 1
  const v = await booking({event: A, email: 'v@example.com', business: 'V Crafts', category: cats.Bags, status: 'approved'});
  const source = await loadMoveSource(sql, 'booking', v.id);
  const {request} = await createMoveRequest(sql, {source, targetEventId: B.id, reason: '', user: v.user});
  // Target fills after the request was made.
  await booking({event: B, email: 'filler@example.com', business: 'Filler', category: cats.Bags, status: 'approved'});
  await assert.rejects(() => approveMoveRequest(sql, {requestId: request.id, actor: ORG}), /Indoor is full/);
  const [req] = await sql`select * from market.move_requests where id = ${request.id}`;
  assert.equal(req.status, 'pending');
  const [b] = await sql`select event_id from market.bookings where id = ${v.id}`;
  assert.equal(b.event_id, A.id);
});

test('move requests: one pending per booking; cancel frees the slot; decline emails the note', async () => {
  const {sql, cats, event, booking} = await seededDb();
  const A = await event('2027-03-06'), C = await event('2027-03-20');
  const v = await booking({event: A, email: 'v@example.com', business: 'V Crafts', category: cats.Bags, status: 'approved'});
  const source = await loadMoveSource(sql, 'booking', v.id);
  const first = await createMoveRequest(sql, {source, targetEventId: C.id, reason: '', user: v.user});
  await assert.rejects(() => createMoveRequest(sql, {source, targetEventId: C.id, reason: '', user: v.user}), /already have a pending/);
  await cancelMoveRequest(sql, {requestId: first.request.id, user: v.user});
  const second = await createMoveRequest(sql, {source, targetEventId: C.id, reason: '', user: v.user});
  assert.equal(second.request.status, 'pending');
  const out = await declineMoveRequest(sql, {requestId: second.request.id, actor: ORG, note: 'That date is reserved for returning vendors.'});
  assert.equal(out.request.status, 'declined');
  assert.equal(out.request.decision_note, 'That date is reserved for returning vendors.');
  const mail = await sql`select body from market.outbox where subject like 'About your date-move request%'`;
  assert.equal(mail.length, 1);
  assert.match(mail[0].body, /reserved for returning vendors/);
});

test('move cutoff: create refused within 48h; approve refused inside 48h without override', async () => {
  const {sql, cats, event, booking} = await seededDb();
  const soon = new Date(Date.now() + 24 * 3600 * 1000).toISOString().slice(0, 10);
  const [loc2] = await sql`insert into market.locations(name,address) values('Other Hall','2 Test Way') returning id`;
  const S = await event(soon, 2, 1, loc2.id), C = await event('2027-03-20');
  const v = await booking({event: S, email: 'v@example.com', business: 'V Crafts', category: cats.Bags, status: 'approved'});
  const source = await loadMoveSource(sql, 'booking', v.id);
  await assert.rejects(() => createMoveRequest(sql, {source, targetEventId: C.id, reason: '', user: v.user}), /within 48 hours/);
  // A request made while the date was far away, decided after it comes close:
  const A = await event('2027-03-06');
  const w = await booking({event: A, email: 'w@example.com', business: 'W Crafts', category: cats.Bags, status: 'approved'});
  const wSource = await loadMoveSource(sql, 'booking', w.id);
  const {request} = await createMoveRequest(sql, {source: wSource, targetEventId: C.id, reason: '', user: w.user});
  await sql`update market.events set date = ${soon} where id = ${A.id}`;
  await assert.rejects(() => approveMoveRequest(sql, {requestId: request.id, actor: ORG}), /48 hours/);
  const out = await approveMoveRequest(sql, {requestId: request.id, actor: ORG, overrideCutoff: true});
  assert.equal(out.request.status, 'approved');
});

test('move: imported attendee moves with its category reservation', async () => {
  const {sql, cats, event, imported} = await seededDb();
  const A = await event('2027-03-06'), C = await event('2027-03-20');
  const imp = await imported({event: A, email: 'imp@example.com', business: 'Imp Crafts', category: cats.Bags});
  const user = {id: crypto.randomUUID(), email: 'imp@example.com'};
  const source = await loadMoveSource(sql, 'imported', imp.id);
  assert.equal(source.confirmed, true);
  const {request} = await createMoveRequest(sql, {source, targetEventId: C.id, reason: '', user});
  await approveMoveRequest(sql, {requestId: request.id, actor: ORG});
  const [row] = await sql`select event_id from market.imported_attendees where id = ${imp.id}`;
  assert.equal(row.event_id, C.id);
  const res = await sql`select event_id from market.imported_category_reservations where imported_attendee_id = ${imp.id}`;
  assert.deepEqual(res.map(r => r.event_id), [C.id]);
});

test('waitlist scan: category-full vendor is SKIPPED, next vendor offered; accept approves', async () => {
  const {sql, cats, event, booking} = await seededDb();
  const D = await event('2027-04-03', 3, 1); // indoor cap 3, Candles limit 1
  await booking({event: D, email: 'c1@example.com', business: 'Candle One', category: cats.Candles, status: 'approved'});
  const bags1 = await booking({event: D, email: 'b1@example.com', business: 'Bags One', category: cats.Bags, status: 'approved'});
  await booking({event: D, email: 'b2@example.com', business: 'Bags Two', category: cats.Bags, status: 'approved'});
  const w1 = await booking({event: D, email: 'w1@example.com', business: 'Candle Wait', category: cats.Candles, status: 'waitlist', waitlistedAt: new Date(Date.now() - 7200 * 1000)});
  const w2 = await booking({event: D, email: 'w2@example.com', business: 'Bags Wait', category: cats.Bags, status: 'waitlist', waitlistedAt: new Date(Date.now() - 3600 * 1000)});
  await sql`update market.bookings set status = 'cancelled' where id = ${bags1.id}`;
  const created = await scanWaitlist(sql, D.id, {});
  assert.equal(created.length, 1);
  assert.equal(created[0].booking_id, w2.id);
  const [w1row] = await sql`select waitlist_offered_at from market.bookings where id = ${w1.id}`;
  assert.equal(w1row.waitlist_offered_at, null); // skipped, keeps position
  const offers = await sql`select * from market.waitlist_offers where event_id = ${D.id}`;
  assert.equal(offers.length, 1);
  assert.equal(offers[0].offered_by, 'auto');
  const mail = await sql`select recipient,body from market.outbox where subject like 'A spot opened up%'`;
  assert.equal(mail.length, 1);
  assert.equal(mail[0].recipient, 'w2@example.com');
  assert.match(mail[0].body, /12 hours/);
  assert.match(mail[0].body, /back of the waitlist/);
  // Accept: waitlist -> approved, offer resolved.
  await acceptOffer(sql, w2.id, w2.user);
  const [w2row] = await sql`select status, waitlist_offered_at from market.bookings where id = ${w2.id}`;
  assert.equal(w2row.status, 'approved');
  assert.equal(w2row.waitlist_offered_at, null);
  const [offer] = await sql`select state from market.waitlist_offers where booking_id = ${w2.id}`;
  assert.equal(offer.state, 'accepted');
});

test('waitlist expiry: offer passes to the next vendor; expired vendor excluded from the same opening', async () => {
  const {sql, cats, event, booking} = await seededDb();
  const E = await event('2027-04-10', 1, 1);
  const filler = await booking({event: E, email: 'f@example.com', business: 'Filler', category: cats.Bags, status: 'approved'});
  const w1 = await booking({event: E, email: 'w1@example.com', business: 'First', category: cats.Bags, status: 'waitlist', waitlistedAt: new Date(Date.now() - 7200 * 1000)});
  const w2 = await booking({event: E, email: 'w2@example.com', business: 'Second', category: cats.Bags, status: 'waitlist', waitlistedAt: new Date(Date.now() - 3600 * 1000)});
  await sql`update market.bookings set status = 'cancelled' where id = ${filler.id}`;
  await scanWaitlist(sql, E.id, {});
  let [live] = await sql`select booking_id from market.waitlist_offers where event_id = ${E.id} and state = 'offered'`;
  assert.equal(live.booking_id, w1.id);
  await sql`update market.waitlist_offers set expires_at = now() - interval '1 minute' where booking_id = ${w1.id}`;
  const swept = await sweepWaitlist(sql, 'system');
  assert.equal(swept.expired, 1);
  [live] = await sql`select booking_id from market.waitlist_offers where event_id = ${E.id} and state = 'offered'`;
  assert.equal(live.booking_id, w2.id); // passed along, NOT back to w1
  const [w1row] = await sql`select waitlist_offered_at from market.bookings where id = ${w1.id}`;
  assert.equal(w1row.waitlist_offered_at, null);
  // w2 declines -> back of the queue; w1 is still excluded from THIS opening.
  await declineOffer(sql, w2.id, w2.user);
  const liveAfter = await sql`select * from market.waitlist_offers where event_id = ${E.id} and state = 'offered'`;
  assert.equal(liveAfter.length, 0);
  const [w2row] = await sql`select waitlisted_at from market.bookings where id = ${w2.id}`;
  const [w1q] = await sql`select waitlisted_at from market.bookings where id = ${w1.id}`;
  assert.ok(new Date(w2row.waitlisted_at) > new Date(w1q.waitlisted_at)); // declined = back of queue
});

test('waitlist override: Offer anyway bypasses the category skip and writes the audit entry', async () => {
  const {sql, cats, event, booking} = await seededDb();
  const F = await event('2027-04-17', 2, 1); // indoor cap 2, Candles limit 1
  await booking({event: F, email: 'c1@example.com', business: 'Candle One', category: cats.Candles, status: 'approved'});
  const w1 = await booking({event: F, email: 'w1@example.com', business: 'Candle Wait', category: cats.Candles, status: 'waitlist', waitlistedAt: new Date()});
  const created = await scanWaitlist(sql, F.id, {});
  assert.equal(created.length, 0); // auto scan skips: Candles 1/1 full
  const offer = await offerAnyway(sql, w1.id, ORG);
  assert.equal(offer.offered_by, 'organizer');
  assert.equal(offer.override, true);
  const [row] = await sql`select waitlist_offered_at from market.bookings where id = ${w1.id}`;
  assert.ok(row.waitlist_offered_at);
  const [entry] = await sql`select detail from market.audit where action = 'waitlist offer override'`;
  assert.ok(entry);
  assert.equal(Number(entry.detail.category_used), 1);
  assert.equal(Number(entry.detail.category_limit), 1);
  // And with no free spot at all, the override refuses.
  const G = await event('2027-04-24', 1, 1);
  await booking({event: G, email: 'g@example.com', business: 'Filler', category: cats.Bags, status: 'approved'});
  const w2 = await booking({event: G, email: 'w2@example.com', business: 'Bags Wait', category: cats.Bags, status: 'waitlist', waitlistedAt: new Date()});
  await assert.rejects(() => offerAnyway(sql, w2.id, ORG), /no open indoor spot/);
});
