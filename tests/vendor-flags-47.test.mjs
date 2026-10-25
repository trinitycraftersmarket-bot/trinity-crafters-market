// §47 (revised) — "Eliminate PDF vendor and just make them a client."
// Scott marked Salty Luna Co (PDF-imported) as a regular vendor and saw
// no label: (1) the Directory card's one pill preferred 'PDF imported'
// over the flag, and (2) the flag never persisted at all for imported
// vendors — vendor-save wrote regular_vendor/monthly_billing_amount to
// market.applications only, and the vendor-list query hardcoded both off
// for imported rows. The fix removes the class distinction (no 'PDF
// imported' pill, no PDF filter), makes market.vendor_profiles the flag
// store for imported vendors (applications stay canonical for
// application-sourced vendors), and backfills a profile stub for every
// imported vendor so the store exists.
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
const PROFILES = read('server/profiles.mjs');
const VENDORS = read('public/v2/js/vendors.js');
const PROFILE_SQL = read('database/vendor-profiles.sql');

// ---------------------------------------------------------------- static pins
test('§47: the Directory drops the PDF-imported class (pill + filter)', () => {
  assert.ok(!VENDORS.includes('PDF imported'), 'no PDF-imported wording anywhere in the Directory');
  assert.ok(!VENDORS.includes('value="pdf"'), 'the PDF filter option is gone');
  assert.ok(!VENDORS.includes("filter === 'pdf'"), 'the pdf filter branch is gone');
  assert.ok(VENDORS.includes("${v.regular_vendor ? 'Regular vendor' : 'Vendor'}"), 'the pill is the flag, full stop');
  assert.ok(VENDORS.includes("regular: 'Regular vendors only'"), 'the regular filter label stays');
  assert.ok(VENDORS.includes("if (view.filter === 'regular') return !!v.regular_vendor;"), 'the regular filter reads the flag');
});

test('§47: imported rows read their flags from the profile, vendor-save writes them there', () => {
  assert.ok(!API.includes('false regular_vendor'), 'the hardcoded-off flag is gone from vendor-list');
  assert.ok(API.includes('coalesce((select p.regular_vendor from market.vendor_profiles p'), 'imported regular_vendor comes from the profile');
  assert.ok(API.includes('(select p.monthly_billing_amount from market.vendor_profiles p'), 'imported monthly_billing_amount comes from the profile');
  assert.ok(API.includes('await ensureImportedProfiles(sql);'), 'vendor-list backfills imported profiles');
  assert.ok(API.includes('await saveVendorFlags(sql,{email:p.email'), 'the pdf branch of vendor-save writes the flags to the profile');
  assert.ok(PROFILES.includes('export async function saveVendorFlags'), 'saveVendorFlags exists');
  assert.ok(PROFILES.includes('export async function ensureImportedProfiles'), 'ensureImportedProfiles exists');
  assert.ok(PROFILES.includes('add column if not exists regular_vendor boolean'), 'the lazy schema heal carries the flag column');
  assert.ok(PROFILES.includes('add column if not exists monthly_billing_amount integer'), 'the lazy schema heal carries the amount column');
  assert.ok(PROFILE_SQL.includes('add column if not exists regular_vendor'), 'the canonical schema file carries the flag column');
  assert.ok(PROFILE_SQL.includes('add column if not exists monthly_billing_amount'), 'the canonical schema file carries the amount column');
});

// ---------------------------------------------------------------- behavioral harness
// api.mjs through its real default handler: imports stripped, the real
// server modules it needs inlined (rules → counts → profiles →
// vendor-payments → permissions), core mocked, db = PGlite adapter.
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

