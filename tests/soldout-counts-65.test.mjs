// §65 — A sold-out date is waitlist only everywhere the public sees
// it, and public availability counting agrees with the organizer
// roster (Nov 12, 2026). Scott's ruling after the Nov 28, 2026 Lutz
// date: the event was flagged sold_out and his Attendees roster held
// 36 vendors (the 36th inside booth being the recovered Faces of
// Promise booking), yet the public payload read indoor_used 35 — so
// the public side advertised an indoor spot that did not exist.
//
// (a) DISPLAY: the apply flow already routes sold_out dates to the
// waitlist, but several public renderings computed availability from
// slots() alone and ignored e.sold_out: the date cards, the home
// calendar + market-day modal (the availability() helper), the
// market-details page, and the apply form's per-space option labels.
// All now treat sold_out as sold out / waitlist only. Routing is
// untouched — a vendor can still pick a space for a waitlist request.
//
// (b) COUNTING: server/counts.mjs is the single counting function
// (booking = system of record for space; an imported twin ranks just
// below an approved booking, IMPORTED_RANK 2). The organizer rosters
// diverged twice over: (1) the admin/manager booking payloads never
// selected a.vendor_id, so a booking row keyed by email while its
// imported twin keyed by vendor id — the roster counted the twin
// TWICE where counts.mjs counts once; (2) both roster dedupes
// (client dedupeVendorRows, api.mjs dedupeSetupRows) ranked an
// imported twin as 'paid' (5), outranking the approved booking (3),
// so when the twins disagreed on space the roster put the vendor in
// the imported row's space while public counting used the booking's.
// The payloads now carry a.vendor_id and both dedupes rank an
// imported row at 2, mirroring counts.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = p => readFileSync(join(root, p), 'utf8');
const API = read('netlify/functions/api.mjs');
const APPJS = read('public/app.js');

// ---------------------------------------------------------------- static pins
test('§65a: every public availability rendering honors the sold_out flag', () => {
  assert.ok(APPJS.includes("e.sold_out||e.indoor_open===false||slots(e,'indoor')===0?'Indoor — SOLD OUT'"), 'date cards: sold_out reads Indoor — SOLD OUT');
  assert.ok(APPJS.includes("e.sold_out||e.outdoor_open===false||slots(e,'outdoor')===0?'Outdoor — SOLD OUT'"), 'date cards: sold_out reads Outdoor — SOLD OUT');
  assert.ok(APPJS.includes("const i=x.sold_out||x.indoor_open===false?0:slots(x,'indoor')"), 'home availability() zeroes a sold_out date (calendar + market-day modal)');
  assert.ok(APPJS.includes("const i=e.sold_out||e.indoor_open===false?0:slots(e,'indoor')"), 'market-details zeroes a sold_out date');
  assert.ok(APPJS.includes("const availability=closed||event.sold_out||left<=0?'Waitlist only':left+' available'"), 'apply space options label a sold_out date Waitlist only');
});

test('§65a: apply routing is untouched — sold_out dates still collect waitlist requests with a space', () => {
  assert.ok(APPJS.includes("const full=event.sold_out||((event.indoor_open===false||slots(event,'indoor')===0)&&(event.outdoor_open===false||slots(event,'outdoor')===0));"), 'the picked-date card still flags sold_out as waitlist-only');
  assert.ok(API.includes('const waitlist=event.sold_out||areaClosed||categoryFull||spaceFull;'), 'the server still routes sold_out applications to the waitlist');
});

test('§65b: roster dedupes mirror counts.mjs — imported twin ranks below the booking, payloads carry vendor_id', () => {
  assert.ok(APPJS.includes("rank=v=>(v.imported===true||v.source==='imported')?2:"), 'client dedupeVendorRows ranks an imported row at 2');
  assert.ok(API.includes("rank=v=>v.source==='imported'?2:"), 'api dedupeSetupRows ranks an imported row at 2');
  assert.ok(API.includes('a.user_id,a.vendor_id,a.agreements'), 'the admin applications payload carries a.vendor_id');
  assert.ok(API.includes('b.space,a.vendor_id,a.name'), 'the manager applications payload carries a.vendor_id');
});

// ------------------------------------------------- client dedupe, behaviorally
const extractFn = (src, name) => {
  const line = src.split('\n').find(l => l.startsWith('function ' + name + '('));
  assert.ok(line, 'function ' + name + ' is a single-line declaration in app.js');
  return line;
};
// dedupeVendorRows calls vendorIdentityKey, so both declarations are
// evaluated in one scope.
const dedupeVendorRows = new Function(
  extractFn(APPJS, 'vendorIdentityKey') + '\n' + extractFn(APPJS, 'dedupeVendorRows') + '\nreturn dedupeVendorRows;'
)();

test('§65b: client roster dedupe counts a booking/imported twin once, in the booking space', () => {
  const booking = { id: 'b1', vendor_id: 'v1', email: 'twin@x.com', phone: '7275550142', business: 'Twin Co', space: 'indoor', status: 'approved', imported: false };
  const imported = { id: 'i1', vendor_id: 'v1', email: 'twin@x.com', phone: '7275550142', business: 'Twin Co', space: 'Outside', status: 'paid', payment_status: 'paid', imported: true };
  const rows = dedupeVendorRows([booking, imported]);
  assert.equal(rows.length, 1, 'the twin pair is one vendor on the roster');
  assert.equal(rows[0].id, 'b1', 'the booking — the system of record for space — wins');
  assert.equal(rows[0].space, 'indoor');
  // Same pair keyed by email alone (no vendor master): the booking still wins.
  const b2 = { ...booking, id: 'b2', vendor_id: undefined };
  const i2 = { ...imported, id: 'i2', vendor_id: undefined };
  const rows2 = dedupeVendorRows([b2, i2]);
  assert.equal(rows2.length, 1);
  assert.equal(rows2[0].id, 'b2', 'an approved booking outranks its paid imported twin');
});

