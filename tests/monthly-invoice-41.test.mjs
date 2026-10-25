// §41 — Per-date charge amounts on monthly invoices (Oct 24, 2026).
// Scott, watching Ashley's $100 November charge print as "$33.33 × 3":
// "it says each charge is split evenly, it should be what the charge is
// per market. The total is the same but $33.33 per date isn't right" +
// "add a space to fix itemized items." Her real split is $60 / $40 / $0
// (60 = Hilton regular rate, 40 = Hampton regular rate, third date free).
//
// Design (AUDIT.md §41): each entry of an item's market_dates gains its
// own `amount`, stored in CENTS — the same unit as the item amount it
// belongs to (the spec's "(dollars…)" aside contradicts the code; items
// have always stored cents: add-bill/edit-item multiply dollars × 100,
// create copies booking prices, which are cents). Presence = the key
// exists and is a finite number, INCLUDING $0 — a free date must print
// $0.00, so presence is never truthiness. Renderers (the print html()
// rows and the email action's plain-text lines) use the entry amount
// when present, else the legacy even split. PRESERVATION IS
// LOAD-BEARING: every item-rewriting path (server edit-item /
// delete-item / update, both client sheets) carries market_dates with
// amounts through untouched; the server edit-item additionally accepts
// `date_amounts` (dollars, index-aligned, the client input convention)
// and then the charge amount becomes the SUM of its dates.
// create-from-bookings stamps each entry with that date's actual
// booking amount; add-bill leaves entries amount-less.
import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = p => readFileSync(join(root, p), 'utf8');
const SRC = read('netlify/functions/monthly-invoices.mjs');
const BILLING = read('public/v2/js/billing.js');
const INVOICES = read('public/v2/js/invoices.js');

// ---------------------------------------------------------------- static pins
test('§41: renderers resolve per-date amounts through one presence-aware helper', () => {
  assert.ok(SRC.includes('entryAmount'), 'a shared per-date amount helper exists');
  assert.ok(/m\.amount!==undefined&&m\.amount!==null/.test(SRC), 'presence is key-exists, never truthiness ($0 is a real amount)');
  assert.ok(SRC.includes('Number.isFinite(Number(m.amount))'), 'presence requires a finite number');
  // The even split survives ONLY as the legacy fallback inside the helper.
  const splits = SRC.match(/Math\.round\(Number\(x\.amount\|\|0\)\/dates\.length\)/g) || [];
  assert.equal(splits.length, 1, 'exactly one even-split expression remains — the fallback inside the helper');
});

test('§41: edit-item accepts date_amounts and sums them into the charge', () => {
  assert.ok(SRC.includes('date_amounts'), 'edit-item reads the per-date payload');
  assert.ok(SRC.includes('must match the number of market dates'), 'a misaligned date_amounts payload is refused, not half-applied');
  assert.ok(SRC.includes('items[idx]=dates?{...items[idx],description:desc,amount:amt,market_dates:dates}'), 'the edited item is rebuilt with its stamped entries');
  assert.ok(SRC.includes('amt=cents.reduce((a,v)=>a+v,0)'), 'the charge amount becomes the sum of its dates');
});

test('§41: create-from-bookings stamps each market_dates entry with the booking amount', () => {
  // §50: the stamped amount is priceOf(x) — the booking's price, with
  // the regular-rate override for regular-flagged vendors (§50 tests
  // pin priceOf itself; the §41 contract is the one-entry stamp).
  assert.ok(SRC.includes('market_dates:[{id:x.event_id,date:x.date,location:x.location,amount:priceOf(x)}]'), 'create stamps a one-entry market_dates with the booking price (via §50 priceOf)');
});

test('§41: add-bill leaves market_dates entries amount-less (legacy even split until edited)', () => {
  assert.ok(SRC.includes('market_dates:marketDates.map(e=>({id:e.id,date:e.date,location:e.location,market_name:e.market_name}))'), 'add-bill entry shape is unchanged — no amount key');
});

test('§41: the billing Edit Charges sheet carries per-date inputs and sends date_amounts', () => {
  assert.ok(BILLING.includes('data-item-date-amount'), 'per-date amount inputs render in the sheet');
  assert.ok(BILLING.includes('date_amounts'), 'the billing save payload carries date_amounts');
  assert.ok(BILLING.includes('splitPreview'), 'prefill falls back to the even split for legacy entries');
  assert.ok(BILLING.includes('(free)'), 'a $0 date is labelled free, not blank');
});

test('§41: the Invoice Center editItemSheet carries the same per-date inputs', () => {
  assert.ok(INVOICES.includes('editItemSheet'), 'the Invoice Center has a monthly item editor');
  assert.ok(INVOICES.includes('data-item-date-amount'), 'per-date amount inputs render there too');
  assert.ok(INVOICES.includes('date_amounts'), 'its save payload carries date_amounts');
  assert.ok(INVOICES.includes('data-act="mi-edit"'), 'monthly cards offer Edit charges');
});

