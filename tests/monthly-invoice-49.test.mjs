// §49 — Partial payments on monthly invoices (Oct 24, 2026). Ken Miller
// owes $135 for November (3 markets × $45) and pays one market's fee in
// person at the current market — $45 at a time. Before §49 a monthly
// invoice was binary (unpaid → paid); there was no way to record $45
// received against $135 with $90 still owed.
// Design (documented in AUDIT.md §49): payments are rows in the shared
// vendor_payments ledger linked by monthly_invoice_id; paid_so_far is
// always the ledger sum; balance = total − paid_so_far. Status gains a
// stored 'partial', recomputed from the ledger whenever payments or
// totals change on an invoice that has payments; invoices with no
// ledger payments keep the manual status flow (a card-marked 'paid' is
// never demoted). Overpayment is refused with the balance in the
// message. Receipts go through §40's queue → flush → outbox-readback
// pattern: "sent" is claimed only on confirmed delivery, and
// receipt_sent_at stamps from the delivery row. The feature ships in
// BOTH screens: Monthly Billing (billing.js) and the Invoice Center
// (invoices.js), over the same server actions and ledger. AR amounts
// (money.js rows, reports.js arRows, system-tools) show the balance.
// Addendum: the Reports Payment Report flattens the same ledger
// payments into its reconciliation rows (tagged by billing period), so
// monthly-invoice money is no longer invisible there.
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
const API = read('netlify/functions/api.mjs');
const TOOLS = read('netlify/functions/system-tools.mjs');
const BILLING = read('public/v2/js/billing.js');
const INVOICES = read('public/v2/js/invoices.js');
const MONEY = read('public/v2/js/money.js');
const REPORTS = read('public/v2/js/reports.js');
const SCHEMA = read('database/codify-live-schema.sql');

// ---------------------------------------------------------------- static pins
test('§49: the three payment actions exist with the overpay guard and verified receipt', () => {
  assert.ok(SRC.includes("action==='record-payment'"), 'record-payment action');
  assert.ok(SRC.includes("action==='delete-payment'"), 'delete-payment action');
  assert.ok(SRC.includes("action==='email-receipt'"), 'email-receipt action');
  assert.ok(SRC.includes('more than the balance due'), 'overpayment is refused with the balance in the message');
  assert.ok(SRC.includes('insert into market.vendor_payments(monthly_invoice_id'), 'payments write to the shared ledger, linked to the invoice');
  assert.ok(SRC.includes('Receipt email was not sent'), 'the receipt uses the §40 verified-delivery pattern');
  assert.ok(SRC.includes('monthly invoice payment recorded'), 'recording audits');
  assert.ok(SRC.includes('monthly invoice payment deleted'), 'deleting audits');
  assert.ok(SRC.includes('monthly invoice payment receipt emailed'), 'receipt sends audit');
  assert.ok(SRC.includes('reconcileStatus'), 'status is recomputed from the ledger');
  assert.ok(SRC.includes("'partial'"), "the stored 'partial' status is part of the design");
});

test('§49: the ledger link column is codified (after vendor_invoices exists)', () => {
  assert.ok(SCHEMA.includes('alter table market.vendor_payments add column if not exists monthly_invoice_id uuid references market.vendor_invoices'), 'codified FK alter');
  assert.ok(SCHEMA.includes('vendor_payments_monthly_invoice_idx'), 'codified index');
  assert.ok(SCHEMA.indexOf('monthly_invoice_id uuid references market.vendor_invoices') > SCHEMA.indexOf('create table if not exists market.vendor_invoices'), 'the FK alter must come after the vendor_invoices table');
});

