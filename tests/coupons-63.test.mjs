// §63 — Coupon codes (Nov 12, 2026). Scott: a coupon code box on the
// vendor application immediately before the submit button; a coupon
// discounts the vendor fee by a percentage; an admin Coupons tab to
// add coupons; the launch coupon '501C' at 100% off, paired with a
// new '501c' vendor category (active, vendor_limit 1 — one per date)
// so a 501(c) nonprofit books free.
//
// Rules pinned here: coupons are DATA (market.coupons, codes stored
// uppercase, matched case-insensitively); seeds insert only when
// absent and never overwrite an edited row; an unknown or inactive
// code is a HARD error at submit ("That coupon code isn't valid.");
// the discount applies AFTER regularAwarePrice, per booking, integer
// cents, round half up, and bookings.price stores the FINAL price;
// the code is stored on the application and each booking and audited
// ('coupon applied'); a booking at $0 because of a coupon approves
// straight to 'paid' with payment_method 'Coupon <code>', no invoice
// reference, and a no-payment-due decision email; partial coupons use
// the normal invoice path at the discounted price.
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
const MOVESPACE = read('netlify/functions/move-space.mjs');
const NOTIFY = read('server/notifications.mjs');
const SCHEMA = read('database/codify-live-schema.sql');

// ---------------------------------------------------------------- static pins
test('§63: the coupon box sits immediately before the submit button and rides the payload + snapshot', () => {
  const box = APPJS.indexOf('name="coupon_code"');
  const submit = APPJS.indexOf('Submit application for review');
  assert.ok(box > 0 && submit > 0, 'both the coupon field and the submit button exist');
  assert.ok(box < submit, 'the coupon box comes before the submit button');
  assert.equal(APPJS.slice(box, submit).split('<button').length - 1, 1, 'the only button between the coupon box and its label text is the submit button itself — the box sits immediately before it');
  assert.ok(APPJS.includes("coupon_code:f.get('coupon_code')||''"), 'the attempt snapshot preserves the coupon code (recovery keeps it)');
  assert.ok(APPJS.includes("coupon_code:f.get('coupon_code')||''"), 'the apply payload carries the coupon code');
  assert.ok(APPJS.includes("['coupons','Coupons']"), 'the organizer panel has a Coupons tab');
  assert.ok(APPJS.includes("api('coupon-save'"), 'the Coupons tab saves through the coupon-save action');
  assert.ok(APPJS.includes('b.coupon_code?`<span>Coupon: '), 'admin application cards show the coupon next to the price');
});

test('§63: schema + seeds are codified, and the decision email has the no-payment-due wording', () => {
  assert.ok(SCHEMA.includes('create table if not exists market.coupons('), 'codified coupons table');
  assert.ok(SCHEMA.includes('alter table market.applications add column if not exists coupon_code text;'), 'codified application column');
  assert.ok(SCHEMA.includes('alter table market.bookings add column if not exists coupon_code text;'), 'codified booking column');
  assert.ok(SCHEMA.includes("select '501C', 100, true"), 'codified 501C seed');
  assert.ok(SCHEMA.includes("select '501c', true, 1"), 'codified 501c category seed');
  assert.ok(SCHEMA.includes('where not exists'), 'seeds are insert-only-when-absent');
  assert.ok(NOTIFY.includes('No payment is due — your '), 'the approval email carries the no-payment-due line');
  assert.ok(MOVESPACE.includes('couponPercentFor'), 'the §60 move-space reprice keeps the booking coupon %');
  assert.ok(API.includes("if(!u.admin)return json({error:'Organizer access only'},403);\n  await ensureCoupons(sql);\n  const code=normalizeCouponCode(p.code);"), 'coupon-save is admin-only and heals the schema first');
});

