// §58 — Record payment on the Invoice Center, for every kind (Nov 3, 2026).
// Scott, looking at the Money → Invoices screen: "Need a way to record
// payments on the invoice screen." His example card — Simply Shanka,
// $90, OVERDUE 32 days, chip "monthly", Due Oct 1, "Payment: GoDaddy
// Invoice" — rendered NO action buttons at all. Diagnosis (code-proven
// in AUDIT.md §58): the row is a monthly invoice whose status is
// 'cancelled' (set through the Monthly Billing status dropdown, whose
// 'update' action — unlike the dedicated cancel action — keeps
// due_date and payment_method). actionsHtml's monthly branch returns ''
// for status 'cancelled', while money.js invoiceRows had NO cancelled
// filter, so a cancelled invoice (due $0 in Monthly Billing and in the
// monthly-invoices totals) posed as a live $90 overdue receivable.
// §58: (1) money.js + reports.js AR exclude cancelled monthly invoices;
// (2) imported cards gain a real Record payment form wired to the
// vendor-payment pdf branch (the Attendees panel's exact call) — before
// §58 they had only the status toggle, which writes no ledger row;
// (3) all three Invoice Center sheets carry a Date paid (default today),
// threaded to vendor-payment's existing paid_at and to a minimal
// optional paid_at on monthly-invoices record-payment.
import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = p => readFileSync(join(root, p), 'utf8');
const INVOICES = read('public/v2/js/invoices.js');
const ATTENDEES = read('public/v2/js/attendees.js');
const MONEY = read('public/v2/js/money.js');
const REPORTS = read('public/v2/js/reports.js');
const MI = read('netlify/functions/monthly-invoices.mjs');

// ---------------------------------------------------------------- static pins
test('§58: cancelled monthly invoices are not receivables in money.js or reports AR', () => {
  assert.ok(MONEY.includes("String(x.status || '').toLowerCase() !== 'cancelled'"), 'invoiceRows filters cancelled monthly invoices');
  assert.ok(REPORTS.includes("x.status !== 'paid' && String(x.status || '').toLowerCase() !== 'cancelled'"), 'reports arRows filters them too (the AR surfaces agree)');
});

test('§58: every Invoice Center record-payment sheet carries amount, method and Date paid', () => {
  assert.ok(INVOICES.includes('function paySheet'), 'regular sheet exists');
  assert.ok(INVOICES.includes('function monthlyPaySheet'), 'monthly sheet exists');
  assert.ok(INVOICES.includes('function importedPaySheet'), 'imported sheet exists (§58)');
  assert.equal((INVOICES.match(/name="paid_at" type="date"/g) || []).length, 3, 'all three sheets carry a Date paid input');
  assert.ok(INVOICES.includes('paid_at: paidAtIso(f.get(\'paid_at\'))'), 'booking/imported sheets send paid_at to vendor-payment');
  assert.ok(INVOICES.includes("paid_at: String(f.get('paid_at') || todayET())"), 'the monthly sheet sends the picked date to record-payment');
});

test('§58: the imported form is wired to the vendor-payment pdf branch, same payload as Attendees', () => {
  assert.ok(INVOICES.includes('data-act="imp-record"'), 'Record payment button on unpaid imported cards');
  assert.ok(INVOICES.includes("source: 'pdf', imported_attendee_id: x.id"), 'the sheet posts the pdf branch payload');
  assert.ok(INVOICES.includes("act === 'imp-record'"), 'the click handler opens the sheet');
  const opts = s => (s.match(/<label class="sheet-field">Payment method<select name="payment_method">(.+?)<\/select>/) || [])[1];
  assert.ok(opts(INVOICES) && opts(INVOICES) === opts(ATTENDEES), 'the method set is identical to the existing vendor-payment sheet (Attendees)');
});

