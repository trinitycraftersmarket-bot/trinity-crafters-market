// §60 — Organizer booth-space swap (Nov 4, 2026). Scott, looking at a
// hallway booking card: "Make it to where I can move someone to inside
// and swap someone to hallway." A plain move into a full space refused
// ("Inside is full for this market date.") with no way forward.
//
// The swap is an extension of netlify/functions/move-space.mjs: the
// same POST with an added swapWith {id, imported}. Inside the same
// advisory-locked transaction the two records exchange spaces, BOTH
// bookings reprice via §50 regularAwarePrice for their new space
// (imported attendees keep their organizer-set invoice_amount, exactly
// as a plain move treats them), twin-sync fans out to BOTH vendors,
// and each side gets an 'attendee space swapped' audit entry naming
// the other. A swap exchanges 1-for-1, so no space's used count
// changes: no capacity refusal, no waitlist scan, no vendor email.
//
// These behavioral tests run the REAL handler through the §50
// inlining harness (server modules concatenated into one scope with
// mocked db/identity/audit), against a PGlite schema mirroring §50's.
import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
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
  sql.begin = async fn => {
    await db.exec('begin');
    try { const r = await fn(sql); await db.exec('commit'); return r; }
    catch (e) { await db.exec('rollback'); throw e; }
  };
  return sql;
}
const strip = src => src.replace(/^import .*;\n/gm, '').replace(/^export /gm, '');

let handler, sql, hamptonId;
test.before(async () => {
  let source = await readFile(join(root, 'netlify/functions/move-space.mjs'), 'utf8');
  source = source.replace(/^import .*;\n/gm, '');
  const rules = strip(await readFile(join(root, 'server/rules.mjs'), 'utf8'));
  const counts = strip(await readFile(join(root, 'server/counts.mjs'), 'utf8')) + '\nconst bookingActive = active;\n';
  const twins = strip(await readFile(join(root, 'server/twins.mjs'), 'utf8'));
  const pricing = strip(await readFile(join(root, 'server/pricing.mjs'), 'utf8'));
  const hallway = strip(await readFile(join(root, 'server/hallway.mjs'), 'utf8'));
  const mock = `
const db=()=>globalThis.__swapSql;
const identity=async()=>globalThis.__swapWho;
const audit=async(tx,u,action,detail)=>{globalThis.__swapAudit.push({actor:u&&u.email,action,detail});};
const isUserError=e=>!!e&&e.name==='Error'&&typeof e.message==='string'&&e.message.length>0&&e.code===undefined;
`;
  ({ default: handler } = await import('data:text/javascript;base64,' + Buffer.from(mock + rules + counts + twins + pricing + hallway + source).toString('base64')));
  const db = new PGlite();
  await db.exec(`create schema market;
    create table market.settings(key text primary key, value text not null);
    create table market.locations(id uuid primary key default gen_random_uuid(), name text, market_name text);
    create table market.events(id uuid primary key default gen_random_uuid(), location_id uuid, date date, indoor_capacity integer, outdoor_capacity integer, hallway_capacity integer, indoor_price integer, outdoor_price integer, hallway_price integer, end_time time);
    create table market.applications(id uuid primary key default gen_random_uuid(), email text, phone text, business text, name text, vendor_id uuid, category_id uuid, regular_vendor boolean not null default false);
    create table market.vendor_profiles(id uuid primary key default gen_random_uuid(), email text unique, regular_vendor boolean not null default false);
    create table market.bookings(id uuid primary key default gen_random_uuid(), application_id uuid, event_id uuid, space text, price integer, status text, hold_until timestamptz);
    create table market.imported_attendees(id uuid primary key default gen_random_uuid(), event_id uuid, space text, email text, phone text, business text, name text, vendor_id uuid, category_id uuid, cancelled boolean not null default false, invoice_amount integer);`);
  sql = pgliteSql(db);
  globalThis.__swapSql = sql;
  globalThis.__swapWho = { admin: true, email: 'organizer@test' };
  globalThis.__swapAudit = [];
  const [loc] = await sql`insert into market.locations(name) values('Hampton Inn Odessa Trinity') returning id`;
  hamptonId = loc.id;
});

