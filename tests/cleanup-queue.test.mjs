import test from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {readFile} from 'node:fs/promises';
import {categoryScanConflicts, deleteAreaPlan} from '../netlify/functions/api.mjs';
import {assertCapacity} from '../server/counts.mjs';
import {checkCapacity} from '../server/rules.mjs';

// Cleanup queue (Oct 22): (1) vendor_limit 0 means NO per-category cap on
// every surface — the AI category scan, the capacity guards — not just the
// credit flow that first surfaced it; (2) saved floor-plan areas can be
// deleted through floor-area-plans-delete, refusing while vendors are
// still assigned. Same PGlite adapter as tests/vendor-credit.test.mjs.
function pgliteSql(db) {
  const sql = async (strings, ...values) => {
    let text = '', params = [];
    strings.forEach((s, i) => { text += s; if (i < values.length) { params.push(values[i]); text += '$' + params.length; } });
    return (await db.query(text, params)).rows;
  };
  sql.json = v => JSON.stringify(v);
  sql.begin = async fn => {
    await db.exec('begin');
    try { const r = await fn(sql); await db.exec('commit'); return r; }
    catch (e) { await db.exec('rollback'); throw e; }
  };
  return sql;
}

const ORG = {email: 'org@example.com', admin: true};
const MANAGER = {email: 'mgr@example.com', manager: true, permissions: ['floor_plans']};
const VENDOR = {email: 'vendor@example.com'};

async function seededDb() {
  const db = new PGlite();
  await db.exec('create role anon; create role authenticated; create schema storage; create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);');
  await db.exec(await readFile('database/setup.sql', 'utf8'));
  await db.exec(await readFile('database/codify-live-schema.sql', 'utf8'));
  await db.exec(await readFile('database/vendor-credits.sql', 'utf8'));
  await db.exec(await readFile('database/waitlist-offers.sql', 'utf8'));
  await db.exec(await readFile('database/vendor-profiles.sql', 'utf8'));
  // setup.sql still declares check(vendor_limit>0) on categories, but the
  // category save accepts 0 and live categories sit at 0 (codify §14a calls
  // this out as relaxed out-of-band in production). Mirror production so
  // the no-cap state can be seeded at all.
  await db.exec('alter table market.categories drop constraint categories_vendor_limit_check');
  const sql = pgliteSql(db);
  const [loc] = await sql`insert into market.locations(name,address,indoor_capacity,outdoor_capacity,indoor_price,outdoor_price) values('Hampton Inn Odessa Trinity','11780 State Rd 54',9,3,4500,3500) returning id`;
  const cats = {};
  for (const row of await sql`select id,name from market.categories where name in ('Bags','Candles')`) cats[row.name] = row.id;
  async function event(date) {
    const [e] = await sql`insert into market.events(location_id,date,indoor_capacity,outdoor_capacity,indoor_price,outdoor_price) values(${loc.id},${date},9,3,4500,3500) returning *`;
    return e;
  }
  async function booking(ev, categoryId, email) {
    const userId = crypto.randomUUID();
    const [app] = await sql`insert into market.applications(user_id,name,email,phone,business,description,category_id,photos,agreements) values(${userId},'Vendor',${email},'7275550100','Biz','Goods',${categoryId},'{}','{}') returning id`;
    const [b] = await sql`insert into market.bookings(application_id,event_id,space,price,status) values(${app.id},${ev.id},'indoor',4500,'paid') returning *`;
    return b;
  }
  return {db, sql, cats, event, booking};
}

test('limit 0 = no cap: the category scan never flags it, capped-and-full still flags', async () => {
  const {sql, cats, event, booking} = await seededDb();
  await sql`update market.categories set vendor_limit = 0 where id = ${cats.Candles}`;
  await sql`update market.categories set vendor_limit = 1 where id = ${cats.Bags}`;
  const ev = await event('2026-10-24');
  await booking(ev, cats.Candles, 'candles@example.com');
  await booking(ev, cats.Bags, 'bags@example.com');

  // No-cap category with a vendor booked: no conflict, with or without dates.
  assert.deepEqual(await categoryScanConflicts(sql, ['Candles'], [ev.id]), []);
  assert.deepEqual(await categoryScanConflicts(sql, ['Candles'], []), []);

  // Genuinely full capped category (limit 1, one booked): still flagged.
  const full = await categoryScanConflicts(sql, ['Bags'], [ev.id]);
  assert.equal(full.length, 1);
  assert.equal(full[0].category, 'Bags');
  assert.equal(full[0].limit, 1);
  assert.equal(full[0].used, 1);
  assert.equal(full[0].reason, 'Category limit is already reached');

  // Per-event override wins both ways: Bags overridden to 0 (no cap) clears
  // the flag; Candles overridden to 1 (now full) raises it.
  await sql`insert into market.event_category_limits(event_id,category_id,vendor_limit) values(${ev.id},${cats.Bags},0)`;
  assert.deepEqual(await categoryScanConflicts(sql, ['Bags'], [ev.id]), []);
  await sql`insert into market.event_category_limits(event_id,category_id,vendor_limit) values(${ev.id},${cats.Candles},1)`;
  const overridden = await categoryScanConflicts(sql, ['Candles'], [ev.id]);
  assert.equal(overridden.length, 1);
  assert.equal(overridden[0].limit, 1);
});