test('§58: monthly record-payment accepts an optional paid_at, defaulting to now()', () => {
  assert.ok(MI.includes('p.paid_at'), 'the action reads paid_at');
  assert.ok(MI.includes("paidAt=pd+'T16:00:00.000Z'"), 'the picked day becomes mid-afternoon UTC (the vendor-payments convention)');
  assert.ok(MI.includes('coalesce(${paidAt}::timestamptz,now())'), 'absent a date the insert still stamps now() — Monthly Billing unchanged');
  assert.ok(MI.includes('paid_at:pay.paid_at'), 'the audit records the effective paid_at');
});

// ------------------------------------------------- behavioral: invoiceRows
test('§58 (behavioral): a cancelled monthly invoice never becomes an Invoice Center row', async () => {
  const { invoiceRows, invoiceStats } = await import('../public/v2/js/money.js');
  const admin = {
    applications: [], allEvents: [], events: [],
    importedAttendees: [
      { id: 'imp-1', business: 'Imported Biz', name: 'Imp Vendor', email: 'imp@test', invoice_amount: 5000, payment_status: 'unpaid', payment_method: 'GoDaddy Invoice', invoice_due_date: null, event_id: 'ev-1' }
    ],
    monthlyInvoices: [
      // The Simply Shanka shape, field for field: cancelled through the
      // billing status dropdown, which keeps due_date + the method.
      { id: 'mi-cancelled', business: 'Simply Shanka', vendor_name: 'Tanya Stead', vendor_email: 'simplyshanka@gmail.com', billing_period: '2026-10', status: 'cancelled', amount: 9000, discount: 0, late_fee: 0, paid_total: 0, due_date: '2026-10-01', payment_method: 'GoDaddy Invoice', payments: [] },
      { id: 'mi-open', business: 'Open Monthly', vendor_name: 'Olive', vendor_email: 'olive@test', billing_period: '2026-10', status: 'emailed', amount: 13500, discount: 0, late_fee: 0, paid_total: 4500, due_date: '2026-10-01', sent_at: '2026-10-01T12:00:00Z', payments: [] },
      { id: 'mi-paid', business: 'Paid Monthly', vendor_name: 'Pam', vendor_email: 'pam@test', billing_period: '2026-10', status: 'paid', amount: 6000, discount: 0, late_fee: 0, paid_total: 6000, due_date: '2026-10-01', payments: [] }
    ]
  };
  const rows = invoiceRows(admin);
  assert.ok(!rows.some(x => x.id === 'mi-cancelled'), 'the cancelled invoice produces no card');
  assert.ok(rows.some(x => x.id === 'mi-open' && x.kind === 'monthly' && x.amount === 9000), 'the open monthly row owes its balance');
  assert.ok(rows.some(x => x.id === 'imp-1' && x.kind === 'imported' && x.amount === 5000), 'the imported row is present');
  const stats = invoiceStats(rows);
  assert.equal(stats.outstanding, 14000, 'outstanding = imported $50 + monthly balance $90 — the cancelled $90 is not in it');
  assert.equal(stats.outstandingCount, 2);
  assert.equal(stats.overdue, 9000, 'only the genuinely open monthly invoice is overdue');
  assert.equal(stats.overdueCount, 1);
  assert.equal(stats.monthlyUnsent, 0, 'a cancelled invoice is not counted as an unsent monthly invoice');
});

// ------------------------------- behavioral: monthly record-payment paid_at
// monthly-invoices.mjs through its real default handler (the §49
// harness): imports stripped, core mocked.
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
  ({ default: handler } = await import('data:text/javascript;base64,' + Buffer.from(mock + source).toString('base64')));
  db = new PGlite();
  await db.exec(`create schema market;
    create table market.vendors(id uuid primary key, email text);
    create table market.vendor_invoices(
      id uuid primary key, vendor_id uuid, vendor_email text, vendor_name text, business text,
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
      attachments jsonb, sent_at timestamptz, error text, created_at timestamptz not null default now());`);
  sql = pgliteSql(db);
  globalThis.__sql = sql;
  globalThis.__db = db;
  globalThis.__who = { admin: true, email: 'organizer@test' };
  globalThis.__uuid = nid;
  globalThis.__audits = [];
});