// ---------------------------------------------------------------- behavioral harness
// monthly-invoices.mjs through its real default handler (the §40/§49
// harness): imports stripped, core mocked — queue writes a REAL PGlite
// outbox row; flushMail stamps sent_at.
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

let handler, db, sql, seq = 0;
const nid = () => '00000000-0000-4000-8000-' + String(++seq).padStart(12, '0');

test.before(async () => {
  let source = await readFile(join(root, 'netlify/functions/monthly-invoices.mjs'), 'utf8');
  source = source.replace(/^import .*;\n/gm, '');
  const mock = `
const db=()=>globalThis.__sql;
const identity=async()=>globalThis.__who;
const queue=async(tx,to,subject,body,htmlBody=null)=>{const id=globalThis.__uuid();await globalThis.__db.query('insert into market.outbox(id,recipient,subject,body,html_body) values($1,$2,$3,$4,$5)',[id,to,subject,body,htmlBody]);return {id};};
const flushMail=async()=>{await globalThis.__db.query('update market.outbox set sent_at=now() where sent_at is null and error is null');};
const audit=async(tx,u,action,detail)=>{globalThis.__audits.push([action,detail]);};
`;
  // §50: monthly-invoices imports server/pricing.mjs for create's
  // regular-rate override — inline it (import-free by design).
  const pricing = (await readFile(join(root, 'server/pricing.mjs'), 'utf8')).replace(/^export /gm, '');
  ({ default: handler } = await import('data:text/javascript;base64,' + Buffer.from(mock + pricing + source).toString('base64')));

  db = new PGlite();
  await db.exec(`create schema market;
    create table market.vendors(id uuid primary key, email text);
    create table market.vendor_invoices(
      id uuid primary key default gen_random_uuid(), vendor_id uuid, vendor_email text, vendor_name text, business text,
      billing_period text, amount integer not null default 0, discount integer not null default 0,
      late_fee integer not null default 0, items jsonb, due_date date, status text not null default 'draft',
      payment_method text, payment_reference text, payment_comment text, cancel_reason text,
      cancelled_at timestamptz, paid_at timestamptz, sent_at timestamptz,
      created_at timestamptz not null default now(), updated_at timestamptz not null default now());
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
      id uuid primary key default gen_random_uuid(), email text unique,
      regular_vendor boolean not null default false);
    create unique index vendor_invoices_email_period_key on market.vendor_invoices(lower(vendor_email), billing_period);
    create table market.locations(id uuid primary key, name text, market_name text);
    create table market.events(id uuid primary key, date date, location_id uuid);
    create table market.bookings(
      id uuid primary key, application_id uuid, event_id uuid, space text,
      price integer not null default 0, status text not null default 'approved');`);
  sql = pgliteSql(db);
  globalThis.__sql = sql;
  globalThis.__db = db;
  globalThis.__who = { admin: true, email: 'organizer@test' };
  globalThis.__uuid = nid;
  globalThis.__audits = [];
});

const post = (action, body) => handler(new Request('https://market.test/.netlify/functions/monthly-invoices?action=' + action, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }));
const get = qs => handler(new Request('https://market.test/.netlify/functions/monthly-invoices' + qs, { method: 'GET' }));
const invoiceRow = async id => (await sql`select * from market.vendor_invoices where id=${id}`)[0];

// Ashley-shaped: one $100 charge over three November dates whose real
// per-date amounts are 6000 / 4000 / 0 (cents) — $60 Hilton, $40
// Hampton, third date free.
const ASHLEY_DATES = [
  { id: 'ev-hilton', date: '2026-11-28', location: 'Hilton Garden Inn Suncoast', amount: 6000 },
  { id: 'ev-hampton-1', date: '2026-11-07', location: 'Hampton Inn Odessa Trinity', amount: 4000 },
  { id: 'ev-hampton-2', date: '2026-11-21', location: 'Hampton Inn Odessa Trinity', amount: 0 }
];
async function seedAshley(withAmounts = true) {
  const id = nid();
  const email = 'ashley' + seq + '@test'; // unique per seed: the (email, period) unique index is real
  const dates = ASHLEY_DATES.map(d => withAmounts ? d : (({ amount, ...rest }) => rest)(d));
  await sql`insert into market.vendor_invoices(id,vendor_email,vendor_name,business,billing_period,amount,items,status)
    values(${id},${email},'Ashley Paige','Salty Luna Co','2026-11',10000,${sql.json([{ type: 'manual', description: 'November Bill', amount: 10000, market_dates: dates }])},'draft')`;
  return { id, email };
}

