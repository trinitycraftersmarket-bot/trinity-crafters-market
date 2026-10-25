// §40 — Invoice email feedback: "I have no idea if it was sent" (Oct 24, 2026).
// Three verified defects in the monthly-invoices email action: (1) the only
// feedback was a transient generic toast and the billing card never showed
// emailed-when/to-whom; (2) the action flipped status to 'emailed' and
// returned {ok:true} BEFORE checking the outbox delivery, so a failed send
// still claimed success; (3) the status update was unguarded, so emailing a
// PAID invoice knocked it back to 'emailed'.
// Fix: queue → flush → verify the queued outbox row (the manual-booking
// function's email_delivery readback pattern). Status/sent_at flip + audit
// happen ONLY on a confirmed send, with the godaddy-sent guard (only draft
// advances to 'emailed'; paid stays paid; sent_at stamps on every confirmed
// send). Delivery failure returns an error carrying the outbox error text and
// leaves the invoice untouched. The card gains an "Invoice email" line and
// the success toast names the recipient.
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
const emailAction = SRC.slice(SRC.indexOf("if(action==='email')"));

// ---------------------------------------------------------------- static pins
test('§40: the email action verifies the queued outbox row before claiming success', () => {
  assert.ok(emailAction.includes('market.outbox'), 'the action must read back the outbox delivery row');
  assert.ok(emailAction.includes('email_delivery'), 'the response must report email_delivery like manual-booking');
  assert.ok(emailAction.includes('queue(tx,i.vendor_email,subject,plain,emailHtml)'), 'the queued row must be captured');
  assert.ok(emailAction.includes('Invoice email was not sent'), 'a failed delivery must surface as an error');
});

test('§40: the unguarded status flip is gone; the email update uses the draft-only guard', () => {
  assert.ok(!SRC.includes("set status='emailed',sent_at=now()"), 'the old flip-before-verify update must be gone');
  assert.ok(emailAction.includes("status=case when status='draft' then 'emailed' else status end"), 'email update must only advance draft → emailed (paid stays paid)');
});

test('§40: the billing card shows the Invoice email line and the toast names the recipient', () => {
  assert.ok(BILLING.includes('<strong>Invoice email:</strong> Emailed · Last'), 'the card must show when the invoice was last emailed');
  assert.ok(BILLING.includes('· to ${esc(i.vendor_email'), 'the card line must show the recipient address');
  assert.ok(BILLING.includes("'Invoice emailed to ' + (inv.vendor_email"), 'the success toast must name the recipient');
  assert.ok(!BILLING.includes("miCall('email', { id: inv.id }), 'Invoice emailed.'"), 'the old generic toast must be gone');
});

// ---------------------------------------------------------------- behavioral harness
// monthly-invoices.mjs through its real default handler: imports stripped,
// core mocked — queue writes a REAL row into a PGlite outbox; flushMail is
// switchable (ok → stamps sent_at; fail → records the stub provider error),
// so the handler's verify step runs against real delivery state.
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
    create table market.vendor_invoices(
      id uuid primary key, vendor_id uuid, vendor_email text, vendor_name text, business text,
      billing_period text, amount integer not null default 0, discount integer not null default 0,
      late_fee integer not null default 0, items jsonb, due_date date, status text not null default 'draft',
      payment_method text, payment_reference text, payment_comment text, cancel_reason text,
      cancelled_at timestamptz, paid_at timestamptz, sent_at timestamptz,
      created_at timestamptz not null default now(), updated_at timestamptz not null default now());
    create table market.outbox(
      id uuid primary key, recipient text, subject text, body text, html_body text,
      attachments jsonb, sent_at timestamptz, error text, created_at timestamptz not null default now());`);
  sql = pgliteSql(db);
  globalThis.__sql = sql;
  globalThis.__db = db;
  globalThis.__who = { admin: true, email: 'organizer@test' };
  globalThis.__uuid = nid;
  globalThis.__mailError = MAIL_ERROR;
});

const post = (action, body) => handler(new Request('https://market.test/.netlify/functions/monthly-invoices?action=' + action, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }));

async function seed(status) {
  const id = nid();
  globalThis.__flushMode = 'ok';
  globalThis.__audits = [];
  await sql`delete from market.outbox`;
  await sql`insert into market.vendor_invoices(id,vendor_email,vendor_name,business,billing_period,amount,items,status,payment_method)
    values(${id},'saltylunaco@gmail.com','Ashley Paige','Salty Luna Co','2026-11',10000,${sql.json([{ description: 'November Bill', amount: 10000 }])},${status},${status === 'paid' ? 'Cash' : null})`;
  return id;
}
const invoiceRow = async id => (await sql`select * from market.vendor_invoices where id=${id}`)[0];

test('§40 (behavioral): draft + confirmed delivery → emailed, delivery reported, audited', async () => {
  const id = await seed('draft');
  const res = await post('email', { id });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.email_delivery.sent, true);
  assert.ok(body.email_delivery.sent_at, 'the confirmed sent_at is reported');
  assert.equal(body.invoice.status, 'emailed');
  const row = await invoiceRow(id);
  assert.equal(row.status, 'emailed');
  assert.ok(row.sent_at, 'sent_at is stamped on a confirmed send');
  const outbox = await sql`select * from market.outbox`;
  assert.equal(outbox.length, 1);
  assert.equal(outbox[0].recipient, 'saltylunaco@gmail.com');
  assert.ok(outbox[0].sent_at);
  assert.ok(globalThis.__audits.some(([a]) => a === 'monthly invoice emailed'), 'the send is audited');
});

test('§40 (behavioral): paid + confirmed delivery → status STAYS paid, sent_at stamps', async () => {
  const id = await seed('paid');
  const res = await post('email', { id });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.email_delivery.sent, true);
  const row = await invoiceRow(id);
  assert.equal(row.status, 'paid', 'emailing a paid invoice must not knock it back to emailed');
  assert.ok(row.sent_at, 'sent_at still stamps so the card can show the resend');
});

test('§40 (behavioral): delivery failure → error carries the outbox error, invoice untouched', async () => {
  const id = await seed('draft');
  globalThis.__flushMode = 'fail';
  const res = await post('email', { id });
  assert.equal(res.status, 400, 'a failed send must not report success');
  const body = await res.json();
  assert.ok(String(body.error).includes('Resend unavailable (stub)'), 'the error must carry the real outbox error text, got: ' + body.error);
  const row = await invoiceRow(id);
  assert.equal(row.status, 'draft', 'status must not claim emailed when nothing sent');
  assert.equal(row.sent_at, null, 'sent_at must not stamp when nothing sent');
  assert.ok(!globalThis.__audits.some(([a]) => a === 'monthly invoice emailed'), 'no emailed audit on a failed send');
  const outbox = await sql`select * from market.outbox`;
  assert.equal(outbox.length, 1, 'the mail was queued…');
  assert.equal(outbox[0].error, MAIL_ERROR, '…and its failure is on the outbox row');
});

test('§40 (behavioral): paid + delivery failure → still paid, no sent_at', async () => {
  const id = await seed('paid');
  globalThis.__flushMode = 'fail';
  const res = await post('email', { id });
  assert.equal(res.status, 400);
  const row = await invoiceRow(id);
  assert.equal(row.status, 'paid');
  assert.equal(row.sent_at, null);
});

test('§40 (behavioral): cancelled invoices still cannot be emailed', async () => {
  const id = await seed('cancelled');
  const res = await post('email', { id });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.ok(String(body.error).includes('Cancelled invoices cannot be emailed'));
  assert.equal((await sql`select * from market.outbox`).length, 0, 'nothing is queued for a cancelled invoice');
});