test('§49: print and invoice email show Paid / Balance only when payments exist', () => {
  assert.ok(SRC.includes('hasPayments&&!cancelled'), 'the html totals gate the Paid rows on payments existing');
  assert.ok(SRC.includes("<span>Paid</span><strong>-'+money(paidSoFar)"), 'the html totals carry a Paid row');
  assert.ok(SRC.includes("'Balance due'"), 'the html grand row becomes Balance due');
  assert.ok(SRC.includes('Balance due: '), 'the plain email shows the balance');
  assert.ok(SRC.includes('Paid so far: '), 'the receipt states paid-so-far');
  assert.ok(SRC.includes('PAID IN FULL'), 'the receipt calls out a settled invoice');
});

test('§49: Monthly Billing card carries record/list/receipt/delete and the partial label', () => {
  assert.ok(BILLING.includes('data-bill-act="record-payment"'), 'Record payment button on the card');
  assert.ok(BILLING.includes('recordPaymentSheet'), 'the record-payment sheet exists');
  assert.ok(BILLING.includes('Balance due: ${usd(dueOf(i))}'), 'the sheet prefills from the balance');
  assert.ok(BILLING.includes('data-pay-receipt'), 'per-payment Email receipt control');
  assert.ok(BILLING.includes('data-pay-delete'), 'per-payment Delete control');
  assert.ok(BILLING.includes("'partially paid'"), 'the chip reads partially paid');
  assert.ok(BILLING.includes("['partial', 'Partially paid']"), 'the status select round-trips partial');
  assert.ok(/const dueOf = i => .*paid_total/.test(BILLING), 'dueOf is balance-aware (subtracts paid_total)');
});

test('§49: the Invoice Center carries the same payment controls for monthly invoices', () => {
  assert.ok(INVOICES.includes('monthlyPaySheet'), 'the Invoice Center has a record-payment sheet');
  assert.ok(INVOICES.includes('data-act="mi-record"'), 'Record payment button on the monthly card');
  assert.ok(INVOICES.includes('data-act="mi-receipt"'), 'per-payment Email receipt control');
  assert.ok(INVOICES.includes('data-act="mi-delete"'), 'per-payment Delete control');
  assert.ok(INVOICES.includes('miCall'), 'the Invoice Center talks to the monthly-invoices function');
  assert.ok(INVOICES.includes('<strong>Paid:</strong>'), 'the card shows paid-so-far against the total');
  assert.ok(INVOICES.includes("'partially paid'"), 'the chip reads partially paid');
});

test('§49: AR amounts are balances in money.js, reports.js and system-tools', () => {
  assert.ok(MONEY.includes('total - Number(x.paid_total || 0)'), 'money.js monthly rows owe the balance');
  assert.ok(REPORTS.includes('- Number(x.paid_total || 0)'), 'reports.js arRows owes the balance');
  assert.ok(TOOLS.includes('sum(vp.amount) from market.vendor_payments vp where vp.monthly_invoice_id=vi.id'), 'system-tools AR subtracts ledger payments');
});

test('§49 addendum: the Payment Report dataset includes monthly-invoice ledger payments', () => {
  assert.ok(REPORTS.includes('export function paymentReportRows'), 'the payment-report row builder is shared and testable');
  assert.ok(REPORTS.includes("payment_reference: 'Monthly invoice ' + (invoice.billing_period || '')"), 'monthly rows are distinguishable in the Transaction column');
  assert.ok(REPORTS.includes("source: 'monthly invoice'"), 'monthly rows carry a source tag');
  assert.ok(REPORTS.includes('return paymentReportRows(admin(), view)'), 'the screen, print and CSV paths all use the combined dataset');
});

test('§49: the admin payload attaches payments and the Payment Log cannot double-count', () => {
  assert.ok(API.includes("json_agg(json_build_object('id',vp.id,'amount',vp.amount"), 'admin monthlyInvoices carry their payments');
  assert.ok(API.includes('paid_total'), 'admin monthlyInvoices carry paid_total');
  assert.ok(API.includes('not exists(select 1 from market.vendor_payments vp where vp.monthly_invoice_id=vi.id)'), 'the synthesized monthly-billing Payment Log row yields to real ledger rows');
});