const post = (action, body) => handler(new Request('https://market.test/.netlify/functions/monthly-invoices?action=' + action, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }));
const dayOf = v => new Date(v).toISOString().slice(0, 10);

test('§58 (behavioral): record-payment honors the picked date — partial, then paid in full', async () => {
  const id = nid();
  await sql`insert into market.vendor_invoices(id,vendor_email,vendor_name,business,billing_period,amount,items,status,due_date)
    values(${id},'simplyshanka@gmail.com','Tanya Stead','Simply Shanka','2026-10',9000,${sql.json([{ description: 'October Bill', amount: 9000 }])},'emailed','2026-10-01')`;
  let res = await post('record-payment', { id, amount: 40, payment_method: 'GoDaddy Invoice', paid_at: '2026-10-20', comment: 'Paid via GoDaddy' });
  assert.equal(res.status, 200);
  let body = await res.json();
  assert.equal(body.invoice.status, 'partial', 'a $40 payment against $90 leaves the invoice partial');
  assert.equal(body.invoice.paid_total, 4000);
  assert.equal(body.payment.recorded_by, 'organizer@test', 'recorded-by is captured');
  assert.equal(dayOf(body.payment.paid_at), '2026-10-20', 'the ledger row carries the picked date, not today');
  const auditEntry = globalThis.__audits.find(([a]) => a === 'monthly invoice payment recorded');
  assert.ok(auditEntry, 'the payment audits');
  assert.equal(dayOf(auditEntry[1].paid_at), '2026-10-20', 'the audit records the effective paid_at');

  res = await post('record-payment', { id, amount: 50, payment_method: 'Cash', paid_at: '2026-11-02' });
  body = await res.json();
  assert.equal(body.invoice.status, 'paid', 'the settling payment closes the invoice');
  assert.equal(body.invoice.paid_total, 9000);
  assert.equal(dayOf(body.payment.paid_at), '2026-11-02');
});

test('§58 (behavioral): no date still stamps now(); an impossible date is refused and records nothing', async () => {
  const id = nid();
  await sql`insert into market.vendor_invoices(id,vendor_email,vendor_name,business,billing_period,amount,items,status)
    values(${id},'olive@test','Olive','Open Monthly','2026-11',4500,${sql.json([{ description: 'November Bill', amount: 4500 }])},'emailed')`;
  let res = await post('record-payment', { id, amount: 45, payment_method: 'Cash' });
  assert.equal(res.status, 200, 'the pre-§58 call shape (no paid_at) still works');
  let body = await res.json();
  assert.ok(body.payment.paid_at, 'paid_at is stamped');
  assert.equal(dayOf(body.payment.paid_at), dayOf(new Date().toISOString()), 'and it is today');

  // A fresh invoice with a balance left, so the date check is the thing
  // that refuses — not the already-paid guard.
  const id2 = nid();
  await sql`insert into market.vendor_invoices(id,vendor_email,vendor_name,business,billing_period,amount,items,status)
    values(${id2},'olive@test','Olive','Open Monthly','2026-11',9000,${sql.json([{ description: 'November Bill', amount: 9000 }])},'emailed')`;
  res = await post('record-payment', { id: id2, amount: 40, payment_method: 'Cash', paid_at: '2026-02-30' });
  assert.equal(res.status, 400, 'Feb 30 is not a date');
  body = await res.json();
  assert.ok(String(body.error).includes('date paid'), 'the refusal names the date problem, got: ' + body.error);
  const rows = await sql`select * from market.vendor_payments where monthly_invoice_id=${id2}`;
  assert.equal(rows.length, 0, 'the refused payment never lands');
});