// ---------------------------------------------------------------- units
test('§63 (units): applyCouponPrice — percent off, integer cents, round half up', async () => {
  const { applyCouponPrice, normalizeCouponCode } = await import('../server/coupons.mjs');
  assert.equal(applyCouponPrice(4500, 50), 2250, '50% off a $45.00 fee is $22.50');
  assert.equal(applyCouponPrice(4500, 100), 0, '100% off is free');
  assert.equal(applyCouponPrice(4500, 0), 4500, '0% off is full price');
  assert.equal(applyCouponPrice(999, 50), 500, '499.5 rounds half up to 500');
  assert.equal(applyCouponPrice(1050, 95), 53, '52.5 rounds half up to 53');
  assert.equal(normalizeCouponCode(' 501c '), '501C', 'codes normalize to trimmed uppercase');
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

let apiHandler, apiSql, apiCtx;
test.before(async () => {
  const parts = [];
  for (const f of ['server/rules.mjs', 'server/counts.mjs', 'server/profiles.mjs', 'server/vendor-payments.mjs', 'server/permissions.mjs', 'server/pricing.mjs', 'server/coupons.mjs', 'server/twins.mjs', 'server/waitlist.mjs', 'server/hallway.mjs'])
    parts.push(strip(await readFile(join(root, f), 'utf8')));
  // notifications.mjs and waitlist.mjs both declare an identical
  // top-level `const dateOnly` — inlining both into one scope needs
  // one copy dropped (they are the same function, verbatim).
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

  const [hampton] = await apiSql`insert into market.locations(name,address,indoor_capacity,outdoor_capacity,indoor_price,outdoor_price) values('Hampton Inn Odessa Trinity','11780 State Rd 54',9,3,4500,3000) returning id`;
  const mkEvent = async date => (await apiSql`insert into market.events(location_id,date,indoor_capacity,outdoor_capacity,indoor_price,outdoor_price,open) values(${hampton.id},${date},9,3,4500,3000,true) returning id`)[0];
  const events = { a: await mkEvent('2027-01-09'), b: await mkEvent('2027-02-20'), c: await mkEvent('2027-03-20'), d: await mkEvent('2027-04-17'), e: await mkEvent('2027-05-15') };
  const [cat] = await apiSql`select id from market.categories where name='Handmade Jewelry (No Paparazzi)' limit 1`;
  await apiSql`update market.categories set vendor_limit = 0 where id = ${cat.id}`;
  apiCtx = { hampton, events, cat };
});

const apiPost = (action, body) => apiHandler(new Request('https://market.test/.netlify/functions/api?action=' + action, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }));
const ADMIN = () => { globalThis.__who = { id: crypto.randomUUID(), email: 'organizer@test', admin: true, manager: false, permissions: [] }; };
const AGREEMENTS = { nonrefundable: true, rain: true, nomlm: true, facebook: true, stayuntil3: true, hurricane: true, paymentready: true, contract: true, signature: 'Test Vendor' };
async function applyAs(email, eventId, couponCode) {
  const uid = crypto.randomUUID();
  globalThis.__who = { id: uid, email, admin: false, manager: false, permissions: [] };
  return apiPost('apply', {
    name: 'Test Vendor', business: 'Test Business', description: 'Handmade jewelry and gifts',
    referral_source: 'Friend', phone: '7275550100', category: apiCtx.cat.id,
    photos: [uid + '/photo.jpg'], agreements: AGREEMENTS,
    dates: [{ id: eventId, space: 'indoor' }],
    ...(couponCode !== undefined ? { coupon_code: couponCode } : {})
  });
}
const bookingFor = async (email, eventId) => {
  const [b] = await apiSql`select b.* from market.bookings b join market.applications a on a.id = b.application_id where lower(a.email) = ${email} and b.event_id = ${eventId} limit 1`;
  return b;
};

test('§63: seeds land via the lazy ensure — 501C at 100% and category 501c at limit 1 — and never overwrite edits', async () => {
  const coupons = await import('../server/coupons.mjs');
  await coupons.ensureCoupons(apiSql);
  await coupons.ensureCoupons(apiSql);
  const rows = await apiSql`select * from market.coupons where code = '501C'`;
  assert.equal(rows.length, 1, 'exactly one 501C coupon after repeated ensures');
  assert.equal(rows[0].percent, 100);
  assert.equal(rows[0].active, true);
  const [cat] = await apiSql`select * from market.categories where lower(name) = '501c'`;
  assert.ok(cat, 'the 501c category exists');
  assert.equal(cat.vendor_limit, 1, 'only 1 allowed per date');
  assert.equal(cat.active, true);
  // An organizer edit survives the next ensure (insert-only-when-absent).
  await apiSql`update market.coupons set percent = 55 where code = '501C'`;
  await coupons.ensureCoupons(apiSql);
  const [edited] = await apiSql`select percent from market.coupons where code = '501C'`;
  assert.equal(edited.percent, 55, 'the ensure never overwrites an edited coupon');
  await apiSql`update market.coupons set percent = 100 where code = '501C'`;
});

test('§63: coupon-save requires admin and writes an audit row', async () => {
  globalThis.__who = { id: crypto.randomUUID(), email: 'vendor@test', admin: false, manager: false, permissions: [] };
  let res = await apiPost('coupon-save', { code: 'HALF', percent: 50, active: true });
  assert.equal(res.status, 403, 'a non-admin cannot save coupons');
  globalThis.__audit = [];
  ADMIN();
  res = await apiPost('coupon-save', { code: 'half', percent: 50, active: true });
  assert.equal(res.status, 200);
  const saved = (await res.json()).coupon;
  assert.equal(saved.code, 'HALF', 'codes are stored uppercase');
  assert.equal(saved.percent, 50);
  assert.ok(globalThis.__audit.some(a => a.action === 'coupon saved' && a.detail.code === 'HALF'), 'the save is audited');
});

test('§63: an unknown coupon code is a hard error at submit — no application is created', async () => {
  const res = await applyAs('bad-code@x.com', apiCtx.events.a.id, 'NOPE');
  assert.equal(res.status, 400);
  assert.ok((await res.json()).error.includes("That coupon code isn't valid."));
  const [n] = await apiSql`select count(*)::int n from market.applications where email = 'bad-code@x.com'`;
  assert.equal(n.n, 0, 'the failed submit leaves no application behind');
});

test('§63: an inactive coupon code is rejected the same way', async () => {
  ADMIN();
  const saved = (await (await apiPost('coupon-save', { code: 'HALF', percent: 50, active: true })).json()).coupon;
  await apiPost('coupon-save', { id: saved.id, code: 'HALF', percent: 50, active: false });
  const res = await applyAs('inactive@x.com', apiCtx.events.a.id, 'half');
  assert.equal(res.status, 400);
  assert.ok((await res.json()).error.includes("That coupon code isn't valid."));
  ADMIN();
  await apiPost('coupon-save', { id: saved.id, code: 'HALF', percent: 50, active: true });
});

test('§63: 50% off a 4500 fee stores 2250, the code rides the application + booking, and the submit is audited', async () => {
  globalThis.__audit = [];
  const res = await applyAs('half@x.com', apiCtx.events.b.id, 'half');
  assert.equal(res.status, 200, 'apply succeeds: ' + JSON.stringify(await res.clone().json()).slice(0, 200));
  const b = await bookingFor('half@x.com', apiCtx.events.b.id);
  assert.equal(b.price, 2250, 'the booking stores the FINAL discounted price');
  assert.equal(b.coupon_code, 'HALF', 'the booking carries the normalized code');
  const [a] = await apiSql`select coupon_code from market.applications where email = 'half@x.com'`;
  assert.equal(a.coupon_code, 'HALF', 'the application carries the code');
  const entry = globalThis.__audit.find(x => x.action === 'coupon applied');
  assert.ok(entry, 'a coupon-applied audit entry is written at submit');
  assert.equal(entry.detail.code, 'HALF');
  assert.equal(entry.detail.percent, 50);
  assert.deepEqual(entry.detail.bookings.map(x => [x.base_price, x.final_price]), [[4500, 2250]], 'the audit records base and final per booking');
});

test('§63: a partial coupon approves through the normal invoice path (stays approved, not paid)', async () => {
  const b = await bookingFor('half@x.com', apiCtx.events.b.id);
  ADMIN();
  const res = await apiPost('booking', { id: b.id, status: 'approved' });
  assert.equal(res.status, 200);
  const [after] = await apiSql`select status, payment_method, invoice_reference from market.bookings where id = ${b.id}`;
  assert.equal(after.status, 'approved', 'a partial coupon still owes the discounted balance');
  assert.ok(!after.payment_method, 'no coupon payment method is recorded for a partial discount');
});

test('§63: 501C at 100% — price 0, approval lands paid by coupon, no invoice, no-payment-due email', async () => {
  globalThis.__mail = [];
  const res = await applyAs('nonprofit@x.com', apiCtx.events.c.id, '501c');
  assert.equal(res.status, 200, 'apply succeeds with the lowercase code (case-insensitive)');
  const b = await bookingFor('nonprofit@x.com', apiCtx.events.c.id);
  assert.equal(b.price, 0, 'the 100% coupon zeroes the fee');
  assert.equal(b.coupon_code, '501C');
  assert.equal(b.status, 'pending');
  ADMIN();
  const approve = await apiPost('booking', { id: b.id, status: 'approved' });
  assert.equal(approve.status, 200);
  const [after] = await apiSql`select status, paid_at, payment_method, invoice_reference from market.bookings where id = ${b.id}`;
  assert.equal(after.status, 'paid', 'approval of a $0 coupon booking lands paid, never held/approved-unpaid');
  assert.ok(after.paid_at, 'paid_at is stamped');
  assert.equal(after.payment_method, 'Coupon 501C');
  assert.equal(after.invoice_reference, null, 'no invoice is ever attached');
  const mail = globalThis.__mail.filter(m => m.to === 'nonprofit@x.com');
  const decision = mail.find(m => m.subject.includes("You're approved"));
  assert.ok(decision, 'the approval email was queued');
  assert.ok(decision.body.includes('No payment is due — your 501C coupon covered the vendor fee.'), 'the email says no payment is due');
  assert.ok(!decision.body.includes('We will send your invoice separately'), 'the email never promises an invoice');
  assert.ok(!decision.body.includes('payment deadline begins'), 'the email never states a payment deadline');
});

test('§63: no coupon — full price, no coupon fields set (negative control)', async () => {
  const res = await applyAs('plain@x.com', apiCtx.events.d.id);
  assert.equal(res.status, 200);
  const b = await bookingFor('plain@x.com', apiCtx.events.d.id);
  assert.equal(b.price, 4500);
  assert.equal(b.coupon_code, null);
});
