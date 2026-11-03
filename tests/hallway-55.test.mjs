// §55 — Hallway spaces (Nov 3, 2026). Scott: "I have hallway space
// open, add 2 hallway spaces to every date" (Hampton Inn only —
// "Hilton is definitely full"), $45 each.
//
// Hallway is a third bookable space modeled exactly like indoor /
// outdoor: hallway_capacity + hallway_price live as DATA on locations
// and events (+ hallway_open on events). These tests pin: the Hampton
// seed/backfill (2 / $45, upcoming dates only) and Hilton untouched;
// the space CHECK admitting 'hallway'; counts + capacity for hallway;
// the §50 regular mechanism applied as-is (a Hampton regular's hallway
// booking prices at the $40 regular indoor rate); the apply fallback
// rule (Indoor-full ONLY routes into the hallway); and the waitlist
// scan offering hallway spots — with the §54 category cap binding the
// hallway pass exactly like the others (the Morenita pair: a Drinks
// vendor is offerable a hallway spot when Drinks is not capped, and
// is NOT when Drinks is already 1/1).
import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureHallway, hallwayFallbackSpace, HALLWAY_CAPACITY, HALLWAY_PRICE } from '../server/hallway.mjs';
import { assertCapacity, eventInventory, normalizeSpace, publicCounts } from '../server/counts.mjs';
import { ensureLocationRegularPrice, regularAwarePrice } from '../server/pricing.mjs';
import { acceptOffer, scanWaitlist } from '../server/waitlist.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = p => readFileSync(join(root, p), 'utf8');
const SETUP = read('database/setup.sql');
const CODIFY = read('database/codify-live-schema.sql');
const HALLWAY = read('server/hallway.mjs');
const API = read('netlify/functions/api.mjs');
const COUNTS = read('server/counts.mjs');
const VENDOR = read('public/v2/js/vendor.js');
const SETUPJS = read('public/v2/js/setup.js');
const FLOORPLAN = read('public/v2/js/floorplan.js');

// ---------------------------------------------------------------- static pins
test('§55: hallway capacity/price is schema data on locations and events, codified', () => {
  assert.ok(SETUP.includes('hallway_capacity int not null default 0'), 'setup.sql locations hallway_capacity');
  assert.ok(SETUP.includes('hallway_open boolean not null default true'), 'setup.sql events hallway_open');
  assert.ok(SETUP.includes("check(space in ('indoor','outdoor','hallway'))"), 'setup.sql bookings space check admits hallway');
  assert.ok(CODIFY.includes('alter table market.events add column if not exists hallway_capacity'), 'codify adds event hallway_capacity');
  assert.ok(CODIFY.includes("check (space in ('indoor', 'outdoor', 'hallway'))"), 'codify widens the bookings space check');
  assert.ok(CODIFY.includes("like '%hampton%'") && CODIFY.includes('hallway_capacity = 2'), 'codify Hampton seed is 2 spaces');
  const section55 = CODIFY.slice(CODIFY.indexOf('-- 55.'), CODIFY.indexOf('-- 14. Notes'));
  assert.ok(section55.split(';').every(chunk => !(/update/i.test(chunk) && /hilton/i.test(chunk))), 'no §55 update statement touches Hilton');
});

test('§55: the heal + fallback live in server/hallway.mjs and the apply flow uses them', () => {
  assert.ok(HALLWAY.includes('export async function ensureHallway'), 'ensureHallway exists');
  assert.ok(HALLWAY.includes('export function hallwayFallbackSpace'), 'the fallback rule is a pure exported function');
  assert.ok(HALLWAY.includes("hallway_schema_v1"), 'the one-time work is watermarked');
  assert.equal(HALLWAY_CAPACITY, 2, "Scott's 2 hallway spaces");
  assert.equal(HALLWAY_PRICE, 4500, "Scott's $45 hallway price");
  assert.ok(API.includes('hallwayFallbackSpace({'), 'apply routes Indoor-full bookings through the fallback rule');
  assert.ok(API.includes("!['indoor','outdoor','hallway'].includes(d.space)"), 'apply accepts hallway as a chosen space');
  assert.ok(COUNTS.includes("if(s==='hallway')return 'hallway';"), 'counts normalizeSpace knows hallway');
  assert.ok(VENDOR.includes("'indoor', 'outdoor', 'hallway'"), 'the vendor apply sheet offers hallway when a date has it');
  assert.ok(SETUPJS.includes('name="hallway_capacity"'), 'Setup carries hallway capacity/price fields');
  assert.ok(FLOORPLAN.includes('Your booth is in the Hallway'), 'the vendor floor plan degrades gracefully for hallway booths (no invented position)');
});

