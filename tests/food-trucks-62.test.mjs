// §62 — Food-truck organizer controls (Nov 7, 2026). Scott: "how do I
// edit food truck availability… And the price?" Before §62 neither was
// editable anywhere: availability was purely automatic (one spot per
// date, held by any pending/approved/paid application) and the $35
// price was hardcoded in the function, the public page, and the admin
// tab. §62 adds (a) an editable price stored in market.settings key
// 'food_truck_price_cents' (default 3500 when unset) read everywhere
// the 3500 used to be hardcoded, and (b) a per-date open/close toggle
// on market.events.food_truck_open in the admin Food Trucks tab. The
// toggle never touches existing applications.
//
// These behavioral tests run the REAL handler through the §50/§53
// inlining harness (imports stripped, core mocked with PGlite) against
// a minimal schema; the function's own schema() creates its table.
import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = p => readFileSync(join(root, p), 'utf8');

function pgliteSql(db) {
  const sql = async (strings, ...values) => {
    let text = '', params = [];
    strings.forEach((s, i) => { text += s; if (i < values.length) { params.push(values[i]); text += '$' + params.length; } });
    return (await db.query(text, params)).rows;
  };
  sql.json = v => JSON.stringify(v);
  sql.unsafe = async (text, params = []) => (await db.query(text, params)).rows;
  sql.begin = async fn => {
    await db.exec('begin');
    try { const r = await fn(sql); await db.exec('commit'); return r; }
    catch (e) { await db.exec('rollback'); throw e; }
  };
  return sql;
}

const ADMIN = { id: '22222222-2222-2222-2222-222222222222', email: 'organizer@test', admin: true };
const MANAGER = { id: '33333333-3333-3333-3333-333333333333', email: 'manager@test', admin: false, manager: true };
const TRUCK = { id: '11111111-1111-1111-1111-111111111111', email: 'taco@test.com', admin: false };
const NOBODY = { id: '44444444-4444-4444-4444-444444444444', email: 'rando@test', admin: false };

let handler, sql, locId;
test.before(async () => {
  const source = read('netlify/functions/food-trucks.mjs').replace(/^import .*;\n/gm, '');
  const mock = `
const db=()=>globalThis.__ftSql;
const identity=async()=>globalThis.__ftWho;
const queue=async(tx,to,subject,body)=>{globalThis.__ftMail.push({to,subject,body});};
const flushMail=async()=>{};
const audit=async(tx,u,action,detail)=>{globalThis.__ftAudit.push({actor:u&&u.email,action,detail});};
`;
  ({ default: handler } = await import('data:text/javascript;base64,' + Buffer.from(mock + source).toString('base64')));
  const db = new PGlite();
  await db.exec(`create schema market;
    create table market.settings(key text primary key, value text not null);
    create table market.locations(id uuid primary key default gen_random_uuid(), name text, market_name text);
    create table market.events(id uuid primary key default gen_random_uuid(), location_id uuid references market.locations(id), date date, title text, end_time time, food_truck_open boolean not null default true);`);
  sql = pgliteSql(db);
  globalThis.__ftSql = sql;
  globalThis.__ftMail = [];
  globalThis.__ftAudit = [];
  const [loc] = await sql`insert into market.locations(name, market_name) values('Hampton Inn Odessa Trinity', 'Trinity Crafters Market') returning id`;
  locId = loc.id;
});

const call = (method, url, body, who) => {
  globalThis.__ftWho = who;
  return handler(new Request(url, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }));
};
const pubGet = () => call('GET', 'https://market.test/.netlify/functions/food-trucks', null, TRUCK);
const adminGet = (who = ADMIN) => call('GET', 'https://market.test/.netlify/functions/food-trucks?admin=1', null, who);
const patch = (body, who = ADMIN) => call('PATCH', 'https://market.test/.netlify/functions/food-trucks', body, who);
async function mkEvent(date = '2027-06-12', open = true) {
  const [e] = await sql`insert into market.events(location_id, date, title, food_truck_open) values(${locId}, ${date}, 'Market Day', ${open}) returning id`;
  return e.id;
}
const applyBody = eventIds => ({ name: 'Taco Truck', email: 'taco@test.com', phone: '7275550100', billing_address: '1 Main St', food_type: 'Tacos', rig_size: '20 ft', permits: true, insurance: true, photos: [{ name: 'rig.jpg', size: 100, type: 'image/jpeg', rig: true, data: 'data:image/jpeg;base64,x' }], event_ids: eventIds });
const apply = (eventIds, who = TRUCK) => call('POST', 'https://market.test/.netlify/functions/food-trucks', applyBody(eventIds), who);

test('§62: price defaults to 3500 when unset; an open date with no application is available', async () => {
  const ev = await mkEvent('2027-06-12');
  const res = await pubGet();
  assert.equal(res.status, 200);
  const d = await res.json();
  assert.equal(d.price, 3500);
  const row = d.events.find(e => e.id === ev);
  assert.equal(row.available, true);
  assert.equal(row.food_truck_open, true);
});

test('§62: saving a price stores whole cents in market.settings, audits, and the public GET serves it', async () => {
  globalThis.__ftAudit = [];
  let res = await patch({ action: 'price', price_cents: 4200 });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).price, 4200);
  const [row] = await sql`select value from market.settings where key='food_truck_price_cents'`;
  assert.equal(row.value, '4200');
  const a = globalThis.__ftAudit.find(x => x.action === 'food truck price updated');
  assert.ok(a, 'price change is audited');
  assert.equal(a.detail.price_cents, 4200);
  assert.equal(a.detail.previous_price_cents, 3500);
  const d = await (await pubGet()).json();
  assert.equal(d.price, 4200);
});

