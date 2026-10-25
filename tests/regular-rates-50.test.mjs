// §50 — Regular-vendor rates (Oct 25, 2026). Scott: "all regular
// vendors pay 40 for Trinity Crafters Market and 60 for Lutz" —
// $40 indoor at Hampton Inn, $60 indoor at Hilton Garden Inn, vs
// standard $45 / $100. The rate is DATA (locations.regular_indoor_
// price, seeded by venue match, edited in Setup → Locations) and it
// prices NEW work only: applications (apply + recover), monthly-
// invoice create-from-bookings charges, manual bookings, credit
// redemptions, and the move-space reprice (audit B4's hardcoded
// $45/$30 is gone — the event's own prices rule, regulars get their
// rate). Existing bookings/invoices are never repriced. Outdoor has
// no regular rate: regulars pay standard outdoor (documented
// assumption — Scott has not set one).
import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = p => readFileSync(join(root, p), 'utf8');
const PRICING = read('server/pricing.mjs');
const API = read('netlify/functions/api.mjs');
const MONTHLY = read('netlify/functions/monthly-invoices.mjs');
const MANUAL = read('netlify/functions/manual-booking.mjs');
const MOVESPACE = read('netlify/functions/move-space.mjs');
const CREDIT = read('netlify/functions/vendor-credit.mjs');
const SETUP = read('public/v2/js/setup.js');
const MANUALBOOKING = read('public/v2/js/manualbooking.js');
const SCHEMA = read('database/codify-live-schema.sql');

// ---------------------------------------------------------------- static pins
test('§50: the pricing module owns the rate math and never reprices stored rows', () => {
  assert.ok(PRICING.includes('export async function ensureLocationRegularPrice'), 'the locations heal exists');
  assert.ok(PRICING.includes('export async function isRegularVendor'), 'the flag resolver exists');
  assert.ok(PRICING.includes('export async function regularAwarePrice'), 'the price helper exists');
  assert.ok(PRICING.includes("like '%hampton%'") && PRICING.includes('4000'), 'the Hampton seed is $40');
  assert.ok(PRICING.includes("like '%hilton%'") && PRICING.includes('6000'), 'the Hilton seed is $60');
  assert.ok(PRICING.includes('regular_indoor_price is null'), 'the seed only fills unset prices (an edited rate is never overwritten)');
  // Negative control: pricing NEW work only — the module must not
  // write stored amounts anywhere.
  assert.ok(!/update market\.(bookings|vendor_invoices|imported_attendees)/.test(PRICING), 'pricing never updates stored bookings/invoices/attendees');
  assert.ok(!/insert into market\.(bookings|vendor_invoices)/.test(PRICING), 'pricing never creates bookings/invoices');
});

test('§50: the rate is codified schema (alter + venue seeds)', () => {
  assert.ok(SCHEMA.includes('alter table market.locations add column if not exists regular_indoor_price integer'), 'codified column');
  assert.ok(SCHEMA.includes('set regular_indoor_price = 4000'), 'codified Hampton seed');
  assert.ok(SCHEMA.includes('set regular_indoor_price = 6000'), 'codified Hilton seed');
});

test('§50: the location save carries the rate, validated, preserve-on-omit', () => {
  assert.ok(API.includes('ensureLocationRegularPrice(sql)'), 'the location action heals the column');
  assert.ok(API.includes("throw Error('Check the regular indoor price.')"), 'a bad rate is refused');
  assert.ok(API.includes("'regular_indoor_price' in p"), 'an omitted key preserves the stored rate');
  assert.ok(API.includes('regular_indoor_price=${regularPrice}'), 'the update writes the rate');
  assert.ok(SETUP.includes('name="regular_indoor_price"'), 'Setup → Locations has the field');
  assert.ok(SETUP.includes('regular_indoor_price: String(f.get(\'regular_indoor_price\''), 'the location form submits it (blank = null)');
  assert.ok(SETUP.includes('Regular vendors: indoor'), 'the location card shows the rate');
});