let handler, sql, ctx;
test.before(async () => {
  const strip = src => src.replace(/^import .*;\n/gm, '').replace(/^export /gm, '');
  const rules = strip(await readFile(join(root, 'server/rules.mjs'), 'utf8'));
  const counts = strip(await readFile(join(root, 'server/counts.mjs'), 'utf8')) + '\nconst bookingActive = active;\n';
  const profiles = strip(await readFile(join(root, 'server/profiles.mjs'), 'utf8'));
  const payments = strip(await readFile(join(root, 'server/vendor-payments.mjs'), 'utf8'));
  const permissions = strip(await readFile(join(root, 'server/permissions.mjs'), 'utf8'));
  const db = new PGlite();
  await db.exec('create role anon; create role authenticated; create schema storage; create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);');
  for (const f of ['database/setup.sql', 'database/codify-live-schema.sql', 'database/vendor-credits.sql', 'database/waitlist-offers.sql', 'database/vendor-profiles.sql'])
    await db.exec(await readFile(join(root, f), 'utf8'));
  sql = pgliteSql(db);
  const mock = rules + counts + profiles + payments + permissions + `
const ready=()=>true;
const identity=async()=>globalThis.__who;
const db=()=>globalThis.__sql;
const supa=()=>({ auth: { admin: { listUsers: async()=>({data:{users:[]},error:null}) } } });
const publicData=async()=>({}); const flushMail=async()=>{}; const banned=async()=>false;
const expire=async()=>{}; const audit=async()=>{}; const queue=async()=>({}); const isUserError=()=>false;
`;
  let source = await readFile(join(root, 'netlify/functions/api.mjs'), 'utf8');
  source = source.replace(/^import .*;\n/gm, '');
  ({ default: handler } = await import('data:text/javascript;base64,' + Buffer.from(mock + source).toString('base64')));

  globalThis.__sql = sql;
  globalThis.__who = { id: '00000000-0000-0000-0000-0000000000a1', email: 'org@example.com', admin: true, manager: false, permissions: [] };

  const [loc] = await sql`insert into market.locations(name,address,indoor_capacity,outdoor_capacity,indoor_price,outdoor_price) values('Hampton Inn Odessa Trinity','11780 State Rd 54',9,3,4500,3000) returning id`;
  const [ev] = await sql`insert into market.events(location_id,date,indoor_capacity,outdoor_capacity,indoor_price,outdoor_price) values(${loc.id},'2026-11-07',9,3,4500,3000) returning id`;
  const [cat] = await sql`select id from market.categories where name='Handmade Jewelry (No Paparazzi)' limit 1`;
  // The Salty Luna shape: a PDF-imported vendor, email with a stray
  // trailing comma exactly as the PDF roster carries it.
  const [imp] = await sql`insert into market.imported_attendees(event_id,name,business,email,phone,category,space,invoice_amount,payment_status,payment_method,selling) values(${ev.id},'Ashley Paige','Salty Luna Co','saltylunaco@gmail.com,','8137662364','Handmade Jewelry (No Paparazzi)','Inside',0,'paid','cash','Tumblers') returning *`;
  // An application-sourced vendor (the regression side).
  const [app] = await sql`insert into market.applications(user_id,name,email,phone,business,description,category_id,photos,agreements) values(${crypto.randomUUID()},'Vera Verde','verde@example.com','7275550100','Verde Soap','Soaps',${cat.id},'{}','{}') returning *`;
  ctx = { ev, imp, app };
});

const list = async () => {
  const r = await handler(new Request('https://market.test/.netlify/functions/api?action=vendor-list', { method: 'GET' }));
  assert.equal(r.status, 200, 'vendor-list succeeds');
  return r.json();
};
const save = async body => {
  const r = await handler(new Request('https://market.test/.netlify/functions/api?action=vendor-save', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  }));
  assert.equal(r.status, 200, 'vendor-save succeeds: ' + JSON.stringify(body).slice(0, 80));
  return r.json();
};