test('§41 (behavioral): the printed invoice renders 60/40/0 verbatim — the free date prints $0.00', async () => {
  const { id } = await seedAshley(true);
  const res = await get('?action=print&id=' + id);
  assert.equal(res.status, 200);
  const page = await res.text();
  assert.ok(page.includes('$60.00'), 'the Hilton date prints its real $60');
  assert.ok(page.includes('$40.00'), 'the Hampton date prints its real $40');
  assert.ok(page.includes('$0.00'), 'the free date prints $0.00 — presence is not truthiness');
  assert.ok(!page.includes('$33.33'), 'no even-split fiction remains');
});

test('§41 (behavioral): the invoice email plain text carries the same per-date amounts', async () => {
  const { id, email } = await seedAshley(true);
  const res = await post('email', { id });
  assert.equal(res.status, 200);
  const [mail] = await sql`select * from market.outbox where recipient=${email} order by created_at desc limit 1`;
  assert.ok(mail, 'the invoice email was queued');
  assert.ok(mail.body.includes('$60.00'), 'email line for the Hilton date');
  assert.ok(mail.body.includes('$40.00'), 'email line for the Hampton date');
  assert.ok(mail.body.includes('$0.00'), 'email line for the free date');
  assert.ok(!mail.body.includes('$33.33'), 'no even split in the email either');
  assert.ok(mail.body.includes('(1 of 3)') && mail.body.includes('(3 of 3)'), 'the (n of N) labeling stays');
  assert.ok(mail.html_body.includes('$60.00') && !mail.html_body.includes('$33.33'), 'the html part renders the same amounts');
});

test('§41 (behavioral): a legacy item (no entry amounts) still splits evenly', async () => {
  const { id } = await seedAshley(false);
  const res = await get('?action=print&id=' + id);
  const page = await res.text();
  assert.ok(page.includes('$33.33'), 'legacy rows keep the even-split display');
  const [item] = (await invoiceRow(id)).items;
  assert.ok(item.market_dates.every(d => !('amount' in d)), 'rendering never writes amounts back into a legacy item');
});

test('§41 (behavioral): edit-item without date_amounts preserves market_dates byte-for-byte', async () => {
  const { id } = await seedAshley(true);
  const before = (await invoiceRow(id)).items;
  const res = await post('edit-item', { id, index: 0, description: 'November markets', amount: 100 });
  assert.equal(res.status, 200);
  const after = (await invoiceRow(id)).items;
  assert.equal(after[0].description, 'November markets', 'the edit itself landed');
  assert.deepEqual(after[0].market_dates, before[0].market_dates, 'market_dates — amounts included — survive an ordinary save untouched');
  // Negative control: the same assertion must FAIL against a stripped
  // item, proving the deepEqual above can actually catch the loss.
  const stripped = [{ ...after[0], market_dates: after[0].market_dates.map(({ amount, ...rest }) => rest) }];
  assert.notDeepEqual(stripped[0].market_dates, before[0].market_dates, 'control: dropping entry amounts changes the value');
});

test('§41 (behavioral): edit-item with date_amounts stamps the entries and the charge becomes their sum', async () => {
  const { id } = await seedAshley(false);
  // The organizer fixes the itemized amounts (dollars in, like the
  // lump amount); the lump field still says 135 — the dates win.
  const res = await post('edit-item', { id, index: 0, description: 'November Bill', amount: 135, date_amounts: [60, 40, 0] });
  assert.equal(res.status, 200);
  const row = await invoiceRow(id);
  const [item] = row.items;
  assert.deepEqual(item.market_dates.map(d => d.amount), [6000, 4000, 0], 'entries are stamped in cents, $0 included');
  assert.equal(item.amount, 10000, 'the charge amount is the SUM of its dates, not the typed lump');
  assert.equal(row.amount, 10000, 'the invoice total follows the sum');
  assert.equal(item.market_dates[0].location, 'Hilton Garden Inn Suncoast', 'non-amount entry fields are preserved');
  const page = await (await get('?action=print&id=' + id)).text();
  assert.ok(page.includes('$60.00') && page.includes('$0.00') && !page.includes('$33.33'), 'the saved split is what prints');
});

test('§41 (behavioral): a misaligned date_amounts payload is refused and changes nothing', async () => {
  const { id } = await seedAshley(true);
  const res = await post('edit-item', { id, index: 0, description: 'November Bill', amount: 100, date_amounts: [50, 50] });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.ok(body.error.includes('must match the number of market dates'), 'the refusal names the problem');
  const [item] = (await invoiceRow(id)).items;
  assert.deepEqual(item.market_dates.map(d => d.amount), [6000, 4000, 0], 'a refused save leaves the stored entries untouched');
  assert.equal(item.amount, 10000, 'and the charge amount untouched');
});