test('§50: every covered pricing path routes through the helper', () => {
  assert.ok(API.includes('const regularVendor=await isRegularVendor(tx,{email:u.email});'), 'apply resolves the flag once');
  assert.ok(API.includes('const bookingPrice=await regularAwarePrice(tx,'), 'apply prices with the helper');
  assert.ok(API.includes('const regularVendor=await isRegularVendor(tx,{email:attempt.email});'), 'recover-application resolves the flag');
  assert.ok(MONTHLY.includes('const priceOf=x=>'), 'create-from-bookings prices per row');
  assert.ok(MONTHLY.includes('regularIndoorPriceFor(sql,x.location_id)'), 'create reads the location rate');
  assert.ok(MANUAL.includes('regularAwarePrice(sql,{locationId:event.location_id'), 'manual booking defaults price with the helper');
  assert.ok(MANUAL.includes("p.payment_method!=='credit card'&&p.space==='Inside'"), 'the untouched-amount substitution never touches GoDaddy-verified card bookings');
  assert.ok(CREDIT.includes('const regular=await isRegularVendor(sql,{email:u.email});'), 'credit eligibility resolves the flag');
  assert.ok((CREDIT.match(/regularAwarePrice\(/g) || []).length >= 2, 'eligibility AND redeem both price with the helper');
});

test('§50 (B4): move-space no longer hardcodes $45/$30', () => {
  assert.ok(!MOVESPACE.includes("space==='indoor'?45:30"), 'the hardcoded reprice is gone');
  assert.ok(MOVESPACE.includes('regularAwarePrice(tx,{locationId:e.location_id'), 'the reprice reads the event prices + regular rate');
  assert.ok(MOVESPACE.includes('indoor_price,outdoor_price,location_id from market.events'), 'the event select carries its real prices');
});

test('§50: the manual-booking form prices a selected regular vendor at their rate', () => {
  assert.ok(MANUALBOOKING.includes('data-regular="${e.regular_indoor_price ?? \'\'}"'), 'each date row carries the venue regular rate');
  assert.ok(MANUALBOOKING.includes('selectedRegular = v.regular_vendor === true'), 'selecting a vendor carries their flag');
  assert.ok(MANUALBOOKING.includes('Regular vendor rate applied.'), 'the form says when the rate is applied');
  assert.ok(MANUAL.includes('v.regular_vendor=v.email?await isRegularVendor(sql,{email:v.email}):false'), 'the vendor search flags regulars');
  assert.ok(MANUAL.includes('l.regular_indoor_price'), 'the base data carries each event venue rate');
});

// ---------------------------------------------------------------- harnesses
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

// ------------------------------------------------- pricing units (direct)
test('§50 (behavioral): the helpers — seeds, flag union, rate matrix, edits', async () => {
  const db = new PGlite();
  await db.exec(`create schema market;
    create table market.locations(id uuid primary key default gen_random_uuid(), name text, market_name text);
    create table market.applications(id uuid primary key default gen_random_uuid(), email text, regular_vendor boolean not null default false);
    create table market.vendor_profiles(id uuid primary key default gen_random_uuid(), email text unique, regular_vendor boolean not null default false);`);
  const sql = pgliteSql(db);
  const pricing = await import('../server/pricing.mjs');
  const [hampton] = await sql`insert into market.locations(name, market_name) values('Hampton Inn Odessa Trinity', 'Trinity Crafters Market') returning *`;
  const [hilton] = await sql`insert into market.locations(name, market_name) values('Hilton Garden Inn Suncoast', 'Trinity Crafters Market') returning *`;
  const [hall] = await sql`insert into market.locations(name, market_name) values('Community Hall', 'Trinity Crafters Market') returning *`;

  // Venue-match seeds land on first use; the unmatched venue stays unset.
  assert.equal(await pricing.regularIndoorPriceFor(sql, hampton.id), 4000, 'Hampton seeds $40');
  assert.equal(await pricing.regularIndoorPriceFor(sql, hilton.id), 6000, 'Hilton seeds $60');
  assert.equal(await pricing.regularIndoorPriceFor(sql, hall.id), null, 'an unmatched venue has no regular rate');

  const P = (loc, space, regular) => pricing.regularAwarePrice(sql, { locationId: loc, space, indoorPrice: 4500, outdoorPrice: 3000, regular });
  assert.equal(await P(hampton.id, 'indoor', true), 4000, 'regular indoor at Hampton = $40');
  assert.equal(await P(hilton.id, 'indoor', true), 6000, 'regular indoor at Hilton = $60');
  assert.equal(await P(hampton.id, 'indoor', false), 4500, 'non-regular indoor = standard');
  assert.equal(await P(hampton.id, 'outdoor', true), 3000, 'regular outdoor = standard outdoor (no regular outdoor rate set)');
  assert.equal(await P(hall.id, 'indoor', true), 4500, 'regular at a venue with no rate = standard (negative control)');

  // Flag union: application store, profile store, neither.
  await sql`insert into market.applications(email, regular_vendor) values('apps@x.com', true), ('plain@x.com', false)`;
  await sql`insert into market.vendor_profiles(email, regular_vendor) values('prof@x.com', true)`;
  assert.equal(await pricing.isRegularVendor(sql, { email: 'apps@x.com' }), true, 'flag via an application row');
  assert.equal(await pricing.isRegularVendor(sql, { email: 'prof@x.com' }), true, 'flag via the profile store');
  assert.equal(await pricing.isRegularVendor(sql, { email: 'plain@x.com' }), false, 'no flag anywhere = not regular');
  const [appRow] = await sql`select id from market.applications where email='apps@x.com'`;
  assert.equal(await pricing.isRegularVendor(sql, { applicationId: appRow.id }), true, 'flag via the application id directly');

  // Editing the rate changes subsequent pricing; the seed never
  // overwrites an edited value.
  await sql`update market.locations set regular_indoor_price = 4200 where id = ${hampton.id}`;
  assert.equal(await P(hampton.id, 'indoor', true), 4200, 'an edited rate prices subsequent work');
  await pricing.ensureLocationRegularPrice(sql);
  const [after] = await sql`select regular_indoor_price from market.locations where id = ${hampton.id}`;
  assert.equal(after.regular_indoor_price, 4200, 're-running the heal keeps the edited rate');
});

// --------------------------------------- api harness (apply + location)
// api.mjs through its real handler (the §47 assembly, extended with
// the waitlist/twins/pricing modules the apply path touches).
let apiHandler, apiSql, apiCtx;
test.before(async () => {
  const rules = strip(await readFile(join(root, 'server/rules.mjs'), 'utf8'));
  const counts = strip(await readFile(join(root, 'server/counts.mjs'), 'utf8')) + '\nconst bookingActive = active;\n';
  const profiles = strip(await readFile(join(root, 'server/profiles.mjs'), 'utf8'));
  const payments = strip(await readFile(join(root, 'server/vendor-payments.mjs'), 'utf8'));
  const permissions = strip(await readFile(join(root, 'server/permissions.mjs'), 'utf8'));
  const pricing = strip(await readFile(join(root, 'server/pricing.mjs'), 'utf8'));
  const twins = strip(await readFile(join(root, 'server/twins.mjs'), 'utf8'));
  const waitlist = strip(await readFile(join(root, 'server/waitlist.mjs'), 'utf8'));
  const db = new PGlite();
  await db.exec('create role anon; create role authenticated; create schema storage; create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);');
  for (const f of ['database/setup.sql', 'database/codify-live-schema.sql', 'database/vendor-credits.sql', 'database/waitlist-offers.sql', 'database/vendor-profiles.sql'])
    await db.exec(await readFile(join(root, f), 'utf8'));
  apiSql = pgliteSql(db);
  const mock = rules + counts + profiles + payments + permissions + pricing + twins + waitlist + `
const ready=()=>true;
const identity=async()=>globalThis.__who;
const identityWithBan=identity;
const db=()=>globalThis.__sql;
const supa=()=>({ auth: { admin: { listUsers: async()=>({data:{users:[]},error:null}) } } });
const publicData=async()=>({}); const flushMail=async()=>{}; const banned=async()=>false;
const expire=async()=>{}; const audit=async()=>{}; const queue=async()=>({});
const isUserError=e=>!!e&&e.name==='Error'&&typeof e.message==='string'&&e.message.length>0&&e.code===undefined;
const decisionEmail=()=>({subject:'',body:''}); const syncCalendar=async()=>({});
const pickAreaAttachment=async()=>null; const allAreaAttachments=async()=>[]; const blockedRecipients=async()=>[];
`;
  let source = await readFile(join(root, 'netlify/functions/api.mjs'), 'utf8');
  source = source.replace(/^import .*;\n/gm, '');
  ({ default: apiHandler } = await import('data:text/javascript;base64,' + Buffer.from(mock + source).toString('base64')));
  globalThis.__sql = apiSql;

  // Venues: standard prices Hampton 4500/3000, Hilton 10000/3500.
  // regular_indoor_price starts unset — the §50 heal seeds it.
  const [hampton] = await apiSql`insert into market.locations(name,address,indoor_capacity,outdoor_capacity,indoor_price,outdoor_price) values('Hampton Inn Odessa Trinity','11780 State Rd 54',9,3,4500,3000) returning id`;
  const [hilton] = await apiSql`insert into market.locations(name,address,indoor_capacity,outdoor_capacity,indoor_price,outdoor_price) values('Hilton Garden Inn Suncoast','1400 Suncoast Pkwy',36,2,10000,3500) returning id`;
  const mkEvent = async (loc, date) => (await apiSql`insert into market.events(location_id,date,indoor_capacity,outdoor_capacity,indoor_price,outdoor_price,open) values(${loc},${date},9,3,${loc === hampton.id ? 4500 : 10000},3000,true) returning id`)[0];
  const events = {
    hamptonA: await mkEvent(hampton.id, '2027-01-09'), hamptonB: await mkEvent(hampton.id, '2027-02-20'),
    hamptonC: await mkEvent(hampton.id, '2027-03-20'), hamptonD: await mkEvent(hampton.id, '2027-04-17'),
    hiltonA: await mkEvent(hilton.id, '2027-01-23')
  };
  const [cat] = await apiSql`select id from market.categories where name='Handmade Jewelry (No Paparazzi)' limit 1`;
  await apiSql`update market.categories set vendor_limit = 0 where id = ${cat.id}`;
  apiCtx = { hampton, hilton, events, cat };
});

const apiPost = (action, body) => apiHandler(new Request('https://market.test/.netlify/functions/api?action=' + action, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }));
const AGREEMENTS = { nonrefundable: true, rain: true, nomlm: true, facebook: true, stayuntil3: true, hurricane: true, paymentready: true, contract: true, signature: 'Test Vendor' };
async function applyAs(email, dates) {
  const uid = crypto.randomUUID();
  globalThis.__who = { id: uid, email, admin: false, manager: false, permissions: [] };
  const res = await apiPost('apply', {
    name: 'Test Vendor', business: 'Test Business', description: 'Handmade jewelry and gifts',
    referral_source: 'Friend', phone: '7275550100', category: apiCtx.cat.id,
    photos: [uid + '/photo.jpg'], agreements: AGREEMENTS, dates
  });
  assert.equal(res.status, 200, 'apply succeeds for ' + email + ': ' + JSON.stringify(await res.clone().json()).slice(0, 200));
  return res.json();
}
const bookingPrice = async (email, eventId) => {
  const [b] = await apiSql`select b.price from market.bookings b join market.applications a on a.id = b.application_id where lower(a.email) = ${email} and b.event_id = ${eventId} limit 1`;
  return b?.price;
};

