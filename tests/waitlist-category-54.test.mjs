// §54: waitlist offers respect per-date category caps through ONE shared
// rule (server/counts.mjs categoryFull + effectiveCategoryLimits), used by
// both the offer scan (server/waitlist.mjs scanWaitlist) and the accept
// re-check (acceptOffer -> counts.assertCapacity). Regression guard for
// the Rosalind case: a vendor at the head of the queue whose category is
// full must not be offered a spot her category would refuse at accept
// time — no offer row, no email, no 12-hour window burned — and she keeps
// her exact queue position for the next opening in her category.
import test from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {readFile} from 'node:fs/promises';
import {categoryFull, effectiveCategoryLimits, publicCounts, categoryCountRows} from '../server/counts.mjs';
import {acceptOffer, offerAnyway, scanWaitlist} from '../server/waitlist.mjs';

// Same postgres.js tagged-template adapter as tests/features-a.test.mjs.
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
  const [loc] = await sql`insert into market.locations(name,address,indoor_capacity,outdoor_capacity,indoor_price,outdoor_price) values('Test Hall','1 Test Way',3,1,4500,3500) returning id`;
  await sql`update market.categories set vendor_limit = 10 where name = 'Bags'`;
  await sql`update market.categories set vendor_limit = 1 where name = 'Candles'`;
  const cats = {};
  for (const row of await sql`select id,name from market.categories where name in ('Bags','Candles')`) cats[row.name] = row.id;
  async function event(date, indoor = 3, outdoor = 1) {
    const [e] = await sql`insert into market.events(location_id,date,indoor_capacity,outdoor_capacity,indoor_price,outdoor_price) values(${loc.id},${date},${indoor},${outdoor},4500,3500) returning *`;
    return e;
  }
  async function booking({event: ev, email, business, category, status, space = 'indoor', waitlistedAt = null}) {
    const userId = crypto.randomUUID();
    const [app] = await sql`insert into market.applications(user_id,name,email,phone,business,description,category_id,photos,agreements) values(${userId},'Vendor',${email},'7275550100',${business},'Goods',${category},'{}','{}') returning id`;
    const [b] = await sql`insert into market.bookings(application_id,event_id,space,price,status,waitlisted_at) values(${app.id},${ev.id},${space},4500,${status},${waitlistedAt}) returning *`;
    return {...b, user: {id: userId, email}};
  }
  return {db, sql, loc, cats, event, booking};
}

const HOUR = 3600 * 1000;

test('§54 predicate: categoryFull cap semantics (0/null = no cap, exception bypasses, used >= limit is full)', () => {
  assert.equal(categoryFull(0, null), false);
  assert.equal(categoryFull(9, null), false);
  assert.equal(categoryFull(0, 0), false);
  assert.equal(categoryFull(9, 0), false); // limit 0 = NO cap, never full
  assert.equal(categoryFull(0, 1), false);
  assert.equal(categoryFull(1, 1), true);
  assert.equal(categoryFull(2, 1), true);
  assert.equal(categoryFull(1, 1, true), false); // category exception
  assert.equal(categoryFull(0, 2), false);
  assert.equal(categoryFull(2, 2), true);
});

test('§54 Rosalind regression: category-full queue head is skipped (no offer, no email, position kept); next eligible vendor offered; same-category opening re-offers her first and she can accept', async () => {
  const {sql, cats, event, booking} = await seededDb();
  const D = await event('2027-05-01', 3, 1); // indoor cap 3; Candles cap 1
  const candleActive = await booking({event: D, email: 'c1@example.com', business: 'Candle One', category: cats.Candles, status: 'approved'});
  const bagsA = await booking({event: D, email: 'ba@example.com', business: 'Bags A', category: cats.Bags, status: 'approved'});
  await booking({event: D, email: 'bb@example.com', business: 'Bags B', category: cats.Bags, status: 'approved'});
  // Rosalind: head of the queue, but her category (Candles) is full at 1/1.
  const headAt = new Date(Date.now() - 2 * HOUR);
  const head = await booking({event: D, email: 'head@example.com', business: 'Candle Wait', category: cats.Candles, status: 'waitlist', waitlistedAt: headAt});
  const next = await booking({event: D, email: 'next@example.com', business: 'Bags Wait', category: cats.Bags, status: 'waitlist', waitlistedAt: new Date(Date.now() - HOUR)});

  // A Bags booth opens. The scan must skip the category-full head entirely.
  await sql`update market.bookings set status = 'cancelled' where id = ${bagsA.id}`;
  const created = await scanWaitlist(sql, D.id, {});
  assert.equal(created.length, 1);
  assert.equal(created[0].booking_id, next.id);
  const headOffers = await sql`select * from market.waitlist_offers where booking_id = ${head.id}`;
  assert.equal(headOffers.length, 0); // no offer row — no window burned
  const [headRow] = await sql`select waitlist_offered_at, waitlisted_at from market.bookings where id = ${head.id}`;
  assert.equal(headRow.waitlist_offered_at, null);
  assert.equal(new Date(headRow.waitlisted_at).getTime(), headAt.getTime()); // exact queue position kept
  const mail = await sql`select recipient from market.outbox where subject like 'A spot opened up%'`;
  assert.deepEqual(mail.map(m => m.recipient), ['next@example.com']); // no email to the skipped vendor

  // A booth in HER category frees: she is reached first, per queue order.
  await sql`update market.bookings set status = 'cancelled' where id = ${candleActive.id}`;
  const created2 = await scanWaitlist(sql, D.id, {});
  assert.equal(created2.length, 1);
  assert.equal(created2[0].booking_id, head.id);
  // And the shared rule now lets her accept (same predicate, room again).
  await acceptOffer(sql, head.id, head.user);
  const [headAfter] = await sql`select status from market.bookings where id = ${head.id}`;
  assert.equal(headAfter.status, 'approved');
});