const post = body => handler(new Request('https://market.test/.netlify/functions/move-space', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }));
async function mkEvent({ inCap = 1, outCap = 1, hallCap = 1, inPrice = 4500, outPrice = 3000, hallPrice = 4500 } = {}) {
  const [e] = await sql`insert into market.events(location_id, date, indoor_capacity, outdoor_capacity, hallway_capacity, indoor_price, outdoor_price, hallway_price) values(${hamptonId}, '2027-06-12', ${inCap}, ${outCap}, ${hallCap}, ${inPrice}, ${outPrice}, ${hallPrice}) returning id`;
  return e.id;
}
async function mkBooking(eventId, { email, business = 'Biz', space = 'indoor', price = 4500, status = 'paid', regular = false }) {
  const [app] = await sql`insert into market.applications(email, phone, business, name, regular_vendor) values(${email}, '7275550100', ${business}, 'Vendor', ${regular}) returning id`;
  const [b] = await sql`insert into market.bookings(application_id, event_id, space, price, status) values(${app.id}, ${eventId}, ${space}, ${price}, ${status}) returning id`;
  if (status === 'held') await sql`update market.bookings set hold_until = now() + interval '1 day' where id = ${b.id}`;
  return b.id;
}
async function mkImported(eventId, { email, business = 'ImpBiz', space = 'Inside', invoice = 4500, cancelled = false }) {
  const [i] = await sql`insert into market.imported_attendees(event_id, space, email, phone, business, name, invoice_amount, cancelled) values(${eventId}, ${space}, ${email}, '7275550100', ${business}, 'Vendor', ${invoice}, ${cancelled}) returning id`;
  return i.id;
}
const bookingRow = async id => (await sql`select space, price, status from market.bookings where id = ${id}`)[0];
const importedRow = async id => (await sql`select space, invoice_amount from market.imported_attendees where id = ${id}`)[0];

test('§60: swap succeeds when the target space is full — spaces exchange, both reprice, both sides audited', async () => {
  globalThis.__swapAudit = [];
  const ev = await mkEvent({ inCap: 1, hallCap: 1, inPrice: 4500, hallPrice: 4500 });
  const inside = await mkBooking(ev, { email: 'inside@test', space: 'indoor', price: 4500, status: 'paid' });
  const hall = await mkBooking(ev, { email: 'hall@test', space: 'hallway', price: 4500, status: 'held' });
  // The plain move into the full space still refuses, and changes nothing.
  let res = await post({ id: hall, space: 'indoor' });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /Inside is full for this market date/);
  assert.equal((await bookingRow(hall)).space, 'hallway');
  // The swap goes through.
  res = await post({ id: hall, space: 'indoor', swapWith: { id: inside, imported: false } });
  assert.equal(res.status, 200, JSON.stringify(await res.clone().json()).slice(0, 160));
  assert.deepEqual(await bookingRow(hall), { space: 'indoor', price: 4500, status: 'held' });
  assert.deepEqual(await bookingRow(inside), { space: 'hallway', price: 4500, status: 'paid' });
  // Both sides audited, each naming the other.
  const swaps = globalThis.__swapAudit.filter(a => a.action === 'attendee space swapped');
  assert.equal(swaps.length, 2);
  const aSide = swaps.find(a => a.detail.id === hall);
  assert.equal(aSide.detail.from, 'hallway'); assert.equal(aSide.detail.to, 'indoor');
  assert.equal(aSide.detail.partner_id, inside); assert.equal(aSide.detail.partner_imported, false);
  assert.equal(aSide.detail.event_id, ev);
  const bSide = swaps.find(a => a.detail.id === inside);
  assert.equal(bSide.detail.from, 'indoor'); assert.equal(bSide.detail.to, 'hallway');
  assert.equal(bSide.detail.partner_id, hall);
  // The swap changed no counts: Inside is still full afterwards.
  const third = await mkBooking(ev, { email: 'third@test', space: 'outdoor', price: 3000, status: 'approved' });
  res = await post({ id: third, space: 'indoor' });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /Inside is full for this market date/);
});

