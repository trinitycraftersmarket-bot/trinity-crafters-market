// §51 — Print-page controls that actually work in the app (Oct 24, 2026).
// Scott, on the Payment Report print page (post-§39): "Close and print
// button doesn't work." The §39 cascade tested green as markup but failed
// in his hand: small tap targets on a zoomed-out wide-table page, Print a
// platform no-op in the Android app WebView, and Close depending entirely
// on JS tricks the app window may not honor. Fix, in print.js
// printControls() AND monthly-invoices.mjs html() (both copies there —
// the template and the email strip string — byte-identical as §39
// established): (a) BIG touch targets — min-height 44px, larger text, the
// row wraps full-width on narrow screens; (b) a third control that is a
// PLAIN ANCHOR, "← Back to the app", button-styled — zero JavaScript,
// always navigates (print.js → /v2/, the invoice page → /v2/#billing,
// matching its Close fallback); (c) the §39 JS Close cascade stays as the
// smart path; (d) @media print still hides the whole row — paper output
// unchanged; (e) the phone hint now names the exit ("…or tap Back to the
// app to return"). The emailed invoice must NOT carry the controls,
// anchor included (the §34 strip, updated in lockstep).
import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = p => readFileSync(join(root, p), 'utf8');
const APP_URL = 'https://trinitylutzmarkets.com/v2/';
const BILLING_URL = 'https://trinitylutzmarkets.com/v2/#billing';
const APP_ANCHOR = `<a class="print-back" href="${APP_URL}">← Back to the app</a>`;
const BILLING_ANCHOR = `<a class="print-back" href="${BILLING_URL}">← Back to the app</a>`;
const HINT_TAIL = 'or tap Back to the app to return';

// ------------------------------------------------------------ print.js pins
test('§51: print.js controls carry the plain Back-to-the-app anchor + big targets', () => {
  const src = read('public/v2/js/print.js');
  // The anchor lives in printControls() only — exactly once in source.
  assert.equal(src.split(APP_ANCHOR).length - 1, 1, 'exactly one app anchor, in the shared controls helper');
  assert.ok(!src.includes(BILLING_ANCHOR), 'report pages must not point at the billing screen (cross-wire guard)');
  // Big touch targets: 44px minimum height, and a narrow-screen rule that
  // stretches every control to full width.
  assert.ok(src.includes('min-height:44px'), 'controls must be at least 44px tall');
  assert.ok(src.includes('@media(max-width:600px)'), 'a narrow-screen rule must exist');
  assert.ok(src.includes('flex:1 1 100%'), 'narrow screens stretch the controls full-width');
  // The hint names the exit.
  assert.ok(src.includes(HINT_TAIL), 'the phone hint must name the Back-to-the-app exit');
});

// ------------------------------------------------- print.js builders render
function captureWindow() {
  const doc = { html: '', write(s) { this.html += s; }, close() {} };
  const win = { document: doc, focus() {}, addEventListener() {}, print() {} };
  globalThis.window = { open: () => win };
  return doc;
}

async function loadPrint() {
  captureWindow();
  return await import(new URL('../public/v2/js/print.js', import.meta.url));
}

function assertAppControls(html, label) {
  assert.equal(html.split(APP_ANCHOR).length - 1, 1, label + ': exactly one Back-to-the-app anchor');
  assert.ok(!html.includes(BILLING_ANCHOR), label + ': anchor must target the app root, not billing');
  assert.ok(html.includes('min-height:44px'), label + ': big-target CSS must render');
  assert.ok(html.includes(HINT_TAIL), label + ': hint must name the exit');
  assert.ok(html.includes('window.print()">Print / Save PDF</button>'), label + ': Print button kept');
  assert.ok(html.includes('if(!window.closed&&history.length>1)history.back()},300)'), label + ': §39 cascade step 2 kept');
  assert.ok(html.includes(`if(!window.closed)location.href='${APP_URL}'},700)`), label + ': §39 cascade fallback kept');
  assert.ok(html.includes('@media print{.print-controls{display:none}}'), label + ': row stays off paper');
}