test('§50 (behavioral): apply prices a regular vendor at 4000 Hampton / 6000 Hilton, standard otherwise', async () => {
  // The regular flag lives on the vendor's PRIOR application (the
  // canonical store) — a returning regular's new application prices
  // at their rate from the first booking.
  await apiSql`insert into market.applications(user_id,name,email,phone,business,description,category_id,photos,agreements,regular_vendor) values(${crypto.randomUUID()},'Reg Ular','regular@x.com','7275550101','Reg Co','Jewelry',${apiCtx.cat.id},'{}','{}',true)`;
  await applyAs('regular@x.com', [{ id: apiCtx.events.hamptonA.id, space: 'indoor' }, { id: apiCtx.events.hiltonA.id, space: 'indoor' }]);
  assert.equal(await bookingPrice('regular@x.com', apiCtx.events.hamptonA.id), 4000, 'regular indoor at Hampton = $40, not $45');
  assert.equal(await bookingPrice('regular@x.com', apiCtx.events.hiltonA.id), 6000, 'regular indoor at Hilton = $60, not $100');

  await applyAs('newbie@x.com', [{ id: apiCtx.events.hamptonB.id, space: 'indoor' }]);
  assert.equal(await bookingPrice('newbie@x.com', apiCtx.events.hamptonB.id), 4500, 'non-regular indoor at Hampton = standard $45 (negative control)');

  await applyAs('regular@x.com', [{ id: apiCtx.events.hamptonC.id, space: 'outdoor' }]);
  assert.equal(await bookingPrice('regular@x.com', apiCtx.events.hamptonC.id), 3000, 'regular OUTDOOR = standard outdoor $30 (no regular outdoor rate)');
});

