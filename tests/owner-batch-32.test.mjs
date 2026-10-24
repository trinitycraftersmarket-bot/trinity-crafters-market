// §32 — three owner-requested items (Oct 23, 2026):
//  1. No-hold banner at the top of the vendor Apply screen.
//  2. Invoice / payment reference shown on organizer booking cards
//     (the owner marked a booking "Invoice sent manually · 000823" and
//     could not see the reference anywhere afterward).
//  3. Bulk category reset: every OPEN (active) category's global default
//     becomes 1 vendor per date ('categories-set-limit-one'), with
//     inactive categories, per-date overrides and bookings untouched.
import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = p => readFileSync(join(root, p), 'utf8');

// ---------------------------------------------------------------- Item 1
test('Item 1: no-hold banner sits at the top of the vendor Apply screen, above date selection', () => {
  const src = read('public/v2/js/vendor.js');
  const apply = src.slice(src.indexOf('export function renderVendorApply'));
  assert.ok(apply.includes('apply-banner'), 'banner element present in renderVendorApply');
  assert.ok(apply.includes('We do not hold space without payment'), 'banner carries the owner wording (first half)');
  assert.ok(apply.includes('please only select dates you can pay for'), 'banner carries the owner wording (second half)');
  assert.ok(apply.indexOf('apply-banner') < apply.indexOf('Market dates'), 'banner renders above the date selection');
  assert.ok(read('public/v2/css/app.css').includes('.apply-banner'), 'banner styling exists');
});

// ---------------------------------------------------------------- Item 2 (contract)
test('Item 2: booking card renders the invoice / payment reference lines', () => {
  const src = read('public/v2/js/applications.js');
  const card = src.slice(src.indexOf('function cardHtml'), src.indexOf('function primaryActions'));
  assert.ok(card.includes('b.invoice_reference'), 'card reads invoice_reference');
  assert.ok(card.includes('Invoice sent manually'), 'manual-invoice label present');
  assert.ok(card.includes('b.payment_reference'), 'card reads payment_reference');
  // The admin payload already carries both columns (bookings select is b.*).
  assert.ok(read('netlify/functions/api.mjs').includes('applications:await sql`select b.*,'),
    'admin payload selects b.* — invoice_reference/payment_reference already included, no payload change needed');
});

test('Item 2 (behavioral): held card shows "Invoice sent manually · Ref 000823"; PayPal and paid cards label theirs', async () => {
  globalThis.sessionStorage = { getItem: () => null, setItem() {}, removeItem() {} };
  globalThis.fetch = async () => { throw Error('offline in tests'); };
  const { renderApplications } = await import(new URL('../public/v2/js/applications.js', import.meta.url));

  const el = () => ({ innerHTML: '', value: '', textContent: '', querySelector: () => el(), querySelectorAll: () => [] });
  const stubRoot = () => {
    const els = new Map();
    return {
      innerHTML: '',
      querySelector(sel) { if (!els.has(sel)) els.set(sel, el()); return els.get(sel); },
      querySelectorAll: () => [],
      listHtml() { return els.get('#v2-app-list')?.innerHTML || ''; }
    };
  };
  const base = {
    event_id: 'ev-1', application_id: 'app-1', name: 'Aiyana Hunter', email: 'blissfulbakerysd@gmail.com',
    phone: '7028084104', business: 'Blissfully Bakery', category: 'Bread Baked Goods',
    description: 'Family-inspired small-batch bakery', space: 'outdoor', price: 3000,
    location: 'Hampton Inn Odessa Trinity', date: '2027-01-09', agreements: {}
  };
  const render = booking => {
    const r = stubRoot();
    const ctx = {
      state: { admin: { events: [{ id: 'ev-1', date: '2027-01-09', location: 'Hampton Inn Odessa Trinity' }], applications: [booking], allCategories: [], categoryLimits: [], counts: [] } },
      toast() {}, openSheet() {}, closeSheet() {}, refreshAdmin: async () => {}, sheetEl: el()
    };
    renderApplications(ctx, r);
    return r.listHtml();
  };

  const manual = render({ ...base, id: 'bk-manual', status: 'held', hold_until: '2026-10-25T01:10:51Z', invoice_reference: '000823' });
  assert.ok(manual.includes('Invoice sent manually · Ref 000823'), 'manual reference visible on the card (the owner-reported gap)');
  assert.ok(manual.includes('Payment deadline:'), 'deadline line still shown alongside');

  const paypal = render({ ...base, id: 'bk-paypal', status: 'held', hold_until: '2026-10-25T01:10:51Z', invoice_reference: 'INV2-X7KM-9QPL-2WZD' });
  assert.ok(paypal.includes('PayPal invoice · Ref INV2-X7KM-9QPL-2WZD'), 'PayPal invoice ids are labelled as PayPal (same INV2- test the server uses)');
  assert.ok(!paypal.includes('Invoice sent manually'), 'PayPal-held booking is not mislabelled as manual');

  const paid = render({ ...base, id: 'bk-paid', status: 'paid', payment_reference: '000822' });
  assert.ok(paid.includes('Payment ref:</strong> 000822'), 'paid booking shows its payment reference');

  const bare = render({ ...base, id: 'bk-bare', status: 'held', hold_until: '2026-10-25T01:10:51Z', invoice_reference: null });
  assert.ok(!bare.includes('· Ref'), 'held booking without a reference shows no reference line');
});