test('§51 (behavioral): every print.js builder renders the anchor + big targets', async () => {
  const { printTable, printAttendance, printExpenseReport } = await loadPrint();

  let doc = captureWindow();
  printTable('Payment Report', 'Payment reconciliation', ['Vendor', 'Amount'], [['Pam', '$60.00']], '1 payment');
  assertAppControls(doc.html, 'printTable');

  doc = captureWindow();
  printAttendance({ market: 'Hampton Inn Odessa', subtitle: '', summary: '', headers: ['Space'], rows: [['HI-01']], plans: [] });
  assertAppControls(doc.html, 'printAttendance');

  doc = captureWindow();
  printExpenseReport(
    [{ expense_date: '2026-10-20', event_date: '2026-10-24', market: 'Hampton Inn Odessa', category: 'Supplies', description: 'Tablecloths', payee: '', quantity: 0, amount: 4500, notes: '' }],
    'All expenses', () => false);
  assertAppControls(doc.html, 'printExpenseReport');
});

// Negative controls for the print.js pins: each pin must actually bite.
test('§51 (negative controls): the print.js pins fail on mutated markup', async () => {
  const { printTable } = await loadPrint();
  const doc = captureWindow();
  printTable('Payment Report', '', ['Vendor'], [['Pam']], '');
  const html = doc.html;
  assert.ok(html.includes(APP_ANCHOR), 'sanity: the real render carries the anchor');
  assert.ok(!html.replace(APP_ANCHOR, '').includes(APP_ANCHOR), 'pin bites when the anchor is removed');
  assert.ok(!html.replace(APP_URL + '">←', '#elsewhere">←').includes(APP_ANCHOR), 'pin bites when the href is wrong');
  assert.ok(!html.replace('← Back to the app', '← Back').includes(APP_ANCHOR), 'pin bites when the label is wrong');
  assert.ok(!html.replace('min-height:44px', 'min-height:20px').includes('min-height:44px'), 'pin bites when targets shrink');
});

// ------------------------------------------- monthly-invoices source pins
test('§51: monthly-invoices carries the anchor twice (template + strip), byte-identical copies', () => {
  const SRC = read('netlify/functions/monthly-invoices.mjs');
  assert.equal(SRC.split(BILLING_ANCHOR).length - 1, 2, 'template + email strip must both carry the billing anchor');
  assert.ok(!SRC.includes(APP_ANCHOR), 'the invoice anchor must carry #billing (cross-wire guard)');
  assert.ok(SRC.includes('min-height:44px'), 'invoice controls must be at least 44px tall');
  assert.ok(SRC.includes('@media(max-width:600px)'), 'invoice controls need the narrow-screen rule');
  assert.equal(SRC.split(HINT_TAIL).length - 1, 2, 'template + strip hints must match too');
  // The two controls copies must still be byte-identical or the email
  // strip silently stops removing the row (§39).
  const marker = '<div class="print">';
  const copies = [];
  let at = 0;
  while (true) {
    const i = SRC.indexOf(marker, at);
    if (i < 0) break;
    copies.push(SRC.slice(i, SRC.indexOf('</p></div>', i) + '</p></div>'.length));
    at = i + 1;
  }
  assert.equal(copies.length, 2, 'exactly two controls copies');
  assert.equal(copies[0], copies[1], 'template and strip copies must be byte-identical');
  assert.ok(copies[0].includes(BILLING_ANCHOR), 'the shared copy carries the anchor');
});

// ------------------------------------- monthly-invoices behavioral harness
// Same shape as the §34 harness: real handler, imports stripped, core
// mocked, db = PGlite.
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