// ------------------------------------------------------- fallback rule (unit)
test('§55: the apply fallback fires only when Indoor-full is the sole blocker', () => {
  const ev = { hallway_capacity: 2, hallway_open: true };
  const base = { space: 'indoor', soldOut: false, areaClosed: false, categoryFull: false, spaceFull: true, event: ev, hallwayUsed: 0 };
  assert.equal(hallwayFallbackSpace(base), 'hallway', 'indoor full + hallway free -> hallway');
  assert.equal(hallwayFallbackSpace({ ...base, categoryFull: true }), null, 'a full category never routes into the hallway (§54)');
  assert.equal(hallwayFallbackSpace({ ...base, soldOut: true }), null, 'a sold-out market never routes into the hallway');
  assert.equal(hallwayFallbackSpace({ ...base, areaClosed: true }), null, 'a closed indoor area never routes into the hallway');
  assert.equal(hallwayFallbackSpace({ ...base, spaceFull: false }), null, 'no fallback when indoor is not full');
  assert.equal(hallwayFallbackSpace({ ...base, space: 'outdoor' }), null, 'outdoor choices never fall back');
  assert.equal(hallwayFallbackSpace({ ...base, hallwayUsed: 2 }), null, 'no fallback into a full hallway');
  assert.equal(hallwayFallbackSpace({ ...base, event: { hallway_capacity: 2, hallway_open: false } }), null, 'no fallback into a closed hallway');
  assert.equal(hallwayFallbackSpace({ ...base, event: { hallway_capacity: 0, hallway_open: true } }), null, 'no fallback where the date has no hallway (Hilton)');
});

// ---------------------------------------------------------------- PGlite rig
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
  await db.exec(SETUP);
  await db.exec(CODIFY);
  await db.exec(await readFile(join(root, 'database/move-requests.sql'), 'utf8'));
  await db.exec(await readFile(join(root, 'database/waitlist-offers.sql'), 'utf8'));
  const sql = pgliteSql(db);
  await sql`insert into market.categories(name, vendor_limit) values('Drinks (Non-alcoholic)', 1) on conflict(name) do nothing`;
  await sql`update market.categories set vendor_limit = 10 where name = 'Bags'`;
  const cats = {};
  for (const row of await sql`select id,name from market.categories where name in ('Bags','Drinks (Non-alcoholic)')`) cats[row.name] = row.id;
  return { db, sql, cats };
}

async function location(sql, name, extra = {}) {
  const [l] = await sql`insert into market.locations(name,address,indoor_capacity,outdoor_capacity,indoor_price,outdoor_price)
    values(${name},'1 Test Way',${extra.indoor ?? 9},${extra.outdoor ?? 3},${extra.indoorPrice ?? 4500},${extra.outdoorPrice ?? 3000}) returning *`;
  return l;
}
async function event(sql, locId, date, caps = {}) {
  const [e] = await sql`insert into market.events(location_id,date,indoor_capacity,outdoor_capacity,indoor_price,outdoor_price,hallway_capacity,hallway_price)
    values(${locId},${date},${caps.indoor ?? 9},${caps.outdoor ?? 3},4500,3000,${caps.hallway ?? 0},${caps.hallwayPrice ?? 4500}) returning *`;
  return e;
}
async function booking(sql, { ev, email, business, category, status, space = 'indoor', price = 4500, waitlistedAt = null }) {
  const userId = crypto.randomUUID();
  const [app] = await sql`insert into market.applications(user_id,name,email,phone,business,description,category_id,photos,agreements) values(${userId},'Vendor',${email},'7275550100',${business},'Goods',${category},'{}','{}') returning id`;
  const [b] = await sql`insert into market.bookings(application_id,event_id,space,price,status,waitlisted_at) values(${app.id},${ev.id},${space},${price},${status},${waitlistedAt}) returning *`;
  return { ...b, application_id: app.id, user: { id: userId, email } };
}

