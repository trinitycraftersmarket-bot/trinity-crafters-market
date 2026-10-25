// §34 — Monthly invoice email TDZ + print page controls (Oct 24, 2026).
// Scott, from the v2 Monthly Billing screen: "Email error and the print
// button doesn't work and I need a close button on it" — the toast read
// "Cannot access 'html2' before initialization." Root cause: the email
// action's const chain declared a local `html` initialized by calling the
// module's own `html(i)` template — self-shadowing TDZ, so every Email
// tap threw and no invoice ever sent. Fix: the local is `emailHtml`.
// The print page (the same template) also gained a screen-only controls
// row (unchanged Print button + Close with a billing-screen fallback +
// a phone hint), and the email action strips that whole row from the
// emailed copy. Server-only change; no version stamp.
import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync, readdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = p => readFileSync(join(root, p), 'utf8');
const SRC = read('netlify/functions/monthly-invoices.mjs');
const FALLBACK = 'https://trinitylutzmarkets.com/v2/#billing';

// ---------------------------------------------------------------- static pins
test('§34: no html=html( self-reference remains in any function/server module', () => {
  for (const dir of ['netlify/functions', 'server']) {
    for (const f of readdirSync(join(root, dir)).filter(x => x.endsWith('.mjs'))) {
      assert.ok(!read(join(dir, f)).includes('html=html('), dir + '/' + f + ' must not shadow html with its own initializer');
    }
  }
});

test('§34: the email action builds emailHtml from the invoice template and queues emailHtml', () => {
  assert.ok(SRC.includes('emailHtml=html(inv)'), 'the local must be renamed to emailHtml (§49 renders the payment-attached invoice copy)');
  assert.ok(SRC.includes('plain,emailHtml)'), 'queue() must receive emailHtml');
  assert.ok(!SRC.includes(',html);'), 'queue() must not receive a bare html local');
});

test('§34: the print template carries the screen-only controls row', () => {
  assert.ok(SRC.includes('window.print()">Print / Save PDF</button>'), 'the Print button stays');
  assert.ok(SRC.includes('window.close()'), 'a Close button must call window.close()');
  assert.ok(SRC.includes('>Close</button>'), 'the Close button is labelled');
  assert.ok(SRC.includes(FALLBACK), 'the Close fallback navigates to the v2 billing screen');
  assert.ok(SRC.includes('On a phone? Printing lives in the browser menu'), 'the phone hint is present');
  // Paper output unchanged: @media print still hides the .print wrapper.
  assert.ok(SRC.includes('.print{display:none}'), '@media print must keep hiding the controls');
});

test('§39: Close is a cascade — close, then history.back(), then the reload fallback', () => {
  // Step 2 (§39): after ~300ms, if still open and there is history, go back —
  // in the app the print page is a same-webview navigation, so Back returns
  // to the billing screen as Scott left it instead of reloading the app.
  assert.ok(SRC.includes('history.length>1'), 'the back step must be guarded by history.length>1');
  assert.ok(SRC.includes('history.back()'), 'the back step must call history.back()');
  assert.ok(SRC.includes('if(!window.closed&&history.length>1)history.back()},300)'), 'the back step fires at ~300ms, only if still open');
  // Step 3: the §34 redirect stays as the last resort, at ~700ms.
  assert.ok(SRC.includes('},700)'), 'the redirect fallback must be deferred to ~700ms');
  // The handler appears twice and both copies must carry the cascade: the
  // html() template and the email action's strip string (they must match
  // byte-for-byte or the strip silently stops removing the controls).
  assert.equal(SRC.split('history.back()').length - 1, 2, 'template + email strip must both carry the cascade');
});

// ---------------------------------------------------------------- behavioral harness
// monthly-invoices.mjs through its real default handler: imports stripped,
// core mocked (identity/queue/flushMail/audit), db = PGlite adapter (§31).
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