test('§60: prices that differ — a regular vendor keeps the regular rate through a swap (§50/§55)', async () => {
  const ev = await mkEvent({ inCap: 1, outCap: 1, inPrice: 4500, outPrice: 3000 });
  const reg = await mkBooking(ev, { email: 'reg@test', space: 'outdoor', price: 3000, status: 'paid', regular: true });
  const plain = await mkBooking(ev, { email: 'plain@test', space: 'indoor', price: 4500, status: 'approved' });
  const res = await post({ id: reg, space: 'indoor', swapWith: { id: plain, imported: false } });
  assert.equal(res.status, 200);
  // Regular moved indoors pays the $40 Hampton regular rate — not the
  // $45 standard; the non-regular partner pays the $30 outdoor price.
  assert.deepEqual(await bookingRow(reg), { space: 'indoor', price: 4000, status: 'paid' });
  assert.deepEqual(await bookingRow(plain), { space: 'outdoor', price: 3000, status: 'approved' });
});

test('§60: an imported attendee in a swap keeps their invoice_amount — as partner and as source', async () => {
  const ev = await mkEvent({ inCap: 1, outCap: 1 });
  const imp = await mkImported(ev, { email: 'imp@test', space: 'Inside', invoice: 7777 });
  const bk = await mkBooking(ev, { email: 'bk@test', space: 'outdoor', price: 3000, status: 'paid' });
  let res = await post({ id: bk, space: 'indoor', swapWith: { id: imp, imported: true } });
  assert.equal(res.status, 200);
  assert.deepEqual(await bookingRow(bk), { space: 'indoor', price: 4500, status: 'paid' });
  assert.deepEqual(await importedRow(imp), { space: 'Outside', invoice_amount: 7777 });
  // Reverse direction: the imported attendee is the one being moved.
  const ev2 = await mkEvent({ inCap: 1, outCap: 1 });
  const bkIn = await mkBooking(ev2, { email: 'bkin@test', space: 'indoor', price: 4500, status: 'paid' });
  const impOut = await mkImported(ev2, { email: 'impout@test', space: 'Outside', invoice: 5555 });
  res = await post({ id: impOut, imported: true, space: 'indoor', swapWith: { id: bkIn, imported: false } });
  assert.equal(res.status, 200);
  assert.deepEqual(await importedRow(impOut), { space: 'Inside', invoice_amount: 5555 });
  assert.deepEqual(await bookingRow(bkIn), { space: 'outdoor', price: 3000, status: 'paid' });
});

test('§60: twin records follow BOTH vendors in a swap', async () => {
  const ev = await mkEvent({ inCap: 1, hallCap: 1 });
  const aBk = await mkBooking(ev, { email: 'a@twin', space: 'indoor', price: 4500, status: 'paid' });
  const aImp = await mkImported(ev, { email: 'a@twin', space: 'Inside', invoice: 4500 });
  const bBk = await mkBooking(ev, { email: 'b@twin', space: 'hallway', price: 4500, status: 'held' });
  const bImp = await mkImported(ev, { email: 'b@twin', space: 'Hallway', invoice: 4500 });
  const res = await post({ id: bBk, space: 'indoor', swapWith: { id: aBk, imported: false } });
  assert.equal(res.status, 200, JSON.stringify(await res.clone().json()).slice(0, 160));
  assert.equal((await bookingRow(bBk)).space, 'indoor');
  assert.equal((await importedRow(bImp)).space, 'Inside', 'source twin follows to the target space');
  assert.equal((await bookingRow(aBk)).space, 'hallway');
  assert.equal((await importedRow(aImp)).space, 'Hallway', 'partner twin follows to the source space');
});