// ---------------------------------------------------------------- Item 3 (contract)
test('Item 3: Categories screen carries the bulk button, confirm copy and the new action call', () => {
  const src = read('public/v2/js/setup.js');
  assert.ok(src.includes('Set all open categories to 1 per date'), 'bulk button present');
  assert.ok(src.includes("api('categories-set-limit-one', {})"), 'button calls the bulk action');
  assert.ok(src.includes('Per-date overrides, where set, still apply on their dates'), 'confirm sheet names the override caveat');
  assert.ok(src.includes('Existing bookings are never changed'), 'confirm sheet states bookings are untouched');
  const apiSrc = read('netlify/functions/api.mjs');
  assert.ok(apiSrc.includes("action==='categories-set-limit-one'"), 'server action exists');
  assert.ok(apiSrc.includes('where active and vendor_limit<>1'), 'server updates ACTIVE rows not already at 1, in one statement');
});

// ---------------------------------------------------------------- Item 3 (behavioral, real handler on PGlite)
// Same data-URL harness as tests/audit-batch-31.test.mjs, except `audit`
// is the REAL one-liner from server/core.mjs so the audit row is asserted,
// and db() is a PGlite-backed sql tag so the UPDATE runs for real.
process.env.ADMIN_EMAIL = 'scottweber332@gmail.com';
let handlerPromise = null;
function loadApiHandler() {
  if (handlerPromise) return handlerPromise;
  const mocks = `
const isUserError=e=>false;
const ready=()=>true;
const db=()=>globalThis.__sql;
const supa=async()=>{throw Error('supa disabled in owner-batch-32 tests')};
const identity=async()=>globalThis.__who;
const banned=async()=>false;
const expire=async()=>{};
const audit=async(tx,u,action,detail)=>{await tx\`insert into market.audit(actor,action,detail) values(\${u.email||u},\${action},\${tx.json(detail)})\`;};
const queue=async()=>({});
const publicData=async()=>({});
const flushMail=async()=>{};
const normalizePhone=v=>String(v||'');
const eventInventory=async()=>({indoor_used:0,outdoor_used:0});
const categoryUsed=async()=>0;
const assertCapacity=async()=>{};
const vendorIdentityKey=()=>'';
const syncInspection=async()=>{};
const acceptOffer=async()=>({});
const declineOffer=async()=>({});
const ensureWaitlistSchema=async()=>{};
const offerAnyway=async()=>({});
const resolveOffers=async()=>({});
const scanWaitlist=async()=>{};
const decisionEmail=()=>({subject:'',body:''});
const banEmail=()=>({subject:'',body:''});
const syncCalendar=async()=>{};
const claimImported=async()=>{};
const ensureProfileSchema=async()=>{};
const upsertProfileFromApplication=async()=>{};
const vendorPaymentHistory=async()=>({rows:[]});
const recordManualPayment=async()=>({});
const ensureVendorPaymentColumns=async()=>{};
const pickAreaAttachment=()=>null;
const allAreaAttachments=()=>[];
const blockedRecipients=async()=>new Set();
`;
  const permissions = read('server/permissions.mjs').replace(/^export /gm, '');
  const source = read('netlify/functions/api.mjs').replace(/^import .*;\n/gm, '');
  handlerPromise = import('data:text/javascript;base64,' + Buffer.from(permissions + mocks + source).toString('base64'))
    .then(m => m.default);
  return handlerPromise;
}

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

const post = (action, body) => new Request('http://x/.netlify/functions/api?action=' + action, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {})
});