test('§50 (behavioral): the location save writes the rate; later pricing follows it; omitting preserves it', async () => {
  globalThis.__who = { id: crypto.randomUUID(), email: 'org@example.com', admin: true, manager: false, permissions: [] };
  const base = { name: 'Hampton Inn Odessa Trinity', address: '11780 State Rd 54', indoor_capacity: 9, outdoor_capacity: 3, indoor_price: 4500, outdoor_price: 3000 };
  let res = await apiPost('location', { ...base, id: apiCtx.hampton.id, regular_indoor_price: 4200 });
  assert.equal(res.status, 200, 'location save with a rate succeeds');
  let [loc] = await apiSql`select regular_indoor_price from market.locations where id = ${apiCtx.hampton.id}`;
  assert.equal(loc.regular_indoor_price, 4200, 'the rate is stored');

  // A save that omits the key must not clear the stored rate.
  res = await apiPost('location', { ...base, id: apiCtx.hampton.id });
  assert.equal(res.status, 200);
  [loc] = await apiSql`select regular_indoor_price from market.locations where id = ${apiCtx.hampton.id}`;
  assert.equal(loc.regular_indoor_price, 4200, 'omitting the field preserves the rate');

  await applyAs('regular@x.com', [{ id: apiCtx.events.hamptonD.id, space: 'indoor' }]);
  assert.equal(await bookingPrice('regular@x.com', apiCtx.events.hamptonD.id), 4200, 'new pricing follows the edited rate');

  // A bad rate is refused with the specific message. (applyAs leaves
  // the identity as the vendor — restore the organizer first.)
  globalThis.__who = { id: crypto.randomUUID(), email: 'org@example.com', admin: true, manager: false, permissions: [] };
  res = await apiPost('location', { ...base, id: apiCtx.hampton.id, regular_indoor_price: -5 });
  assert.equal(res.status, 400);
  assert.ok((await res.json()).error.includes('regular indoor price'), 'the refusal names the field');
});

test('§50 (behavioral): an existing booking is never repriced by later rate work', async () => {
  const before = await bookingPrice('newbie@x.com', apiCtx.events.hamptonB.id);
  globalThis.__who = { id: crypto.randomUUID(), email: 'org@example.com', admin: true, manager: false, permissions: [] };
  await apiPost('location', { name: 'Hampton Inn Odessa Trinity', address: '11780 State Rd 54', indoor_capacity: 9, outdoor_capacity: 3, indoor_price: 4500, outdoor_price: 3000, id: apiCtx.hampton.id, regular_indoor_price: 4100 });
  assert.equal(await bookingPrice('newbie@x.com', apiCtx.events.hamptonB.id), before, 'the stored booking price is untouched');
  assert.equal(before, 4500);
});

