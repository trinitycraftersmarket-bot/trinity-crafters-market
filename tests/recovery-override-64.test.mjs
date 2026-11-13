// §64 — Organizer over-capacity override on Approve Override
// (Nov 12, 2026). Scott hit this live: a failed application attempt
// (Faces of Promise, Nov 28 Hilton date) could not be recovered
// because recover-application hard-blocked on the event's sold_out
// flag and on the chosen space being at capacity. Scott's ruling: he
// overbooks deliberately (he expects ~5 no-shows per market) and
// wants an override — the same posture as the vendor-credit
// organizer override ("approves even if the category or booths are
// full").
//
// Pinned here: the Approve Override form gains the checkbox
// "Approve anyway — date/space is sold out (organizer override)";
// the flag travels in the recovery override payload (p.data); when
// checked, recover-application skips the sold_out block, the
// closed-space blocks and the space-capacity block, and the recovery
// audit records over_capacity:true plus the space and used/capacity
// figures it overrode; when NOT checked, every hard block stands
// exactly as before; the action stays admin-only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = p => readFileSync(join(root, p), 'utf8');
const API = read('netlify/functions/api.mjs');
const APPJS = read('public/app.js');

// ---------------------------------------------------------------- static pins
test('§64: the override checkbox is on the Approve Override form and travels in the payload', () => {
  assert.ok(APPJS.includes('name="over_capacity"'), 'the form carries the over_capacity checkbox');
  assert.ok(APPJS.includes('Approve anyway — date/space is sold out (organizer override)'), "the checkbox carries Scott's label");
  assert.ok(APPJS.includes("over_capacity:fd.get('over_capacity')==='on'"), 'the flag rides the recover-application payload');
  assert.ok(API.includes('const overCapacity=override.over_capacity===true;'), 'the action reads the flag from the override payload');
  assert.ok(API.includes('if(spaceUsed>=spaceCapacity&&!overCapacity)'), 'the capacity block is gated on the flag');
  assert.ok(API.includes('over_capacity:overCapacity,overridden'), 'the recovery audit records the override');
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

  const [loc] = await apiSql`insert into market.locations(name,address,indoor_capacity,outdoor_capacity,indoor_price,outdoor_price) values('Hilton Garden Inn Suncoast','1400 Suncoast Pkwy',36,2,10000,3500) returning id`;
  const [cat] = await apiSql`select id from market.categories where name='Handmade Jewelry (No Paparazzi)' limit 1`;
  await apiSql`update market.categories set vendor_limit = 0 where id = ${cat.id}`;
  const mkEvent = async (date, extra = {}) => (await apiSql`insert into market.events(location_id,date,indoor_capacity,outdoor_capacity,indoor_price,outdoor_price,open,sold_out,indoor_open) values(${loc.id},${date},${extra.indoor_capacity ?? 9},3,10000,3500,true,${extra.sold_out ?? false},${extra.indoor_open ?? true}) returning id`)[0];
  const full = await mkEvent('2027-06-12', { indoor_capacity: 1 });
  const flagged = await mkEvent('2027-06-19', { sold_out: true });
  const closed = await mkEvent('2027-06-26', { indoor_open: false });
  // Occupy the single indoor spot on the "full" date with another vendor.
  const occUser = crypto.randomUUID();
  const [occApp] = await apiSql`insert into market.applications(user_id,name,email,phone,business,description,category_id,photos,agreements) values(${occUser},'Occupant','occupant@x.com','7275550199','Occupy Co','Goods',${cat.id},'[]','{}') returning id`;
  await apiSql`insert into market.bookings(application_id,event_id,space,price,status) values(${occApp.id},${full.id},'indoor',10000,'approved')`;
  ctx = { loc, cat, full, flagged, closed };
});

const apiPost = (action, body) => apiHandler(new Request('https://market.test/.netlify/functions/api?action=' + action, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }));
const ADMIN = () => { globalThis.__who = { id: crypto.randomUUID(), email: 'organizer@test', admin: true, manager: false, permissions: [] }; };