test('§54 parity: the state that makes the scan skip a vendor is the state that refuses her accept (shared rule, both directions)', async () => {
  const {sql, cats, event, booking} = await seededDb();
  const D = await event('2027-05-08', 4, 1); // indoor cap 4; Candles cap 1
  const w1 = await booking({event: D, email: 'w1@example.com', business: 'Candle Wait 1', category: cats.Candles, status: 'waitlist', waitlistedAt: new Date(Date.now() - 2 * HOUR)});
  const w2 = await booking({event: D, email: 'w2@example.com', business: 'Candle Wait 2', category: cats.Candles, status: 'waitlist', waitlistedAt: new Date(Date.now() - HOUR)});
  // Organizer override gives w1 a live offer while the category still has room.
  await offerAnyway(sql, w1.id, {email: 'org@example.com'});
  // The category then fills (a Candles vendor is approved directly).
  await booking({event: D, email: 'c1@example.com', business: 'Candle One', category: cats.Candles, status: 'approved'});
  const filler = await booking({event: D, email: 'f1@example.com', business: 'Bags Fill', category: cats.Bags, status: 'approved'});
  await booking({event: D, email: 'f2@example.com', business: 'Bags Fill 2', category: cats.Bags, status: 'approved'});

  // Accept side: the re-check refuses — her category is full.
  await assert.rejects(() => acceptOffer(sql, w1.id, w1.user), /Category is full/);

  // Scan side: a booth opens; w2 (same full category) is NOT offered.
  await sql`update market.bookings set status = 'cancelled' where id = ${filler.id}`;
  const created = await scanWaitlist(sql, D.id, {});
  assert.equal(created.length, 0);
  const w2Offers = await sql`select * from market.waitlist_offers where booking_id = ${w2.id}`;
  assert.equal(w2Offers.length, 0);
});

test('§54 flag data: the counts payload behind the organizer "Category full" flag reports the capped category as full', async () => {
  const {sql, cats, event, booking} = await seededDb();
  const D = await event('2027-05-15', 3, 1);
  await booking({event: D, email: 'c1@example.com', business: 'Candle One', category: cats.Candles, status: 'approved'});
  await booking({event: D, email: 'head@example.com', business: 'Candle Wait', category: cats.Candles, status: 'waitlist', waitlistedAt: new Date()});
  // Exactly the data core.publicData ships to the admin payload
  // (counts + category limits) that public/v2/js/waitlist.js reads.
  const allCategories = await sql`select * from market.categories`;
  const categoryLimits = await sql`select * from market.event_category_limits`;
  const rows = categoryCountRows(await publicCounts(sql), allCategories, categoryLimits);
  const row = rows.find(r => String(r.event_id) === String(D.id) && String(r.category_id) === String(cats.Candles));
  assert.ok(row, 'a counts row exists for the capped category');
  assert.equal(Number(row.used), 1);
  assert.equal(Number(row.vendor_limit), 1);
  assert.equal(categoryFull(row.used, row.vendor_limit), true); // the flag condition
  // Effective-limit resolution agrees: event override ?? category default.
  const limits = await effectiveCategoryLimits(sql, D.id);
  assert.equal(Number(limits.get(String(cats.Candles))), 1);
  assert.equal(Number(limits.get(String(cats.Bags))), 10);
});