test('Item 3 (behavioral): bulk action sets ACTIVE categories to 1 only — inactive, overrides and bookings untouched', async () => {
  const db = new PGlite();
  await db.exec('create role anon; create role authenticated; create schema storage; create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);');
  for (const f of ['database/setup.sql', 'database/codify-live-schema.sql', 'database/vendor-credits.sql', 'database/waitlist-offers.sql', 'database/vendor-profiles.sql']) {
    await db.exec(await readFile(join(root, f), 'utf8'));
  }
  const sql = pgliteSql(db);
  globalThis.__sql = sql;

  const [loc] = await sql`insert into market.locations(name,address,indoor_capacity,outdoor_capacity,indoor_price,outdoor_price) values('Hampton Inn Odessa Trinity','11780 State Rd 54',9,3,4500,3500) returning id`;
  const [ev] = await sql`insert into market.events(location_id,date,indoor_capacity,outdoor_capacity,indoor_price,outdoor_price) values(${loc.id},'2027-01-09',9,3,4500,3000) returning id`;
  // Seed state: two active categories off 1 (one of them the 0 = no-cap
  // case), one INACTIVE category off 1, everything else already at 1.
  await sql`update market.categories set vendor_limit=5 where name='Bags'`;
  await sql`update market.categories set vendor_limit=0 where name='Candles'`;
  await sql`update market.categories set active=false, vendor_limit=7 where name='Candy'`;
  const cats = {};
  for (const row of await sql`select id,name from market.categories where name in ('Bags','Candles','Candy')`) cats[row.name] = row.id;
  // A per-date override on Bags and a real held booking carrying the
  // owner's manual invoice reference — both must survive untouched.
  await sql`insert into market.event_category_limits(event_id,category_id,vendor_limit) values(${ev.id},${cats.Bags},4)`;
  const [app] = await sql`insert into market.applications(user_id,name,email,phone,business,description,category_id,photos,agreements) values('22222222-2222-4222-8222-222222222222','Aiyana Hunter','blissfulbakerysd@gmail.com','7028084104','Blissfully Bakery','Small-batch bakery',${cats.Bags},'{}','{}') returning id`;
  const [bk] = await sql`insert into market.bookings(application_id,event_id,space,price,status,invoice_reference) values(${app.id},${ev.id},'outdoor',3000,'held','000823') returning id`;

  const [{ n: expected }] = await sql`select count(*)::int n from market.categories where active and vendor_limit<>1`;
  assert.ok(expected >= 2, 'seed leaves at least Bags + Candles to change');

  const handler = await loadApiHandler();

  // A vendor cannot reach it (same staff gate as the 'category' action).
  globalThis.__who = { id: 'u-vendor', email: 'vendor@x.com', admin: false, manager: false, permissions: [] };
  const denied = await handler(post('categories-set-limit-one'));
  assert.equal(denied.status, 403, 'vendor is stopped at the staff gate');
  const [bagsAfterDeny] = await sql`select vendor_limit from market.categories where id=${cats.Bags}`;
  assert.equal(bagsAfterDeny.vendor_limit, 5, 'denied call changed nothing');

  // The organizer runs it.
  globalThis.__who = { id: 'admin-1', email: 'scottweber332@gmail.com', admin: true };
  const r = await handler(post('categories-set-limit-one'));
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.ok, true);
  assert.equal(body.count, expected, 'returned count = active categories actually changed');

  const [{ bad: stillOff }] = await sql`select count(*)::int bad from market.categories where active and vendor_limit<>1`;
  assert.equal(stillOff, 0, 'every active category is now at 1 per date');
  const [candy] = await sql`select vendor_limit,active from market.categories where id=${cats.Candy}`;
  assert.equal(candy.vendor_limit, 7, 'inactive category untouched');
  assert.equal(candy.active, false, 'inactive category stays inactive');
  const [override] = await sql`select vendor_limit from market.event_category_limits where event_id=${ev.id} and category_id=${cats.Bags}`;
  assert.equal(override.vendor_limit, 4, 'per-date override row untouched');
  const [booking] = await sql`select status,invoice_reference from market.bookings where id=${bk.id}`;
  assert.equal(booking.status, 'held', 'existing booking untouched');
  assert.equal(booking.invoice_reference, '000823', 'booking invoice reference untouched');
  const auditRows = await sql`select actor,(detail->>'count')::int count from market.audit where action='categories set limit one'`;
  assert.equal(auditRows.length, 1, 'exactly one audit row written');
  assert.equal(auditRows[0].actor, 'scottweber332@gmail.com');
  assert.equal(auditRows[0].count, expected, 'audit row records the changed count');

  // Idempotent: a second run changes nothing (rows already at 1 are excluded).
  const again = await handler(post('categories-set-limit-one'));
  assert.equal(again.status, 200);
  assert.equal((await again.json()).count, 0, 'second run is a no-op');
  await db.close();
});