// ------------------------------------------------------------- seed / backfill
test('§55: ensureHallway seeds Hampton (2 / $45, upcoming only) and never touches Hilton', async () => {
  const { sql } = await seededDb();
  const hampton = await location(sql, 'Hampton Inn Odessa Trinity');
  const hilton = await location(sql, 'Hilton Garden Inn Suncoast');
  const hFuture = await event(sql, hampton.id, '2027-06-05');
  const hPast = await event(sql, hampton.id, '2020-01-04');
  const lFuture = await event(sql, hilton.id, '2027-06-05');
  await ensureHallway(sql);
  const [hl] = await sql`select hallway_capacity, hallway_price from market.locations where id = ${hampton.id}`;
  assert.deepEqual([hl.hallway_capacity, hl.hallway_price], [2, 4500], 'Hampton location seeded 2 / $45');
  const [hf] = await sql`select hallway_capacity, hallway_price from market.events where id = ${hFuture.id}`;
  assert.deepEqual([hf.hallway_capacity, hf.hallway_price], [2, 4500], 'upcoming Hampton date backfilled 2 / $45');
  const [hp] = await sql`select hallway_capacity from market.events where id = ${hPast.id}`;
  assert.equal(hp.hallway_capacity, 0, 'past Hampton dates are not backfilled');
  const [ll] = await sql`select hallway_capacity from market.locations where id = ${hilton.id}`;
  assert.equal(ll.hallway_capacity, 0, 'Hilton location untouched');
  const [lf] = await sql`select hallway_capacity from market.events where id = ${lFuture.id}`;
  assert.equal(lf.hallway_capacity, 0, 'Hilton dates untouched — Hilton is full');
});

test('§55: the bookings space check admits hallway after the heal (live-DB widening)', async () => {
  const { sql, cats } = await seededDb();
  const loc = await location(sql, 'Test Hall');
  const ev = await event(sql, loc.id, '2027-06-05', { hallway: 2 });
  // Simulate the pre-§55 live DB: narrow check + no watermark.
  await sql`alter table market.bookings drop constraint bookings_space_check`;
  await sql`alter table market.bookings add constraint bookings_space_check check (space in ('indoor','outdoor'))`;
  await sql`delete from market.settings where key = 'hallway_schema_v1'`;
  await assert.rejects(
    () => booking(sql, { ev, email: 'h1@test.co', business: 'Hallway One', category: cats.Bags, status: 'approved', space: 'hallway' }),
    /check constraint/i, 'a hallway booking is refused before the heal');
  await ensureHallway(sql);
  const b = await booking(sql, { ev, email: 'h1@test.co', business: 'Hallway One', category: cats.Bags, status: 'approved', space: 'hallway' });
  assert.equal(b.space, 'hallway', 'a hallway booking is stored after the heal');
});

// ------------------------------------------------------------- counts / prices
test('§55: counts own hallway — inventory, public counts, and the capacity guard', async () => {
  const { sql, cats } = await seededDb();
  const loc = await location(sql, 'Test Hall');
  const ev = await event(sql, loc.id, '2027-06-05', { hallway: 1 });
  await booking(sql, { ev, email: 'h1@test.co', business: 'Hallway One', category: cats.Bags, status: 'approved', space: 'hallway' });
  const inv = await eventInventory(sql, ev.id);
  assert.equal(inv.hallway, 1, 'eventInventory counts hallway bookings');
  const pub = await publicCounts(sql);
  assert.equal(pub.spaces.get(String(ev.id))?.hallway, 1, 'publicCounts reports hallway used per event');
  assert.equal(normalizeSpace('Hallway'), 'hallway');
  await assert.rejects(
    () => assertCapacity(sql, ev, { space: 'hallway', categoryId: cats.Bags, limit: 10 }),
    /This space is sold out\./, 'a full hallway refuses like any other space');
});

test('§55: regular pricing follows the §50 mechanism as-is for hallway', async () => {
  const { sql } = await seededDb();
  const hampton = await location(sql, 'Hampton Inn Odessa Trinity');
  await ensureLocationRegularPrice(sql); // the §50 lazy heal, as production runs it
  // §50 seed: Hampton's regular indoor rate is $40.
  const [hl] = await sql`select regular_indoor_price from market.locations where id = ${hampton.id}`;
  assert.equal(hl.regular_indoor_price, 4000, 'precondition: Hampton regular rate is $40');
  const regular = await regularAwarePrice(sql, { locationId: hampton.id, space: 'hallway', indoorPrice: 4500, outdoorPrice: 3000, hallwayPrice: 4500, regular: true });
  assert.equal(regular, 4000, "a Hampton regular's hallway booking prices at the $40 regular rate (mechanism as-is)");
  const standard = await regularAwarePrice(sql, { locationId: hampton.id, space: 'hallway', indoorPrice: 4500, outdoorPrice: 3000, hallwayPrice: 5000, regular: false });
  assert.equal(standard, 5000, "a non-regular pays the event's own hallway price (not the indoor price)");
});