test('§62: invalid prices refuse and change nothing; non-admins cannot save a price', async () => {
  for (const bad of [0, -500, 35.5, 'abc', null]) {
    const res = await patch({ action: 'price', price_cents: bad });
    assert.equal(res.status, 400, 'price_cents=' + bad);
  }
  assert.equal((await (await pubGet()).json()).price, 4200);
  const res = await patch({ action: 'price', price_cents: 5000 }, MANAGER);
  assert.equal(res.status, 403);
  assert.equal((await (await pubGet()).json()).price, 4200);
});

test('§62: a new application stores the current price and the confirmation email is priced from it', async () => {
  const ev = await mkEvent('2027-06-19');
  globalThis.__ftMail = [];
  const res = await apply([ev]);
  assert.equal(res.status, 200, JSON.stringify(await res.clone().json()).slice(0, 160));
  const d = await res.json();
  assert.equal(d.estimated_total, 4200);
  const [app] = await sql`select amount, status from market.food_truck_applications where event_id=${ev}`;
  assert.equal(app.amount, 4200);
  assert.equal(app.status, 'pending');
  const mail = globalThis.__ftMail.find(m => m.to === 'taco@test.com');
  assert.ok(mail, 'confirmation email queued');
  assert.match(mail.body, /— \$42\.00/);
  assert.match(mail.body, /Estimated invoice total if all selected dates are approved: \$42\.00/);
  // The pending application now holds the date on the public list.
  const pub = await (await pubGet()).json();
  assert.equal(pub.events.find(e => e.id === ev).available, false);
});

test('§62: closing a date stops new applications for it; reopening restores them', async () => {
  const ev = await mkEvent('2027-06-26');
  globalThis.__ftAudit = [];
  let res = await patch({ event_id: ev, food_truck_open: false });
  assert.equal(res.status, 200);
  assert.ok(globalThis.__ftAudit.some(a => a.action === 'food truck date closed' && a.detail.event_id === ev));
  const pub = await (await pubGet()).json();
  const row = pub.events.find(e => e.id === ev);
  assert.equal(row.food_truck_open, false);
  assert.equal(row.available, false);
  res = await apply([ev]);
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /sold out or no longer available/);
  res = await patch({ event_id: ev, food_truck_open: true });
  assert.equal(res.status, 200);
  assert.ok(globalThis.__ftAudit.some(a => a.action === 'food truck date opened' && a.detail.event_id === ev));
  res = await apply([ev]);
  assert.equal(res.status, 200);
});

test('§62: toggling a held date never touches the application — it stays listed as held and manageable', async () => {
  const ev = await mkEvent('2027-07-03');
  let res = await apply([ev]);
  assert.equal(res.status, 200);
  const [app] = await sql`select id from market.food_truck_applications where event_id=${ev}`;
  // Close the date under the live application.
  res = await patch({ event_id: ev, food_truck_open: false });
  assert.equal(res.status, 200);
  const [after] = await sql`select status from market.food_truck_applications where id=${app.id}`;
  assert.equal(after.status, 'pending', 'the application is untouched by the toggle');
  // Admin GET reports the hold honestly alongside the closed flag.
  const d = await (await adminGet()).json();
  const row = d.events.find(e => e.id === ev);
  assert.equal(row.food_truck_open, false);
  assert.equal(row.held_by, 'Taco Truck');
  assert.equal(row.held_status, 'pending');
  // The application is still fully manageable while its date is closed.
  res = await patch({ id: app.id, status: 'approved', approved_products: 'Tacos' });
  assert.equal(res.status, 200);
  const [approved] = await sql`select status from market.food_truck_applications where id=${app.id}`;
  assert.equal(approved.status, 'approved');
});

test('§62: admin GET carries price + upcoming-event state, and gates by role', async () => {
  const d = await (await adminGet()).json();
  assert.equal(d.price, 4200);
  assert.ok(Array.isArray(d.events) && d.events.length >= 4, 'upcoming events ride the admin GET');
  const open = d.events.find(e => e.date && String(e.date).startsWith('2027-06-12'));
  assert.equal(open.held_id, null);
  assert.equal(open.food_truck_open, true);
  // Manager may read the admin view (existing gate); a plain user may not.
  assert.equal((await adminGet(MANAGER)).status, 200);
  assert.equal((await adminGet(NOBODY)).status, 403);
  // Toggle validation: unknown event, non-boolean flag, non-admin.
  assert.equal((await patch({ event_id: '99999999-9999-9999-9999-999999999999', food_truck_open: false })).status, 400);
  const ev = await mkEvent('2027-07-10');
  assert.equal((await patch({ event_id: ev, food_truck_open: 'no' })).status, 400);
  assert.equal((await patch({ event_id: ev, food_truck_open: false }, NOBODY)).status, 403);
});

test('§62: frontend + shells are wired to the controls (static pins)', () => {
  const js = read('public/food-trucks.js');
  assert.ok(js.includes("data-ft-toggle"), 'dates section renders the toggle');
  assert.ok(js.includes('ft-price-save'), 'price editor is rendered');
  assert.ok(js.includes("action:'price'"), 'price save posts the price action');
  assert.ok(!js.includes('one food truck space for $35'), 'public page no longer hardcodes $35');
  assert.ok(!js.includes('Mark Paid $35'), 'admin tab no longer hardcodes the Mark Paid price');
  assert.ok(!js.includes('One $35 food truck spot'), 'admin tab header no longer hardcodes $35');
  for (const shell of ['public/index.html', 'public/classic/index.html', 'public/about-lutz-market/index.html', 'public/food-trucks/index.html', 'public/market-dates/index.html', 'public/vendor-opportunities-1/index.html']) {
    assert.ok(read(shell).includes('food-trucks.js?v=20261107-controls1'), shell + ' carries the §62 stamp');
  }
});