// ---------------------------------------------------------------- api harness
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

let apiHandler, apiSql, ctx;
test.before(async () => {
  const parts = [];
  for (const f of ['server/rules.mjs', 'server/counts.mjs', 'server/profiles.mjs', 'server/vendor-payments.mjs', 'server/permissions.mjs', 'server/pricing.mjs', 'server/coupons.mjs', 'server/twins.mjs', 'server/waitlist.mjs', 'server/hallway.mjs'])
    parts.push(strip(await readFile(join(root, f), 'utf8')));
  parts.push(strip(await readFile(join(root, 'server/notifications.mjs'), 'utf8')).replace(/^const dateOnly=.*\n/m, ''));
  const db = new PGlite();
  await db.exec('create role anon; create role authenticated; create schema storage; create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);');
  for (const f of ['database/setup.sql', 'database/codify-live-schema.sql', 'database/vendor-credits.sql', 'database/waitlist-offers.sql', 'database/vendor-profiles.sql'])
    await db.exec(await readFile(join(root, f), 'utf8'));
  apiSql = pgliteSql(db);
  const mock = parts.join('\n') + '\nconst bookingActive = active;\n' + `
const ready=()=>true;
const identity=async()=>globalThis.__who;
const identityWithBan=identity;
const db=()=>globalThis.__sql;
const supa=()=>({ auth: { admin: { listUsers: async()=>({data:{users:[]},error:null}) } } });
const publicData=async()=>({}); const flushMail=async()=>{}; const banned=async()=>false;
const expire=async()=>{};
const audit=async(tx,u,action,detail)=>{globalThis.__audit.push({actor:u&&u.email,action,detail});};
const queue=async(tx,to,subject,body)=>{globalThis.__mail.push({to,subject,body});return {id:'00000000-0000-4000-8000-0000000000aa'};};
const isUserError=e=>!!e&&e.name==='Error'&&typeof e.message==='string'&&e.message.length>0&&e.code===undefined;
const syncCalendar=async()=>({});
const pickAreaAttachment=async()=>null; const allAreaAttachments=async()=>[]; const blockedRecipients=async()=>[];
`;
  let source = await readFile(join(root, 'netlify/functions/api.mjs'), 'utf8');
  source = source.replace(/^import .*;\n/gm, '');
  ({ default: apiHandler } = await import('data:text/javascript;base64,' + Buffer.from(mock + source).toString('base64')));
  globalThis.__sql = apiSql;
  globalThis.__audit = [];
  globalThis.__mail = [];
  globalThis.__who = { id: crypto.randomUUID(), email: 'organizer@test', admin: true, manager: false, permissions: [] };

  const [loc] = await apiSql`insert into market.locations(name,address,indoor_capacity,outdoor_capacity,indoor_price,outdoor_price) values('Hilton Garden Inn Suncoast','1400 Suncoast Pkwy',36,2,10000,3500) returning id`;
  const [cat] = await apiSql`select id from market.categories where name='Handmade Jewelry (No Paparazzi)' limit 1`;
  const [event] = await apiSql`insert into market.events(location_id,date,indoor_capacity,outdoor_capacity,indoor_price,outdoor_price,open,sold_out) values(${loc.id},'2027-06-12',1,2,10000,3500,true,true) returning id`;
  // One vendor, two records: an approved INDOOR booking and its
  // imported twin (paid, space 'Outside') sharing the vendor master.
  const [vendor] = await apiSql`insert into market.vendors(name,business,email,phone,category_id) values('Twin Vendor','Twin Co','twin@x.com','7275550142',${cat.id}) returning id`;
  const [app] = await apiSql`insert into market.applications(user_id,name,email,phone,business,description,category_id,photos,agreements,vendor_id) values(${crypto.randomUUID()},'Twin Vendor','twin@x.com','7275550142','Twin Co','Goods',${cat.id},'[]','{}',${vendor.id}) returning id`;
  await apiSql`insert into market.bookings(application_id,event_id,space,price,status) values(${app.id},${event.id},'indoor',10000,'approved')`;
  await apiSql`insert into market.imported_attendees(event_id,vendor_id,name,business,email,phone,space,payment_status,cancelled) values(${event.id},${vendor.id},'Twin Vendor','Twin Co','twin@x.com','7275550142','Outside','paid',false)`;
  ctx = { event };
});

test('§65b: public counting (counts.mjs) counts the twin once, in the booking space', async () => {
  const { eventInventory } = await import(pathToFileURL(join(root, 'server/counts.mjs')).href);
  const inv = await eventInventory(apiSql, ctx.event.id);
  assert.equal(inv.indoor, 1, 'the booking space is the count');
  assert.equal(inv.outdoor, 0, 'the imported twin does not add a second space');
});

test('§65b: the organizer floor roster now agrees — one row, the booking, indoor', async () => {
  const res = await apiHandler(new Request('https://market.test/.netlify/functions/api?action=floor-attendees&event_id=' + ctx.event.id, { method: 'GET' }));
  assert.equal(res.status, 200);
  const rows = await res.json();
  assert.equal(rows.length, 1, 'the roster shows the twin pair once, like the public count');
  assert.equal(rows[0].source, 'booking', 'the booking row survives the dedupe');
  assert.equal(rows[0].space, 'indoor', 'the roster places the vendor in the booking space — the room reads full the same way everywhere');
});