// ------------------------------------------------------------- waitlist offers
test('§55: the scan offers an open hallway spot to an indoor-waitlisted vendor whose category is NOT capped (Morenita, uncapped)', async () => {
  const { sql, cats } = await seededDb();
  const hampton = await location(sql, 'Hampton Inn Odessa Trinity', { indoor: 1, outdoor: 1 });
  const ev = await event(sql, hampton.id, '2027-06-05', { indoor: 1, outdoor: 1, hallway: 1 });
  await booking(sql, { ev, email: 'a@test.co', business: 'Indoor Anchor', category: cats.Bags, status: 'approved', space: 'indoor' });
  const m = await booking(sql, { ev, email: 'morenita@test.co', business: 'Morenita Fresca', category: cats['Drinks (Non-alcoholic)'], status: 'waitlist', space: 'indoor', waitlistedAt: new Date() });
  const created = await scanWaitlist(sql, ev.id, {});
  assert.equal(created.length, 1, 'exactly one offer is created');
  const [after] = await sql`select space, price, waitlist_offered_at from market.bookings where id = ${m.id}`;
  assert.equal(after.space, 'hallway', 'the booking converts to the hallway on offer');
  assert.equal(after.price, 4500, 'at the $45 hallway price');
  assert.ok(after.waitlist_offered_at, 'the offer clock is running');
  const [mail] = await sql`select body from market.outbox where recipient = 'morenita@test.co' order by created_at desc limit 1`;
  assert.ok(mail && mail.body.includes('A Hallway spot just opened'), 'the offer email names the Hallway');
  // And she can accept it: the §54 accept re-check runs against hallway.
  const { booking: accepted } = await acceptOffer(sql, m.id, m.user);
  assert.equal(accepted.status, 'approved');
  const inv = await eventInventory(sql, ev.id);
  assert.equal(inv.hallway, 1, 'the accepted vendor occupies the hallway spot');
});

test('§55: the scan does NOT offer hallway when the category is already capped (Morenita, Drinks 1/1)', async () => {
  const { sql, cats } = await seededDb();
  const hampton = await location(sql, 'Hampton Inn Odessa Trinity', { indoor: 1, outdoor: 1 });
  const ev = await event(sql, hampton.id, '2027-06-05', { indoor: 1, outdoor: 1, hallway: 1 });
  await booking(sql, { ev, email: 'a@test.co', business: 'Indoor Anchor', category: cats.Bags, status: 'approved', space: 'indoor' });
  // Drinks is already 1/1 on this date (an approved Drinks vendor outdoors).
  await booking(sql, { ev, email: 'd1@test.co', business: 'First Drinks', category: cats['Drinks (Non-alcoholic)'], status: 'approved', space: 'outdoor' });
  const m = await booking(sql, { ev, email: 'morenita@test.co', business: 'Morenita Fresca', category: cats['Drinks (Non-alcoholic)'], status: 'waitlist', space: 'indoor', waitlistedAt: new Date() });
  const created = await scanWaitlist(sql, ev.id, {});
  assert.equal(created.length, 0, 'no offer: the hallway never bypasses a full category (§54)');
  const [after] = await sql`select space, status, waitlist_offered_at from market.bookings where id = ${m.id}`;
  assert.equal(after.status, 'waitlist', 'she stays waitlisted');
  assert.equal(after.space, 'indoor', 'her booking is not converted');
  assert.equal(after.waitlist_offered_at, null, 'no window was burned');
});

test('§55: a vendor waitlisted in the hallway itself is offered a freed hallway spot', async () => {
  const { sql, cats } = await seededDb();
  const loc = await location(sql, 'Test Hall');
  const ev = await event(sql, loc.id, '2027-06-05', { hallway: 1 });
  const w = await booking(sql, { ev, email: 'w@test.co', business: 'Hallway Waiter', category: cats.Bags, status: 'waitlist', space: 'hallway', waitlistedAt: new Date() });
  const created = await scanWaitlist(sql, ev.id, { space: 'hallway' });
  assert.equal(created.length, 1, 'the hallway queue is scanned for hallway openings');
  const [after] = await sql`select space, waitlist_offered_at from market.bookings where id = ${w.id}`;
  assert.equal(after.space, 'hallway');
  assert.ok(after.waitlist_offered_at, 'the offer clock is running');
});