const ID = '5497fca8-1111-4222-8333-444444444444';
let handler, db, sql;
test.before(async () => {
  let source = await readFile(join(root, 'netlify/functions/monthly-invoices.mjs'), 'utf8');
  source = source.replace(/^import .*;\n/gm, '');
  const mock = `
const db=()=>globalThis.__sql;
const identity=async()=>globalThis.__who;
const queue=async(...a)=>{globalThis.__queued.push(a);const id='00000000-0000-4000-8000-0000000000e1';await globalThis.__db.query('insert into market.outbox(id,recipient,subject,sent_at) values($1,$2,$3,now()) on conflict (id) do update set sent_at=now()',[id,a[1],a[2]]);return {id};};
const flushMail=async()=>{};
const audit=async(...a)=>{globalThis.__audits.push(a);};
`;
  ({ default: handler } = await import('data:text/javascript;base64,' + Buffer.from(mock + source).toString('base64')));

  db = new PGlite();
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
  const items = [
    { description: 'Vendor space', amount: 4500, market_dates: [{ date: '2026-11-07', location: 'Hampton Inn Odessa Trinity' }] },
    { description: 'Vendor space', amount: 4500, market_dates: [{ date: '2026-11-21', location: 'Hampton Inn Odessa Trinity' }] },
    { description: 'Vendor space', amount: 4500, market_dates: [{ date: '2026-11-28', location: 'Hilton Garden Inn Suncoast' }] }
  ];
  await sql`insert into market.vendor_invoices(id,vendor_email,vendor_name,business,billing_period,amount,discount,items,status,payment_method,payment_comment)
    values(${ID},'pbriscoe.pb@gmail.com','Pam Briscoe','Handmade with Love by Pam','2026-11',13500,7500,${sql.json(items)},'draft','Cash','$40 credit from last market plus cancelled November 7')`;
});

test('§34 (behavioral): the print page renders the controls row + hint', async () => {
  const res = await handler(new Request('https://market.test/.netlify/functions/monthly-invoices?action=print&id=' + ID + '&token=' + ID));
  assert.equal(res.status, 200, 'print page must render');
  const body = await res.text();
  assert.ok(body.includes('Handmade with Love by Pam'), 'invoice content renders');
  assert.ok(body.includes('$60.00'), 'discounted total renders');
  assert.ok(body.includes('Print / Save PDF'), 'Print button present');
  assert.ok(body.includes('>Close</button>'), 'Close button present');
  assert.ok(body.includes('window.close()'), 'Close calls window.close()');
  assert.ok(body.includes('history.back()'), 'Close cascade includes the history.back() step (§39)');
  assert.ok(body.includes(FALLBACK), 'Close fallback URL present');
  assert.ok(body.includes('On a phone? Printing lives in the browser menu'), 'phone hint present');
  assert.ok(body.includes('.print{display:none}'), 'controls stay off paper');
});

test('§34 (behavioral): email sends, strips the controls, flips status to emailed', async () => {
  globalThis.__who = { admin: true, email: 'org@example.com' };
  globalThis.__queued = [];
  globalThis.__audits = [];
  const res = await handler(new Request('https://market.test/.netlify/functions/monthly-invoices?action=email', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: ID })
  }));
  assert.equal(res.status, 200, 'email action must succeed (was the html TDZ 400 before the fix)');
  const emailBody = await res.json();
  assert.equal(emailBody.ok, true);
  assert.equal(emailBody.email_delivery.sent, true, '§40: success is only reported with a confirmed delivery');

  assert.equal(globalThis.__queued.length, 1, 'exactly one email queued');
  const [, to, subject, plain, emailedHtml] = globalThis.__queued[0];
  assert.equal(to, 'pbriscoe.pb@gmail.com');
  assert.ok(subject.includes('2026-11'), 'subject carries the billing period');
  assert.ok(plain.includes('Total due: $60.00'), 'plain text carries the totals');
  assert.ok(emailedHtml.includes('Vendor Invoice') && emailedHtml.includes('Handmade with Love by Pam'), 'emailed HTML is the invoice');
  for (const banned of ['<button', 'window.print', 'window.close', 'Print / Save PDF', 'On a phone', FALLBACK]) {
    assert.ok(!emailedHtml.includes(banned), 'emailed HTML must not contain: ' + banned);
  }

  const [row] = await sql`select status, sent_at from market.vendor_invoices where id=${ID}`;
  assert.equal(row.status, 'emailed', 'status flips to emailed');
  assert.ok(row.sent_at, 'sent_at is stamped');
  assert.ok(globalThis.__audits.some(a => a[2] === 'monthly invoice emailed'), 'audit row written');
});