test('§49 (behavioral): the roster label carries the partial status unchanged', async () => {
  const { monthlyRoster } = await import('../public/v2/js/roster.js');
  const [entry] = monthlyRoster(
    [{ email: 'ken@test', business: "Ken's Wood shop", regular_vendor: true, monthly_billing_amount: 13500 }],
    [{ vendor_email: 'ken@test', billing_period: '2026-11', status: 'partial' }],
    '2026-11'
  );
  assert.equal(entry.billed, true);
  assert.equal(entry.status, 'partial', 'the roster renders this as “Billed (partial)”');
});

test('§49 addendum (behavioral): payment report rows and total cover booking + monthly money', async () => {
  const { paymentReportRows } = await import('../public/v2/js/reports.js');
  const bookingPayment = {
    id: 'imported-1', event_id: 'event-1', payment_status: 'paid', invoice_amount: 7500,
    payment_method: 'GoDaddy Payments', payment_reference: 'GD-123', approval_code: 'A1',
    card_brand: 'Visa', card_last4: '4242', payment_processor_status: 'approved',
    paid_at: '2026-10-24T14:00:00.000Z', created_at: '2026-10-24T14:00:00.000Z',
    name: 'Booking Vendor', business: 'Booking Business', email: 'booking@test'
  };
  const adminFixture = {
    importedAttendees: [
      bookingPayment,
      // An imported row paid by "monthly billing" stays out, exactly as
      // before — the real monthly payment below is the one record.
      { id: 'imported-monthly-shell', event_id: 'event-1', payment_status: 'paid', invoice_amount: 6000, payment_method: 'monthly billing', paid_at: '2026-10-24T16:00:00.000Z', name: 'Pam Briscoe', business: 'Handmade with Love by Pam', email: 'pam@test' }
    ],
    monthlyInvoices: [
      {
        id: 'invoice-pam', business: 'Handmade with Love by Pam', vendor_name: 'Pam Briscoe', vendor_email: 'pam@test',
        billing_period: '2026-11', status: 'paid',
        payments: [{ id: 'payment-pam', amount: 6000, payment_method: 'Cash', paid_at: '2026-10-24T15:00:00.000Z', created_at: '2026-10-24T15:00:00.000Z' }]
      },
      {
        id: 'invoice-ken', business: "Ken's Wood shop", vendor_name: 'Ken Miller', vendor_email: 'ken@test',
        billing_period: '2026-11', status: 'partial',
        payments: [{ id: 'payment-ken', amount: 4500, payment_method: 'Cash', paid_at: '2026-10-24T13:00:00.000Z', created_at: '2026-10-24T13:00:00.000Z' }]
      }
    ]
  };

  const rows = paymentReportRows(adminFixture);
  assert.equal(rows.length, 3, 'one booking payment plus two monthly-invoice payments');
  assert.equal(rows.find(x => x.payment_reference === 'GD-123'), bookingPayment, 'booking payment rows pass through unchanged');
  const pam = rows.find(x => x.payment_id === 'payment-pam');
  assert.ok(pam, "Pam's monthly-invoice payment appears in the Payment Report");
  assert.equal(pam.invoice_amount, 6000);
  assert.equal(pam.payment_method, 'Cash');
  assert.equal(pam.payment_reference, 'Monthly invoice 2026-11');
  assert.equal(pam.payment_status, 'paid');
  assert.equal(pam.source, 'monthly invoice');
  const ken = rows.find(x => x.payment_id === 'payment-ken');
  assert.equal(ken.payment_status, 'partial', 'a partial invoice payment keeps its partial status');
  assert.equal(rows.reduce((n, x) => n + Number(x.invoice_amount || 0), 0), 18000, 'the reconciliation total covers all money');

  const cashRows = paymentReportRows(adminFixture, { method: 'cash' });
  assert.deepEqual(cashRows.map(x => x.payment_id), ['payment-pam', 'payment-ken'], 'method filtering sees the monthly payments');
  assert.equal(cashRows.reduce((n, x) => n + x.invoice_amount, 0), 10500);

  const eventRows = paymentReportRows(adminFixture, { eventId: 'event-1' });
  assert.deepEqual(eventRows, [bookingPayment], 'a date-scoped report keeps booking payments and does not assign an unallocated monthly payment to that date');
});