test('limit 0 = no cap: capacity guards accept raw 0 limits and still enforce real caps', async () => {
  const {sql, cats, event, booking} = await seededDb();
  const ev = await event('2026-10-24');
  await booking(ev, cats.Candles, 'candles@example.com');

  // assertCapacity (server/counts.mjs) — the reinstate/booking callers pass
  // the RAW category limit; 0 must not read as "already full".
  await assert.doesNotReject(() => assertCapacity(sql, ev, {space: 'indoor', categoryId: cats.Candles, limit: 0}));
  await assert.doesNotReject(() => assertCapacity(sql, ev, {space: 'indoor', categoryId: cats.Candles, limit: null}));
  await assert.rejects(() => assertCapacity(sql, ev, {space: 'indoor', categoryId: cats.Candles, limit: 1}), /Category is full/);
  await assert.doesNotReject(() => assertCapacity(sql, ev, {space: 'indoor', categoryId: cats.Candles, limit: 1, exception: true}));

  // checkCapacity (server/rules.mjs) — the same rule in the in-memory twin.
  const e = {indoor_capacity: 5, outdoor_capacity: 5};
  const b = [{status: 'paid', space: 'indoor', category_id: 'candles'}];
  assert.doesNotThrow(() => checkCapacity(e, b, 'indoor', 'candles', 0));
  assert.throws(() => checkCapacity(e, b, 'indoor', 'candles', 1), /Category is full/);
});

test('floor-area-plans-delete: refuses with assignments, succeeds without, staff-gated', async () => {
  const {sql, event} = await seededDb();
  const ev = await event('2026-10-24');
  const vendorId = crypto.randomUUID();
  await sql`insert into market.floor_plan_areas(event_id,area_key,title,prefix,capacity,space_type,assignments) values(${ev.id},'hall','Main Hall','HI',9,'indoor',${JSON.stringify({'HI-01': {vendor_id: vendorId}, 'HI-02': {vendor_id: ''}})})`;
  await sql`insert into market.floor_plan_areas(event_id,area_key,title,prefix,capacity,space_type,assignments) values(${ev.id},'porch','Porch','PO',3,'outdoor','{}')`;
  const remaining = async () => (await sql`select area_key from market.floor_plan_areas where event_id = ${ev.id} order by area_key`).map(r => r.area_key);

  // Assignments present -> refuse with the reason, row untouched.
  await assert.rejects(() => deleteAreaPlan(sql, {event_id: ev.id, area_key: 'hall'}, ORG), /still has 1 vendor booth assignment — move or unassign those vendors first/);
  assert.deepEqual(await remaining(), ['hall', 'porch']);

  // Non-staff -> 403 response, row untouched.
  const denied = await deleteAreaPlan(sql, {event_id: ev.id, area_key: 'porch'}, VENDOR);
  assert.equal(denied.status, 403);
  assert.deepEqual(await remaining(), ['hall', 'porch']);

  // Staff manager WITH the floor_plans permission -> succeeds.
  const byManager = await deleteAreaPlan(sql, {event_id: ev.id, area_key: 'porch'}, MANAGER);
  assert.equal(byManager.status, 200);
  assert.deepEqual(await (byManager.json()), {ok: true, area_key: 'porch'});
  assert.deepEqual(await remaining(), ['hall']);

  // Once the vendor is unassigned, the organizer delete succeeds too.
  await sql`update market.floor_plan_areas set assignments = '{}'::jsonb where event_id = ${ev.id} and area_key = 'hall'`;
  const byOrg = await deleteAreaPlan(sql, {event_id: ev.id, area_key: 'hall'}, ORG);
  assert.equal(byOrg.status, 200);
  assert.deepEqual(await remaining(), []);

  // Deleting what is not saved is a clear 400-style refusal, not a silent ok.
  await assert.rejects(() => deleteAreaPlan(sql, {event_id: ev.id, area_key: 'nope'}, ORG), /not saved for this market date/);
});