// --------------------------------- monthly-invoices create-from-bookings
let miHandler, miSql, miSeq = 0;
const miNid = () => '00000000-0000-4000-8000-' + String(++miSeq).padStart(12, '0');
test.before(async () => {
  let source = await readFile(join(root, 'netlify/functions/monthly-invoices.mjs'), 'utf8');
  source = source.replace(/^import .*;\n/gm, '');
  const pricing = strip(await readFile(join(root, 'server/pricing.mjs'), 'utf8'));
  const mock = `
const db=()=>globalThis.__miSql;
const identity=async()=>globalThis.__miWho;
const queue=async(tx,to,subject,body,htmlBody=null)=>{const id=globalThis.__miUuid();await globalThis.__miDb.query('insert into market.outbox(id,recipient,subject,body,html_body) values($1,$2,$3,$4,$5)',[id,to,subject,body,htmlBody]);return {id};};
const flushMail=async()=>{await globalThis.__miDb.query('update market.outbox set sent_at=now() where sent_at is null and error is null');};
const audit=async()=>{};
`;
  ({ default: miHandler } = await import('data:text/javascript;base64,' + Buffer.from(mock + pricing + source).toString('base64')));
  const db = new PGlite();
  await db.exec(`create schema market;
    create table market.vendors(id uuid primary key, email text);
    create table market.vendor_invoices(
      id uuid primary key default gen_random_uuid(), vendor_id uuid, vendor_email text, vendor_name text, business text,
      billing_period text, amount integer not null default 0, discount integer not null default 0,
      late_fee integer not null default 0, items jsonb, due_date date, status text not null default 'draft',
      payment_method text, payment_reference text, payment_comment text, cancel_reason text,
      cancelled_at timestamptz, paid_at timestamptz, sent_at timestamptz,
      created_at timestamptz not null default now(), updated_at timestamptz not null default now());
    create unique index vendor_invoices_email_period_key on market.vendor_invoices(lower(vendor_email), billing_period);
    create table market.vendor_payments(
      id uuid primary key default gen_random_uuid(), monthly_invoice_id uuid, vendor_id uuid,
      application_id uuid, booking_id uuid, imported_attendee_id uuid, amount integer not null,
      payment_method text, paid_at timestamptz, note text, recorded_by text,
      receipt_sent_at timestamptz, created_at timestamptz not null default now());
    create table market.outbox(
      id uuid primary key, recipient text, subject text, body text, html_body text,
      attachments jsonb, sent_at timestamptz, error text, created_at timestamptz not null default now());
    create table market.applications(
      id uuid primary key, name text, business text, email text,
      billing_day integer, billing_notes text, monthly_billing_active boolean not null default false,
      regular_vendor boolean not null default false);
    create table market.vendor_profiles(
      id uuid primary key default gen_random_uuid(), email text unique, regular_vendor boolean not null default false);
    create table market.locations(id uuid primary key, name text, market_name text);
    create table market.events(id uuid primary key, date date, location_id uuid);
    create table market.bookings(
      id uuid primary key, application_id uuid, event_id uuid, space text,
      price integer not null default 0, status text not null default 'approved');`);
  miSql = pgliteSql(db);
  globalThis.__miSql = miSql;
  globalThis.__miDb = db;
  globalThis.__miWho = { admin: true, email: 'organizer@test' };
  globalThis.__miUuid = miNid;
});
const miPost = (action, body) => miHandler(new Request('https://market.test/.netlify/functions/monthly-invoices?action=' + action, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }));

async function miSeedVendor(email, regular, bookings) {
  const appId = miNid(), locH = miNid(), locG = miNid(), locHall = miNid();
  await miSql`insert into market.applications(id,name,business,email,monthly_billing_active,regular_vendor) values(${appId},'Test Vendor','Test Co',${email},true,${regular})`;
  await miSql`insert into market.locations(id,name) values(${locH},'Hampton Inn Odessa Trinity'),(${locG},'Hilton Garden Inn Suncoast'),(${locHall},'Community Hall')`;
  for (const b of bookings) {
    const ev = miNid(), loc = b.at === 'hilton' ? locG : b.at === 'hall' ? locHall : locH;
    await miSql`insert into market.events(id,date,location_id) values(${ev},${b.date},${loc})`;
    await miSql`insert into market.bookings(id,application_id,event_id,space,price,status) values(${miNid()},${appId},${ev},'indoor',${b.price},'approved')`;
  }
  return appId;
}

test('§50 (behavioral): create-from-bookings charges a regular vendor 40+40+60, not the stored 45s', async () => {
  // Ken-shaped: three November bookings stored at the standard $45 —
  // the NEW invoice charge prices at his regular rate (40+40+60=140).
  const appId = await miSeedVendor('ken@test', true, [
    { date: '2026-11-07', price: 4500 }, { date: '2026-11-21', price: 4500 }, { date: '2026-11-28', at: 'hilton', price: 4500 }
  ]);
  const res = await miPost('create', { vendor_id: appId, billing_period: '2026-11' });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.invoice.amount, 14000, 'the new charge totals $140 at regular rates');
  assert.deepEqual(body.invoice.items.map(i => i.amount).sort((a, b) => a - b), [4000, 4000, 6000], 'per-date amounts are the regular rates');
  for (const it of body.invoice.items) assert.equal(it.market_dates[0].amount, it.amount, 'the §41 per-date stamp carries the same rate');
  // The stored bookings keep their original price — no repricing.
  const rows = await miSql`select price from market.bookings where application_id = ${appId}`;
  assert.ok(rows.every(r => r.price === 4500), 'existing bookings are NOT repriced');
});

test('§50 (behavioral): create-from-bookings leaves non-regulars and unrated venues at the stored price', async () => {
  const plain = await miSeedVendor('plain@test', false, [{ date: '2026-11-07', price: 4500 }]);
  let body = await (await miPost('create', { vendor_id: plain, billing_period: '2026-11' })).json();
  assert.equal(body.invoice.amount, 4500, 'non-regular pays the stored (standard) price');

  const hall = await miSeedVendor('hall@test', true, [{ date: '2026-11-07', at: 'hall', price: 4500 }]);
  body = await (await miPost('create', { vendor_id: hall, billing_period: '2026-11' })).json();
  assert.equal(body.invoice.amount, 4500, 'regular at a venue with NO regular rate falls back to the stored price (negative control)');
});