const ID = '51c0ffee-1111-4222-8333-444444444444';
let handler, sql;
test.before(async () => {
  let source = await readFile(join(root, 'netlify/functions/monthly-invoices.mjs'), 'utf8');
  source = source.replace(/^import .*;\n/gm, '');
  const mock = `
const db=()=>globalThis.__sql;
const identity=async()=>globalThis.__who;
const queue=async(...a)=>{globalThis.__queued.push(a);const id='00000000-0000-4000-8000-000000000051';await globalThis.__db.query('insert into market.outbox(id,recipient,subject,sent_at) values($1,$2,$3,now()) on conflict (id) do update set sent_at=now()',[id,a[1],a[2]]);return {id};};
const flushMail=async()=>{};
const audit=async(...a)=>{globalThis.__audits.push(a);};
`;
  ({ default: handler } = await import('data:text/javascript;base64,' + Buffer.from(mock + source).toString('base64')));

  const db = new PGlite();
  await db.exec(`create schema market;
    create table market.vendor_invoices(
      id uuid primary key, vendor_email text, vendor_name text, business text,
      billing_period text, amount integer not null default 0, discount integer not null default 0,
      late_fee integer not null default 0, items jsonb, due_date date, status text not null default 'draft',
      payment_method text, payment_reference text, payment_comment text, cancel_reason text,
      sent_at timestamptz, created_at timestamptz not null default now(), updated_at timestamptz not null default now());
    create table market.vendor_payments(
      id uuid primary key, monthly_invoice_id uuid, vendor_id uuid, application_id uuid,
      booking_id uuid, imported_attendee_id uuid, amount integer not null, payment_method text,
      paid_at timestamptz, note text, recorded_by text, receipt_sent_at timestamptz,
      created_at timestamptz not null default now());
    create table market.outbox(
      id uuid primary key, recipient text, subject text, body text, html_body text,
      attachments jsonb, sent_at timestamptz, error text, created_at timestamptz not null default now());`);
  sql = pgliteSql(db);
  globalThis.__sql = sql;
  globalThis.__db = db;
  const items = [{ description: 'Vendor space', amount: 6000, market_dates: [{ date: '2026-11-28', location: 'Hilton Garden Inn Suncoast' }] }];
  await sql`insert into market.vendor_invoices(id,vendor_email,vendor_name,business,billing_period,amount,discount,items,status)
    values(${ID},'vendor@example.com','Vera Vendor','Verde Soap & Candle Co','2026-11',6000,0,${sql.json(items)},'draft')`;
});

test('§51 (behavioral): the invoice print page renders the billing anchor + big targets', async () => {
  const res = await handler(new Request('https://market.test/.netlify/functions/monthly-invoices?action=print&id=' + ID + '&token=' + ID));
  assert.equal(res.status, 200, 'print page must render');
  const body = await res.text();
  assert.ok(body.includes('Verde Soap &amp; Candle Co'), 'invoice content renders (esc()-ed)');
  assert.equal(body.split(BILLING_ANCHOR).length - 1, 1, 'exactly one billing anchor on the print page');
  assert.ok(!body.includes(APP_ANCHOR), 'the invoice anchor must target #billing, not the app root');
  assert.ok(body.includes('min-height:44px'), 'big-target CSS renders');
  assert.ok(body.includes('@media(max-width:600px)'), 'narrow-screen rule renders');
  assert.ok(body.includes(HINT_TAIL), 'hint names the exit');
  assert.ok(body.includes('history.back()'), '§39 cascade kept');
  assert.ok(body.includes('.print{display:none}'), 'controls stay off paper');
});

// Negative control on the strip: the emailed copy must carry NO trace of
// the controls — anchor, label, or hint — while staying a real invoice.
test('§51 (behavioral, negative control): the emailed invoice strips the anchor + hint', async () => {
  globalThis.__who = { admin: true, email: 'org@example.com' };
  globalThis.__queued = [];
  globalThis.__audits = [];
  const res = await handler(new Request('https://market.test/.netlify/functions/monthly-invoices?action=email', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: ID })
  }));
  assert.equal(res.status, 200, 'email action must succeed');
  assert.equal(globalThis.__queued.length, 1, 'exactly one email queued');
  const emailedHtml = globalThis.__queued[0][4];
  assert.ok(emailedHtml.includes('Vendor Invoice') && emailedHtml.includes('Verde Soap &amp; Candle Co'), 'emailed HTML is still the invoice');
  for (const banned of ['<a class="print-back"', 'Back to the app', '←', BILLING_URL, '<button', 'window.close']) {
    assert.ok(!emailedHtml.includes(banned), 'emailed HTML must not contain: ' + banned);
  }
});