test('§41 (behavioral): delete-item and update never strip per-date amounts', async () => {
  const id = nid();
  await sql`insert into market.vendor_invoices(id,vendor_email,vendor_name,business,billing_period,amount,items,status)
    values(${id},'multi@test','Multi Vendor','Multi Biz','2026-11',12500,${sql.json([
      { type: 'manual', description: 'November Bill', amount: 10000, market_dates: ASHLEY_DATES },
      { type: 'manual', description: 'Extra date', amount: 2500, market_dates: [{ id: 'ev-x', date: '2026-11-14', location: 'Hampton Inn Odessa Trinity', amount: 2500 }] }
    ])},'draft')`;
  let res = await post('update', { id, discount: 0, status: 'draft', payment_method: '', comment: '' });
  assert.equal(res.status, 200);
  let items = (await invoiceRow(id)).items;
  assert.deepEqual(items[0].market_dates, ASHLEY_DATES, 'update (the discount/status save) leaves items alone');
  res = await post('delete-item', { id, index: 1 });
  assert.equal(res.status, 200);
  items = (await invoiceRow(id)).items;
  assert.equal(items.length, 1, 'the second charge is gone');
  assert.deepEqual(items[0].market_dates, ASHLEY_DATES, 'the surviving charge keeps its per-date amounts');
  assert.equal((await invoiceRow(id)).amount, 10000, 'the total recomputes from the surviving charge');
});

test('§41 (behavioral): create-from-bookings stamps real per-date amounts (Ashley-shaped 6000/4000/0)', async () => {
  const appId = nid(), locHampton = nid(), locHilton = nid();
  await sql`insert into market.applications(id,name,business,email,monthly_billing_active) values(${appId},'Ashley Paige','Salty Luna Co','saltylunaco@gmail.com',true)`;
  await sql`insert into market.locations(id,name) values(${locHampton},'Hampton Inn Odessa Trinity'),(${locHilton},'Hilton Garden Inn Suncoast')`;
  const ev = async (date, loc) => { const e = nid(); await sql`insert into market.events(id,date,location_id) values(${e},${date},${loc})`; return e; };
  const bk = async (eventId, price) => { const b = nid(); await sql`insert into market.bookings(id,application_id,event_id,space,price,status) values(${b},${appId},${eventId},'Indoor',${price},'approved')`; return b; };
  await bk(await ev('2026-11-28', locHilton), 6000);
  await bk(await ev('2026-11-07', locHampton), 4000);
  await bk(await ev('2026-11-21', locHampton), 0);
  const res = await post('create', { vendor_id: appId, billing_period: '2026-11' });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.invoice.amount, 10000, 'the total is the real sum — the free date adds $0');
  const items = body.invoice.items;
  assert.equal(items.length, 3, 'one charge per booking');
  for (const it of items) {
    assert.equal(it.market_dates.length, 1, 'each created charge carries its market_dates entry');
    assert.equal(it.market_dates[0].amount, it.amount, 'the entry is stamped with that date\u2019s actual booking amount');
    assert.equal(it.market_dates[0].date, it.date, 'the entry is that booking\u2019s date');
  }
  assert.deepEqual(items.map(i => i.amount).sort((a, b) => a - b), [0, 4000, 6000], 'the real 6000/4000/0 split, not 3333×3');
  const page = await (await get('?action=print&id=' + body.invoice.id)).text();
  assert.ok(page.includes('$60.00') && page.includes('$40.00') && page.includes('$0.00'), 'the created invoice prints the real amounts, free date included');
});

test('§41 (behavioral): add-bill entries stay amount-less and render the even split until edited', async () => {
  const evA = nid(), evB = nid(), loc = nid();
  await sql`insert into market.locations(id,name) values(${loc},'Hampton Inn Odessa Trinity')`;
  await sql`insert into market.events(id,date,location_id) values(${evA},'2026-11-07',${loc}),(${evB},'2026-11-21',${loc})`;
  const res = await post('add-bill', { vendor_email: 'legacy@test', vendor_name: 'Legacy Vendor', description: 'November Bill', amount: 90, billing_period: '2026-11', event_ids: [evA, evB] });
  assert.equal(res.status, 200);
  const body = await res.json();
  const [item] = body.invoice.items;
  assert.equal(item.market_dates.length, 2);
  assert.ok(item.market_dates.every(d => !('amount' in d)), 'add-bill stamps no per-date amounts');
  const page = await (await get('?action=print&id=' + body.invoice.id)).text();
  assert.ok(page.includes('$45.00'), 'the even split shows until the organizer itemizes');
});