// ------------------------------------------------------- manual booking
let mbHandler, mbSql, mbSeq = 0;
const mbNid = () => '00000000-0000-4000-8000-' + String(++mbSeq).padStart(12, '0');
test.before(async () => {
  let source = await readFile(join(root, 'netlify/functions/manual-booking.mjs'), 'utf8');
  source = source.replace(/^import .*;\n/gm, '');
  const pricing = strip(await readFile(join(root, 'server/pricing.mjs'), 'utf8'));
  const mock = `
const db=()=>globalThis.__mbSql;
const identity=async()=>globalThis.__mbWho;
const queue=async(tx,to,subject,body,htmlBody=null)=>{const id=globalThis.__mbUuid();await globalThis.__mbDb.query('insert into market.outbox(id,recipient,subject,body,html_body) values($1,$2,$3,$4,$5)',[id,to,subject,body,htmlBody]);return {id};};
const flushMail=async()=>{await globalThis.__mbDb.query('update market.outbox set sent_at=now() where sent_at is null and error is null');};
const audit=async()=>{};
`;
  ({ default: mbHandler } = await import('data:text/javascript;base64,' + Buffer.from(mock + pricing + source).toString('base64')));
  const db = new PGlite();
  await db.exec(`create schema market;
    create table market.locations(id uuid primary key default gen_random_uuid(), name text, market_name text, address text, indoor_capacity integer, outdoor_capacity integer, indoor_price integer, outdoor_price integer);
    create table market.events(id uuid primary key default gen_random_uuid(), location_id uuid, date date, title text, start_time time, end_time time, indoor_price integer, outdoor_price integer);
    create table market.categories(id uuid primary key default gen_random_uuid(), name text, active boolean not null default true);
    create table market.vendors(id uuid primary key default gen_random_uuid(), name text, business text, email text, phone text, description text, category_id uuid);
    create table market.applications(id uuid primary key default gen_random_uuid(), name text, business text, email text, phone text, description text, category_id uuid, created_at timestamptz not null default now(), regular_vendor boolean not null default false);
    create table market.bookings(id uuid primary key default gen_random_uuid(), application_id uuid, event_id uuid, status text, hold_until timestamptz);
    create table market.vendor_profiles(id uuid primary key default gen_random_uuid(), email text unique, regular_vendor boolean not null default false);
    create table market.imported_attendees(
      id uuid primary key default gen_random_uuid(), event_id uuid, name text, business text, email text, phone text,
      category text, category_id uuid, category_sold_out boolean, space text, source_file text, attendance_state text,
      payment_status text, invoice_amount integer, selling text, payment_method text, payment_reference text,
      approval_code text, card_brand text, card_last4 text, payment_processor_status text,
      paid_at timestamptz, payment_recorded_at timestamptz, payment_recorded_by text,
      vendor_id uuid, cancelled boolean not null default false, created_at timestamptz not null default now());
    create table market.outbox(
      id uuid primary key, recipient text, subject text, body text, html_body text,
      attachments jsonb, sent_at timestamptz, error text, created_at timestamptz not null default now());
    insert into market.categories(name) values('Other');`);
  mbSql = pgliteSql(db);
  globalThis.__mbSql = mbSql;
  globalThis.__mbDb = db;
  globalThis.__mbWho = { admin: true, email: 'organizer@test' };
  globalThis.__mbUuid = mbNid;
  // Venues + future dates (one event per booking case: the duplicate
  // guard keys on vendor+event).
  const [hampton] = await mbSql`insert into market.locations(name, market_name, address, indoor_price, outdoor_price) values('Hampton Inn Odessa Trinity', 'Trinity Crafters Market', '11780 State Rd 54', 4500, 3000) returning id`;
  const [hilton] = await mbSql`insert into market.locations(name, market_name, address, indoor_price, outdoor_price) values('Hilton Garden Inn Suncoast', 'Trinity Crafters Market', '1400 Suncoast Pkwy', 10000, 3500) returning id`;
  const ev = async (loc, date, ip, op) => (await mbSql`insert into market.events(location_id, date, title, indoor_price, outdoor_price) values(${loc}, ${date}, 'Trinity Crafters Market', ${ip}, ${op}) returning id`)[0];
  globalThis.__mbEvents = {
    h1: await ev(hampton.id, '2027-01-09', 4500, 3000), h2: await ev(hampton.id, '2027-02-20', 4500, 3000),
    h3: await ev(hampton.id, '2027-03-20', 4500, 3000), h4: await ev(hampton.id, '2027-04-17', 4500, 3000),
    h5: await ev(hampton.id, '2027-05-15', 4500, 3000), g1: await ev(hilton.id, '2027-01-23', 10000, 3500)
  };
  // Ashley-shaped regular: the flag lives on her profile (imported store).
  await mbSql`insert into market.vendor_profiles(email, regular_vendor) values('salty@test.com', true)`;
});
const mbPost = body => mbHandler(new Request('https://market.test/.netlify/functions/manual-booking', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }));
const mbBook = (eventId, email, extra = {}) => mbPost({ name: 'Test Vendor', business: 'Test Co', email, phone: '7275550199', selling: 'Tumblers', event_id: eventId, space: 'Inside', payment_method: 'cash', ...extra });