test('§47: vendor-list is organizer-only', async () => {
  globalThis.__who = { id: 'v1', email: 'vendor@example.com', admin: false, manager: false, permissions: [] };
  const r = await handler(new Request('https://market.test/.netlify/functions/api?action=vendor-list', { method: 'GET' }));
  assert.equal(r.status, 403);
  globalThis.__who = { id: '00000000-0000-0000-0000-0000000000a1', email: 'org@example.com', admin: true, manager: false, permissions: [] };
});

test('§47: an imported vendor starts unflagged and gains a backfilled profile', async () => {
  const rows = await list();
  const v = rows.find(x => String(x.id) === String(ctx.imp.id));
  assert.ok(v, 'the imported vendor is in the Directory');
  assert.equal(v.source, 'pdf', 'the payload still routes payment writes by record kind');
  assert.equal(v.regular_vendor, false, 'not yet marked regular');
  assert.equal(v.monthly_billing_amount, null, 'no monthly amount yet');
  const [profile] = await sql`select * from market.vendor_profiles where email='saltylunaco@gmail.com'`;
  assert.ok(profile, 'the backfill created a profile keyed by the clean email (comma stripped)');
  assert.equal(profile.name, 'Ashley Paige');
  assert.equal(profile.business, 'Salty Luna Co');
  assert.equal(profile.phone, '8137662364');
  assert.ok(profile.category_id, 'the category text resolved to a category row');
  assert.equal(profile.regular_vendor, false);
});

test('§47: the regular flag + monthly amount round-trip for an imported vendor', async () => {
  await save({ id: ctx.imp.id, source: 'pdf', name: 'Ashley Paige', business: 'Salty Luna Co', email: 'saltylunaco@gmail.com', phone: '8137662364', category: 'Handmade Jewelry (No Paparazzi)', regular_vendor: true, monthly_billing_amount: 12500 });
  let rows = await list();
  let v = rows.find(x => String(x.id) === String(ctx.imp.id));
  assert.equal(v.regular_vendor, true, 'the tick stuck — the Directory now reads it back');
  assert.equal(v.monthly_billing_amount, 12500, 'the monthly amount stuck too');
  const [profile] = await sql`select * from market.vendor_profiles where email='saltylunaco@gmail.com'`;
  assert.equal(profile.regular_vendor, true, 'the profile is the store');
  assert.equal(profile.monthly_billing_amount, 12500);
  // And back off again — a round trip, not a one-way latch.
  await save({ id: ctx.imp.id, source: 'pdf', name: 'Ashley Paige', business: 'Salty Luna Co', email: 'saltylunaco@gmail.com', phone: '8137662364', category: 'Handmade Jewelry (No Paparazzi)', regular_vendor: false, monthly_billing_amount: null });
  rows = await list();
  v = rows.find(x => String(x.id) === String(ctx.imp.id));
  assert.equal(v.regular_vendor, false, 'un-ticking persists too');
  assert.equal(v.monthly_billing_amount, null);
});

test('§47: application vendors keep their existing flag behavior', async () => {
  await save({ id: ctx.app.id, source: 'application', name: 'Vera Verde', business: 'Verde Soap', email: 'verde@example.com', phone: '7275550100', category: '', regular_vendor: true, monthly_billing_amount: 9000 });
  const rows = await list();
  const v = rows.find(x => String(x.id) === String(ctx.app.id));
  assert.ok(v, 'the application vendor is in the Directory');
  assert.equal(v.regular_vendor, true, 'application flags still round-trip via market.applications');
  assert.equal(v.monthly_billing_amount, 9000);
  const [appRow] = await sql`select regular_vendor, monthly_billing_amount from market.applications where id=${ctx.app.id}`;
  assert.equal(appRow.regular_vendor, true, 'the application row itself carries the flag (canonical store unchanged)');
});

test('§47: the backfill is idempotent across Directory loads', async () => {
  await list();
  await list();
  const rows = await sql`select count(*)::int n from market.vendor_profiles where email='saltylunaco@gmail.com'`;
  assert.equal(rows[0].n, 1, 'exactly one profile per imported vendor, however often the list loads');
});