test('§60: refusals — different event, wrong space, unconfirmed, same vendor, non-organizer — change nothing', async () => {
  const evA = await mkEvent({ inCap: 1, outCap: 1, hallCap: 1 });
  const evB = await mkEvent({ inCap: 1 });
  const src = await mkBooking(evA, { email: 'src@test', space: 'hallway', price: 4500, status: 'held' });
  // Partner on a different event.
  const otherEvent = await mkBooking(evB, { email: 'other@test', space: 'indoor', price: 4500, status: 'paid' });
  let res = await post({ id: src, space: 'indoor', swapWith: { id: otherEvent, imported: false } });
  assert.equal(res.status, 400); assert.match((await res.json()).error, /different market date/);
  // Partner not in the target space.
  const outdoor = await mkBooking(evA, { email: 'out@test', space: 'outdoor', price: 3000, status: 'paid' });
  res = await post({ id: src, space: 'indoor', swapWith: { id: outdoor, imported: false } });
  assert.equal(res.status, 400); assert.match((await res.json()).error, /not in the Inside space anymore/);
  // Partner not confirmed.
  const pending = await mkBooking(evA, { email: 'pend@test', space: 'indoor', price: 4500, status: 'pending' });
  res = await post({ id: src, space: 'indoor', swapWith: { id: pending, imported: false } });
  assert.equal(res.status, 400); assert.match((await res.json()).error, /Only confirmed attendees can be swapped/);
  // Partner is the source's own twin (same vendor, other record).
  const srcTwin = await mkImported(evA, { email: 'src@test', space: 'Inside', invoice: 4500 });
  res = await post({ id: src, space: 'indoor', swapWith: { id: srcTwin, imported: true } });
  assert.equal(res.status, 400); assert.match((await res.json()).error, /same vendor/);
  // Partner is the record itself.
  res = await post({ id: src, space: 'indoor', swapWith: { id: src, imported: false } });
  assert.equal(res.status, 400); assert.match((await res.json()).error, /different vendor to swap with/);
  // Unconfirmed SOURCE still refuses at the existing gate.
  const wl = await mkBooking(evA, { email: 'wl@test', space: 'outdoor', price: 3000, status: 'waitlist' });
  res = await post({ id: wl, space: 'indoor' });
  assert.equal(res.status, 400); assert.match((await res.json()).error, /Only confirmed attendees can be moved/);
  // Non-organizer is refused outright.
  globalThis.__swapWho = { admin: false, manager: false, email: 'vendor@test' };
  res = await post({ id: src, space: 'indoor', swapWith: { id: pending, imported: false } });
  assert.equal(res.status, 403);
  globalThis.__swapWho = { admin: true, email: 'organizer@test' };
  // Nothing moved through any of that.
  assert.equal((await bookingRow(src)).space, 'hallway');
  assert.equal((await bookingRow(outdoor)).space, 'outdoor');
  assert.equal((await bookingRow(pending)).space, 'indoor');
  assert.equal((await importedRow(srcTwin)).space, 'Inside');
  // A manager (not just the admin) can swap — same gate as move-space.
  globalThis.__swapWho = { admin: false, manager: true, email: 'mgr@test' };
  const evM = await mkEvent({ inCap: 1, hallCap: 1 });
  const mIn = await mkBooking(evM, { email: 'min@test', space: 'indoor', price: 4500, status: 'paid' });
  const mHall = await mkBooking(evM, { email: 'mhall@test', space: 'hallway', price: 4500, status: 'paid' });
  res = await post({ id: mHall, space: 'indoor', swapWith: { id: mIn, imported: false } });
  assert.equal(res.status, 200);
  assert.equal((await bookingRow(mHall)).space, 'indoor');
  globalThis.__swapWho = { admin: true, email: 'organizer@test' };
});

test('§60 (static): the swap is wired into the move-space sheet, the Applications card, and the legacy booking card', () => {
  const fn60 = read('netlify/functions/move-space.mjs');
  assert.ok(fn60.includes("swapWith") && fn60.includes("'attendee space swapped'"), 'move-space supports swapWith and audits the swap');
  const att = read('public/v2/js/attendees.js');
  assert.ok(att.includes('swapWith') && att.includes('is full for this market date') && att.includes('Swap space'), 'Attendees sheet offers the swap when the target is full');
  const apps = read('public/v2/js/applications.js');
  assert.ok(apps.includes("['movespace', '⇄ Move / swap space'") && apps.includes('moveSpaceSheet(b)') && apps.includes('swapWith'), 'Applications booking card carries Move / swap space in its More menu');
  const legacy = read('public/app.js');
  assert.ok(legacy.includes('data-move-space="${b.id}"') && legacy.includes('swapSpaceModal') && legacy.includes('/.netlify/functions/move-space'), 'legacy booking card carries the move/swap action and calls move-space');
});