test('§50 (behavioral): manual booking prices a regular vendor at their rate — default, untouched, override', async () => {
  const E = globalThis.__mbEvents;
  let body = await (await mbBook(E.h1.id, 'salty@test.com')).json();
  assert.equal(body.amount, 4000, 'no amount sent → the regular rate is computed ($40 Hampton)');
  body = await (await mbBook(E.h2.id, 'salty@test.com', { amount: 45 })).json();
  assert.equal(body.amount, 4000, 'the untouched standard prefill ($45) is replaced by the regular rate');
  body = await (await mbBook(E.h3.id, 'salty@test.com', { amount: 50 })).json();
  assert.equal(body.amount, 5000, 'a hand-edited amount stands — $50 override is NOT substituted (negative control)');
  body = await (await mbBook(E.g1.id, 'salty@test.com')).json();
  assert.equal(body.amount, 6000, 'regular at Hilton = $60');
  body = await (await mbBook(E.h4.id, 'salty@test.com', { space: 'Outside' })).json();
  assert.equal(body.amount, 3000, 'regular Outside = standard outdoor $30');
  body = await (await mbBook(E.h5.id, 'walkin@test.com')).json();
  assert.equal(body.amount, 4500, 'non-regular Inside = standard $45 (negative control)');
  const [row] = await mbSql`select invoice_amount from market.imported_attendees where email = 'salty@test.com' order by created_at limit 1`;
  assert.equal(row.invoice_amount, 4000, 'the stored booking carries the regular rate');
});

test('§50 (behavioral): manual booking base data + vendor search carry the regular rate/flag', async () => {
  const get = qs => mbHandler(new Request('https://market.test/.netlify/functions/manual-booking' + qs, { method: 'GET' }));
  const base = await (await get('')).json();
  const h = base.events.find(e => e.id === globalThis.__mbEvents.h1.id);
  assert.equal(h.regular_indoor_price, 4000, 'the form data carries the venue regular rate (seeded by the heal)');
  await mbSql`insert into market.imported_attendees(event_id, name, business, email, phone, category, space, invoice_amount, payment_status, selling) values(${globalThis.__mbEvents.h1.id}, 'Ashley Paige', 'Salty Luna Co', 'salty@test.com', '8137662364', 'Other', 'Inside', 4000, 'paid', 'Tumblers')`;
  const found = await (await get('?q=salty')).json();
  const v = found.vendors.find(x => x.email === 'salty@test.com');
  assert.ok(v, 'the search finds the vendor');
  assert.equal(v.regular_vendor, true, 'the search flags her regular — the form prices her rate');
});

// ---------------------------------------------------------- move-space
let msHandler, msSql;
test.before(async () => {
  let source = await readFile(join(root, 'netlify/functions/move-space.mjs'), 'utf8');
  source = source.replace(/^import .*;\n/gm, '');
  const rules = strip(await readFile(join(root, 'server/rules.mjs'), 'utf8'));
  const counts = strip(await readFile(join(root, 'server/counts.mjs'), 'utf8')) + '\nconst bookingActive = active;\n';
  const twins = strip(await readFile(join(root, 'server/twins.mjs'), 'utf8'));
  const pricing = strip(await readFile(join(root, 'server/pricing.mjs'), 'utf8'));
  const mock = `
const db=()=>globalThis.__msSql;
const identity=async()=>globalThis.__msWho;
const audit=async()=>{};
const isUserError=e=>!!e&&e.name==='Error'&&typeof e.message==='string';
`;
  ({ default: msHandler } = await import('data:text/javascript;base64,' + Buffer.from(mock + rules + counts + twins + pricing + source).toString('base64')));
  const db = new PGlite();
  await db.exec(`create schema market;
    create table market.locations(id uuid primary key default gen_random_uuid(), name text, market_name text);
    create table market.events(id uuid primary key default gen_random_uuid(), location_id uuid, indoor_capacity integer, outdoor_capacity integer, indoor_price integer, outdoor_price integer);
    create table market.applications(id uuid primary key default gen_random_uuid(), email text, phone text, business text, name text, vendor_id uuid, category_id uuid, regular_vendor boolean not null default false);
    create table market.vendor_profiles(id uuid primary key default gen_random_uuid(), email text unique, regular_vendor boolean not null default false);
    create table market.bookings(id uuid primary key default gen_random_uuid(), application_id uuid, event_id uuid, space text, price integer, status text, hold_until timestamptz);
    create table market.imported_attendees(id uuid primary key default gen_random_uuid(), event_id uuid, space text, email text, phone text, business text, name text, vendor_id uuid, category_id uuid, cancelled boolean not null default false, invoice_amount integer);`);
  msSql = pgliteSql(db);
  globalThis.__msSql = msSql;
  globalThis.__msWho = { admin: true, email: 'organizer@test' };
});
const msPost = body => msHandler(new Request('https://market.test/.netlify/functions/move-space', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }));

test('§50 (behavioral, B4): move-space reprices from the EVENT prices — regulars at their rate', async () => {
  const [loc] = await msSql`insert into market.locations(name) values('Hampton Inn Odessa Trinity') returning id`;
  // This event's indoor price is $50 — NOT the old hardcoded $45.
  const [ev] = await msSql`insert into market.events(location_id, indoor_capacity, outdoor_capacity, indoor_price, outdoor_price) values(${loc.id}, 9, 3, 5000, 2800) returning id`;
  const mkBooking = async (email, regular, space, price) => {
    const [app] = await msSql`insert into market.applications(email, phone, business, name, regular_vendor) values(${email}, '7275550100', 'Co', 'Vendor', ${regular}) returning id`;
    const [b] = await msSql`insert into market.bookings(application_id, event_id, space, price, status) values(${app.id}, ${ev.id}, ${space}, ${price}, 'paid') returning id`;
    return b;
  };
  const priceOfRow = async id => (await msSql`select price, space from market.bookings where id = ${id}`)[0];

  const reg = await mkBooking('regmove@test', true, 'outdoor', 2800);
  let res = await msPost({ id: reg.id, space: 'indoor' });
  assert.equal(res.status, 200, 'the regular move succeeds: ' + JSON.stringify(await res.clone().json()).slice(0, 160));
  assert.equal((await priceOfRow(reg.id)).price, 4000, 'regular moved indoors pays the $40 regular rate — not $45 hardcode, not the $50 standard');

  const plain = await mkBooking('plainmove@test', false, 'outdoor', 2800);
  res = await msPost({ id: plain.id, space: 'indoor' });
  assert.equal(res.status, 200);
  assert.equal((await priceOfRow(plain.id)).price, 5000, 'non-regular moved indoors pays the EVENT price $50 — the B4 hardcode is dead (negative control)');

  res = await msPost({ id: reg.id, space: 'outdoor' });
  assert.equal(res.status, 200);
  assert.equal((await priceOfRow(reg.id)).price, 2800, 'moved back outdoors pays the event outdoor price');
});