// ---------------------------------------------------------------- behavioral harness
// monthly-invoices.mjs through its real default handler (the §40
// harness): imports stripped, core mocked — queue writes a REAL PGlite
// outbox row; flushMail stamps sent_at or records a provider error.
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

const MAIL_ERROR = 'Email delivery failed: 503 — Resend unavailable (stub)';
let handler, db, sql, seq = 0;
const nid = () => '00000000-0000-4000-8000-' + String(++seq).padStart(12, '0');

test.before(async () => {
  let source = await readFile(join(root, 'netlify/functions/monthly-invoices.mjs'), 'utf8');
  source = source.replace(/^import .*;\n/gm, '');
  const mock = `
const db=()=>globalThis.__sql;
const identity=async()=>globalThis.__who;
const queue=async(tx,to,subject,body,htmlBody=null)=>{const id=globalThis.__uuid();await globalThis.__db.query('insert into market.outbox(id,recipient,subject,body,html_body) values($1,$2,$3,$4,$5)',[id,to,subject,body,htmlBody]);return {id};};
const flushMail=async()=>{if(globalThis.__flushMode==='fail'){await globalThis.__db.query('update market.outbox set error=$1 where sent_at is null and error is null',[globalThis.__mailError]);}else{await globalThis.__db.query('update market.outbox set sent_at=now() where sent_at is null and error is null');}};
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
  globalThis.__mailError = MAIL_ERROR;
  globalThis.__flushMode = 'ok';
  globalThis.__audits = [];
});

const post = (action, body) => handler(new Request('https://market.test/.netlify/functions/monthly-invoices?action=' + action, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }));
const get = qs => handler(new Request('https://market.test/.netlify/functions/monthly-invoices' + qs, { method: 'GET' }));

async function seedKen(status = 'draft') {
  const id = nid(), vid = nid();
  await sql`insert into market.vendors(id,email) values(${vid},'millerken29@yahoo.com') on conflict do nothing`;
  await sql`insert into market.vendor_invoices(id,vendor_email,vendor_name,business,billing_period,amount,items,status)
    values(${id},'millerken29@yahoo.com','Ken Miller','Ken''s Wood shop','2026-11',13500,${sql.json([{ description: 'November Bill', amount: 13500 }])},${status})`;
  return { id, vid };
}
const invoiceRow = async id => (await sql`select * from market.vendor_invoices where id=${id}`)[0];
const payRows = async id => sql`select * from market.vendor_payments where monthly_invoice_id=${id} order by created_at asc`;

test('§49 (behavioral): Ken pays $45 at a time — partial, partial, paid in full', async () => {
  const { id, vid } = await seedKen();
  let res = await post('record-payment', { id, amount: 45, payment_method: 'Cash', comment: 'Paid at the Oct market' });
  assert.equal(res.status, 200);
  let body = await res.json();
  assert.equal(body.invoice.status, 'partial', 'first $45 leaves the invoice partial');
  assert.equal(body.invoice.paid_total, 4500);
  assert.equal(body.payment.amount, 4500);
  assert.equal(body.payment.monthly_invoice_id, id, 'the ledger row links to the invoice');
  assert.equal(body.payment.vendor_id, vid, 'the vendor resolves from the master vendor list');
  assert.equal(body.payment.recorded_by, 'organizer@test', 'recorded_by is captured');
  assert.ok(globalThis.__audits.some(([a]) => a === 'monthly invoice payment recorded'), 'the payment audits');

  res = await post('record-payment', { id, amount: 45, payment_method: 'Cash' });
  body = await res.json();
  assert.equal(body.invoice.status, 'partial');
  assert.equal(body.invoice.paid_total, 9000);

  res = await post('record-payment', { id, amount: 45, payment_method: 'Cash' });
  body = await res.json();
  assert.equal(body.invoice.status, 'paid', 'the last $45 settles the invoice');
  assert.equal(body.invoice.paid_total, 13500);
  const row = await invoiceRow(id);
  assert.equal(row.status, 'paid');
  assert.ok(row.paid_at, 'paid_at stamps when the balance closes');

  res = await post('record-payment', { id, amount: 1, payment_method: 'Cash' });
  assert.equal(res.status, 400, 'a settled invoice takes no more payments');
});

test('§49 (behavioral): overpayment is refused with the balance in the message; list shows payments', async () => {
  const { id } = await seedKen();
  await post('record-payment', { id, amount: 45, payment_method: 'Cash' });
  const res = await post('record-payment', { id, amount: 90.01, payment_method: 'Cash' });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.ok(String(body.error).includes('balance due ($90.00)'), 'the refusal names the balance, got: ' + body.error);
  assert.equal((await payRows(id)).length, 1, 'the refused payment never lands');

  const list = await (await get('')).json();
  const inv = list.invoices.find(x => x.id === id);
  assert.ok(inv, 'the invoice is in the list');
  assert.equal(inv.paid_total, 4500, 'the list attaches paid_total');
  assert.equal(inv.payments.length, 1, 'the list attaches the payments');
  assert.equal(inv.payments[0].amount, 4500);
});

test('§49 (behavioral): deleting payments walks the status back — paid → partial → emailed', async () => {
  const id = nid();
  await sql`insert into market.vendor_invoices(id,vendor_email,vendor_name,business,billing_period,amount,items,status,sent_at)
    values(${id},'pam@test','Pam Briscoe','Handmade with Love by Pam','2026-11',6000,${sql.json([{ description: 'November Bill', amount: 6000 }])},'emailed',now())`;
  await post('record-payment', { id, amount: 25, payment_method: 'Cash' });
  let res = await post('record-payment', { id, amount: 35, payment_method: 'Cash' });
  let body = await res.json();
  assert.equal(body.invoice.status, 'paid');
  const pays = await payRows(id);
  assert.equal(pays.length, 2);

  res = await post('delete-payment', { id, payment_id: pays[1].id });
  body = await res.json();
  assert.equal(body.invoice.status, 'partial', 'deleting the settling payment reopens a balance');
  assert.equal(body.invoice.paid_total, 2500);
  assert.ok(globalThis.__audits.some(([a]) => a === 'monthly invoice payment deleted'), 'the deletion audits');

  res = await post('delete-payment', { id, payment_id: pays[0].id });
  body = await res.json();
  assert.equal(body.invoice.status, 'emailed', 'with every payment gone the invoice returns to its pre-payment status');
  assert.equal(body.invoice.paid_total, 0);
  assert.equal((await invoiceRow(id)).paid_at, null, 'paid_at clears when the payments go away');
});

test('§49 (behavioral): print shows Paid / Balance with payments, plain totals without', async () => {
  const { id } = await seedKen();
  let res = await get('?action=print&id=' + id);
  let html = await res.text();
  assert.ok(!html.includes('Balance due'), 'no payments → no balance lines on the printed invoice');
  assert.ok(html.includes('Total due'), 'no payments → the classic Total due grand row');

  await post('record-payment', { id, amount: 45, payment_method: 'Cash' });
  res = await get('?action=print&id=' + id);
  html = await res.text();
  assert.ok(html.includes('<span>Paid</span>'), 'payments → a Paid row appears');
  assert.ok(html.includes('-$45.00'), 'the Paid row shows what was received');
  assert.ok(html.includes('Balance due'), 'the grand row becomes the balance');
  assert.ok(html.includes('$90.00'), 'the balance is the $90 still owed');
});

test('§49 (behavioral): the invoice email reports Paid / Balance due and never knocks partial back', async () => {
  const { id } = await seedKen();
  await post('record-payment', { id, amount: 45, payment_method: 'Cash' });
  globalThis.__flushMode = 'ok';
  const res = await post('email', { id });
  assert.equal(res.status, 200);
  const outbox = await sql`select * from market.outbox order by created_at desc limit 1`;
  assert.ok(outbox[0].body.includes('Paid: $45.00'), 'the emailed invoice states what was paid');
  assert.ok(outbox[0].body.includes('Balance due: $90.00'), 'the emailed invoice states the balance');
  assert.equal((await invoiceRow(id)).status, 'partial', 'emailing a partial invoice must not change its status');
});

test('§49 (behavioral): email-receipt verifies delivery, stamps receipt_sent_at, states the balance', async () => {
  const { id } = await seedKen();
  const rec = await (await post('record-payment', { id, amount: 45, payment_method: 'Cash' })).json();
  const paymentId = rec.payment.id;
  globalThis.__flushMode = 'ok';
  const res = await post('email-receipt', { id, payment_id: paymentId });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.email_delivery.sent, true);
  const outbox = await sql`select * from market.outbox order by created_at desc limit 1`;
  assert.equal(outbox[0].recipient, 'millerken29@yahoo.com');
  assert.ok(outbox[0].body.includes('Amount received: $45.00'), 'the receipt states the amount');
  assert.ok(outbox[0].body.includes('Paid so far: $45.00'), 'the receipt states paid-so-far');
  assert.ok(outbox[0].body.includes('Balance remaining: $90.00'), 'the receipt states the balance');
  const [pay] = await payRows(id);
  assert.ok(pay.receipt_sent_at, 'receipt_sent_at stamps from the confirmed delivery');

  // The final payment's receipt says PAID IN FULL.
  await post('record-payment', { id, amount: 90, payment_method: 'Cash' });
  const pays = await payRows(id);
  const last = pays[pays.length - 1];
  const res2 = await post('email-receipt', { id, payment_id: last.id });
  assert.equal(res2.status, 200);
  const outbox2 = await sql`select * from market.outbox order by created_at desc limit 1`;
  assert.ok(outbox2[0].body.includes('PAID IN FULL'), 'a settling payment’s receipt says PAID IN FULL');
});

test('§49 (behavioral): a failed receipt send claims nothing and stamps nothing', async () => {
  const { id } = await seedKen();
  const rec = await (await post('record-payment', { id, amount: 45, payment_method: 'Cash' })).json();
  globalThis.__flushMode = 'fail';
  const res = await post('email-receipt', { id, payment_id: rec.payment.id });
  assert.equal(res.status, 400, 'a failed receipt must not report success');
  const body = await res.json();
  assert.ok(String(body.error).includes('Receipt email was not sent'), 'the error says the receipt was not sent');
  assert.ok(String(body.error).includes('Resend unavailable (stub)'), 'the error carries the provider reason');
  const [pay] = await payRows(id);
  assert.equal(pay.receipt_sent_at, null, 'receipt_sent_at stays empty when nothing was delivered');
  globalThis.__flushMode = 'ok';
});

test('§49 (behavioral): cancelled invoices take no payments; bad amounts refused; organizers only', async () => {
  const { id } = await seedKen('cancelled');
  let res = await post('record-payment', { id, amount: 45, payment_method: 'Cash' });
  assert.equal(res.status, 400);
  assert.ok(String((await res.json()).error).includes('Cancelled invoices cannot take payments'));

  const { id: id2 } = await seedKen();
  res = await post('record-payment', { id: id2, amount: 0, payment_method: 'Cash' });
  assert.equal(res.status, 400, 'a $0 payment is refused');
  res = await post('record-payment', { id: id2, amount: -5, payment_method: 'Cash' });
  assert.equal(res.status, 400, 'a negative payment is refused');

  globalThis.__who = { admin: false, email: 'vendor@test' };
  res = await post('record-payment', { id: id2, amount: 45, payment_method: 'Cash' });
  assert.equal(res.status, 403, 'non-organizers cannot record payments');
  globalThis.__who = { admin: true, email: 'organizer@test' };
});