async function mkAttempt(email, eventId) {
  const uid = crypto.randomUUID(), id = crypto.randomUUID();
  const snapshot = {
    name: 'Faces Vendor', business: 'Faces of Promise', phone: '7275550111', billing_address: '1 Main St',
    description: 'Face painting', category: ctx.cat.id, exception: '', referral_source: 'Friend', referral_group: '',
    coupon_code: '', signature: 'Faces Vendor',
    dates: [{ id: eventId, space: 'indoor' }], photos: [], photo_names: [],
    agreements: { nonrefundable: true, rain: true, nomlm: true, facebook: true, stayuntil3: true, hurricane: true, paymentready: true, contract: true }
  };
  await apiSql`insert into market.application_attempts(id,user_id,email,name,business,phone,category_id,snapshot,status,step) values(${id},${uid},${email},'Faces Vendor','Faces of Promise','7275550111',${ctx.cat.id},${JSON.stringify(snapshot)},'failed','submit')`;
  return id;
}
const recover = (attemptId, overCapacity) => apiPost('recover-application', {
  id: attemptId,
  data: {
    name: 'Faces Vendor', business: 'Faces of Promise', phone: '7275550111', billing_address: '1 Main St',
    description: 'Face painting', category: ctx.cat.id,
    ...(overCapacity !== undefined ? { over_capacity: overCapacity } : {})
  }
});

test('§64: recovery at capacity WITHOUT the flag still fails with the sold-out error', async () => {
  ADMIN();
  const attemptId = await mkAttempt('faces-a@x.com', ctx.full.id);
  const res = await recover(attemptId, undefined);
  assert.equal(res.status, 400);
  assert.ok((await res.json()).error.includes('indoor space is sold out.'), 'the hard block stands without the flag');
  const [n] = await apiSql`select count(*)::int n from market.applications where email = 'faces-a@x.com'`;
  assert.equal(n.n, 0, 'no application was created');
});

test('§64: recovery at capacity WITH the flag succeeds and the audit records the override figures', async () => {
  ADMIN();
  globalThis.__audit = [];
  const attemptId = await mkAttempt('faces-b@x.com', ctx.full.id);
  const res = await recover(attemptId, true);
  assert.equal(res.status, 200, 'recovery succeeds: ' + JSON.stringify(await res.clone().json()).slice(0, 200));
  const body = await res.json();
  assert.equal(body.bookings.length, 1);
  assert.equal(body.bookings[0].status, 'approved', 'the booking is created approved, exactly as a normal recovery');
  const entry = globalThis.__audit.find(a => a.action === 'application recovered');
  assert.ok(entry, 'the recovery audit exists');
  assert.equal(entry.detail.over_capacity, true, 'the audit flags the over-capacity override');
  assert.equal(entry.detail.overridden.length, 1);
  assert.equal(entry.detail.overridden[0].space, 'indoor');
  assert.equal(entry.detail.overridden[0].used, 1, 'the audit records the used count it overrode');
  assert.equal(entry.detail.overridden[0].capacity, 1, 'the audit records the capacity it overrode');
});

test('§64: an event flagged sold_out blocks recovery without the flag and yields with it', async () => {
  ADMIN();
  const a1 = await mkAttempt('faces-c@x.com', ctx.flagged.id);
  let res = await recover(a1, undefined);
  assert.equal(res.status, 400);
  assert.ok((await res.json()).error.includes('the market is marked sold out.'));
  globalThis.__audit = [];
  const a2 = await mkAttempt('faces-d@x.com', ctx.flagged.id);
  res = await recover(a2, true);
  assert.equal(res.status, 200);
  const entry = globalThis.__audit.find(a => a.action === 'application recovered');
  assert.equal(entry.detail.over_capacity, true);
  assert.equal(entry.detail.overridden[0].sold_out, true, 'the audit records that the sold-out flag was bypassed');
});

test('§64: a closed space blocks recovery without the flag and yields with it', async () => {
  ADMIN();
  const a1 = await mkAttempt('faces-e@x.com', ctx.closed.id);
  let res = await recover(a1, undefined);
  assert.equal(res.status, 400);
  assert.ok((await res.json()).error.includes('indoor vendor space is closed.'));
  const a2 = await mkAttempt('faces-f@x.com', ctx.closed.id);
  res = await recover(a2, true);
  assert.equal(res.status, 200);
});

test('§64: recover-application stays admin-only', async () => {
  globalThis.__who = { id: crypto.randomUUID(), email: 'vendor@x.com', admin: false, manager: false, permissions: [] };
  const attemptId = await mkAttempt('faces-g@x.com', ctx.full.id);
  const res = await recover(attemptId, true);
  assert.equal(res.status, 403, 'a non-admin cannot recover, override or not');
});