// ------------------------------------------- vendor-credit (real module)
// The exported functions take the sql handle directly (the
// vendor-credit.test.mjs pattern), against the repo schema files.
test('§50 (behavioral): credit eligibility + redemption price at the regular rate', async () => {
  const db = new PGlite();
  await db.exec('create role anon; create role authenticated; create schema storage; create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);');
  for (const f of ['database/setup.sql', 'database/codify-live-schema.sql', 'database/vendor-credits.sql', 'database/waitlist-offers.sql', 'database/vendor-profiles.sql'])
    await db.exec(await readFile(join(root, f), 'utf8'));
  const sql = pgliteSql(db);
  const vc = await import('../netlify/functions/vendor-credit.mjs');
  const day = n => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);
  const [hampton] = await sql`insert into market.locations(name, address, indoor_capacity, outdoor_capacity, indoor_price, outdoor_price) values('Hampton Inn Odessa Trinity', '11780 State Rd 54', 9, 3, 4500, 3000) returning id`;
  const [hilton] = await sql`insert into market.locations(name, address, indoor_capacity, outdoor_capacity, indoor_price, outdoor_price) values('Hilton Garden Inn Suncoast', '1400 Suncoast Pkwy', 36, 2, 10000, 3500) returning id`;
  const [cat] = await sql`select id from market.categories where name = 'Bags'`;
  await sql`update market.categories set vendor_limit = 10 where id = ${cat.id}`;
  const [srcEvent] = await sql`insert into market.events(location_id, date, indoor_capacity, outdoor_capacity, indoor_price, outdoor_price) values(${hampton.id}, ${day(10)}, 9, 3, 4500, 3000) returning *`;
  const [hamptonEvent] = await sql`insert into market.events(location_id, date, indoor_capacity, outdoor_capacity, indoor_price, outdoor_price) values(${hampton.id}, ${day(30)}, 9, 3, 4500, 3000) returning *`;
  const [hiltonEvent] = await sql`insert into market.events(location_id, date, indoor_capacity, outdoor_capacity, indoor_price, outdoor_price) values(${hilton.id}, ${day(40)}, 36, 2, 10000, 3500) returning *`;

  const mkCredit = async email => {
    const [src] = await sql`insert into market.imported_attendees(event_id, name, business, email, phone, category, category_id, space, payment_status, invoice_amount, selling) values(${srcEvent.id}, 'Vendor', 'Co', ${email}, '7275550100', 'Bags', ${cat.id}, 'Inside', 'paid', 8000, 'Bags') returning id`;
    const [credit] = await sql`insert into market.vendor_credits(email, category_id, source_type, source_id, source_event_id, original_amount, remaining_amount, issued_by) values(${email}, ${cat.id}, 'imported', ${src.id}, ${srcEvent.id}, 8000, 8000, 'test') returning *`;
    return credit;
  };
  // A regular vendor (profile store) holding an $80 credit.
  await sql`insert into market.vendor_profiles(email, regular_vendor) values('regcred@test', true)`;
  const regCredit = await mkCredit('regcred@test');
  const eligible = await vc.eligibleEvents(sql, regCredit, { email: 'regcred@test' });
  const hiltonOffer = eligible.find(e => e.id === hiltonEvent.id);
  assert.ok(hiltonOffer, 'Hilton is offered to the regular vendor');
  assert.deepEqual(hiltonOffer.spaces.find(s => s.space === 'indoor'), { space: 'indoor', price: 6000 }, 'Hilton indoor prices at the $60 regular rate — the $100 standard would exceed the $80 credit (negative control built in)');

  const redeemed = await vc.redeemCredit(sql, { credit_id: regCredit.id, event_id: hamptonEvent.id, space: 'indoor' }, { email: 'regcred@test' });
  assert.equal(redeemed.remaining, 4000, 'the redemption burns the $40 regular rate from the $80 credit');
  const [row] = await sql`select invoice_amount from market.imported_attendees where id = ${redeemed.booking_id}`;
  assert.equal(row.invoice_amount, 4000, 'the new booking records the regular rate');

  // Negative control: a non-regular with the same $80 credit is NOT
  // offered Hilton indoor at all ($100 standard > $80 credit).
  const plainCredit = await mkCredit('plaincred@test');
  const plainEligible = await vc.eligibleEvents(sql, plainCredit, { email: 'plaincred@test' });
  const plainHilton = plainEligible.find(e => e.id === hiltonEvent.id);
  assert.ok(!plainHilton || !plainHilton.spaces.some(s => s.space === 'indoor'), 'non-regular is not offered Hilton indoor — standard pricing unchanged');
});
