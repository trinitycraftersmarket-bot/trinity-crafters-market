// §37 — Delete charges on monthly invoices + Edit Charges discount
// section (Oct 24, 2026). Scott, from Salty Luna Co's Nov 2026 Edit
// Charges sheet (two "November Bill" charges): "On the monthly billing
// as well as the invoice screen, I need to edit, delete charges." Items
// could be edited (edit-item) but never deleted; the new server
// delete-item action mirrors edit-item (validate, splice, recompute
// amount, audit 'monthly invoice item deleted' with the removed
// description + amount). The sheet gains a Delete charge N button per
// charge behind a confirm that names the charge and the resulting
// total due (and warns when unsaved edits to other charges would be
// discarded by the re-render). Addendum: the sheet also gains a
// Discount section saving through the existing update action — which
// also writes status / payment_method / payment_comment, so the call
// must carry the invoice's current values for all three.
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
const BILL = read('public/v2/js/billing.js');
const CODIFY = read('database/codify-live-schema.sql');

// ---------------------------------------------------------------- static pins
test('§37: the server gains a delete-item action mirroring edit-item', () => {
  assert.ok(SRC.includes("action==='delete-item'"), 'delete-item action must exist');
  assert.ok(SRC.includes('items.splice(idx,1)'), 'delete-item splices the item out');
  assert.ok(SRC.includes("'monthly invoice item deleted'"), 'audit action recorded');
  assert.ok(SRC.includes('description:removed.description'), 'audit carries the removed description');
  assert.ok(SRC.includes('amount:Number(removed.amount||0)'), 'audit carries the removed amount');
});

test('§37: every charge in the Edit Charges sheet gains a Delete button + confirm', () => {
  assert.ok(BILL.includes('data-item-delete="${n}"'), 'a delete button renders per charge');
  assert.ok(BILL.includes('Delete charge ${n + 1}'), 'the button is labelled Delete charge N');
  assert.ok(BILL.includes("miCall('delete-item', { id: i.id, index: n })"), 'confirm calls delete-item with id + index');
  assert.ok(BILL.includes('The total due will become'), 'the confirm names the resulting total due');
  assert.ok(BILL.includes('Unsaved edits to other charges will be lost.'), 'the confirm warns about unsaved edits when dirty');
  assert.ok(BILL.includes('v2-bill-cf-yes'), 'the confirm uses the standard sheet pattern');
});

test('§37 addendum 2: discount reason + note — schema, preserve semantics, sheet + card UI', () => {
  // Storage codified (§37 addendum 2) and healed inline where the function needs it.
  assert.ok(CODIFY.includes('discount_reason text') && CODIFY.includes('discount_note text'), 'both columns codified');
  assert.ok(CODIFY.includes('add column if not exists discount_reason'), 'codify carries the heal alters');
  assert.ok(SRC.includes('add column if not exists discount_reason text'), 'the function heals the columns inline');
  // update accepts both fields but preserves stored values when keys are absent.
  assert.ok(SRC.includes("hasOwnProperty.call(p,'discount_reason')"), 'reason presence is keyed on the payload');
  assert.ok(SRC.includes("hasOwnProperty.call(p,'discount_note')"), 'note presence is keyed on the payload');
  assert.ok(SRC.includes('discount_reason=coalesce(${reason},discount_reason)'), 'absent reason keeps the stored value');
  assert.ok(SRC.includes('discount_note=coalesce(${note},discount_note)'), 'absent note keeps the stored value');
  // Print template + email plain text append the suffix.
  assert.ok(SRC.includes("'<p><span>Discount'+discountSuffixHtml(i)+'</span>"), 'the printed Discount line carries the suffix');
  assert.ok(SRC.includes("money(i.discount||0)+discountSuffixText(i)"), 'the email plain-text Discount line carries the suffix');
  // Sheet: reason dropdown with Scott's vocabulary + note box, saved with the discount.
  for (const r of ['Barter', 'Free day', 'Credit applied', 'Rate adjustment', 'Tumbler credit', 'Other']) {
    assert.ok(BILL.includes("'" + r + "'"), 'reason option present: ' + r);
  }
  assert.ok(BILL.includes('data-discount-reason'), 'reason select renders in the Discount section');
  assert.ok(BILL.includes('data-discount-note'), 'note box renders in the Discount section');
  assert.ok(BILL.includes('>No reason</option>'), 'a no-reason default renders');
  assert.ok(BILL.includes('discount_reason: discountReason'), 'Save discount sends the reason');
  assert.ok(BILL.includes('discount_note: discountNote'), 'Save discount sends the note');
  // Card: the reason shows under the Discount field when set.
  assert.ok(BILL.includes('Discount reason: ${esc(i.discount_reason)}'), 'the billing card shows the reason');
});

test('§37 addendum: the sheet gains a Discount section on the existing update action', () => {
  assert.ok(BILL.includes('data-invoice-discount'), 'an editable Discount ($) field renders');
  assert.ok(BILL.includes('Save discount'), 'a Save discount button renders');
  assert.ok(BILL.includes('Charges subtotal: ${usd(i.amount)}'), 'the section shows the charges subtotal');
  assert.ok(BILL.includes('Total due: ${usd(dueOf(i))}'), 'the section shows the resulting total due');
  assert.ok(BILL.includes('Late fee: ${usd(i.late_fee)}'), 'the late fee shows when nonzero');
  // CRITICAL: update also writes status / payment_method / payment_comment —
  // the discount save must pass the invoice's current values for all three.
  assert.ok(BILL.includes("miCall('update', {"), 'discount saves through the update action');
  assert.ok(BILL.includes("comment: i.payment_comment || ''"), 'update call preserves payment_comment');
  assert.ok(BILL.includes("status: i.status || 'draft'"), 'update call preserves status');
  assert.ok(BILL.includes("payment_method: i.payment_method || ''"), 'update call preserves payment_method');
});

// ---------------------------------------------------------------- behavioral harness
// monthly-invoices.mjs through its real default handler: imports stripped,
// core mocked (identity/queue/flushMail/audit), db = PGlite adapter (§34).
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

const ID = '5a17f37a-2222-4333-8444-555555555555';
const ID2 = '5a17f37b-2222-4333-8444-555555555555';
let handler, db, sql;
const call = (action, body) => handler(new Request('https://market.test/.netlify/functions/monthly-invoices?action=' + action, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
}));

test.before(async () => {
  let source = await readFile(join(root, 'netlify/functions/monthly-invoices.mjs'), 'utf8');
  source = source.replace(/^import .*;\n/gm, '');
  const mock = `
const db=()=>globalThis.__sql;
const identity=async()=>globalThis.__who;
const queue=async(...a)=>{globalThis.__queued.push(a);};
const flushMail=async()=>{};
const audit=async(...a)=>{globalThis.__audits.push(a);};
`;
  ({ default: handler } = await import('data:text/javascript;base64,' + Buffer.from(mock + source).toString('base64')));

  db = new PGlite();
  await db.exec(`create schema market;
    create table market.vendor_invoices(
      id uuid primary key, vendor_email text, vendor_name text, business text,
      billing_period text, amount integer not null default 0, discount integer not null default 0,
      discount_reason text, discount_note text,
      late_fee integer not null default 0, items jsonb, due_date date, status text not null default 'draft',
      payment_method text, payment_reference text, payment_comment text, cancel_reason text,
      paid_at timestamptz, sent_at timestamptz, created_at timestamptz not null default now(), updated_at timestamptz not null default now());`);
  sql = pgliteSql(db);
  globalThis.__sql = sql;
  globalThis.__who = { admin: true, email: 'org@example.com' };
  globalThis.__queued = [];
  globalThis.__audits = [];
  // Salty Luna's sheet from Scott's screenshot: two November Bill charges.
  const items = [
    { type: 'manual', description: 'November Bill', amount: 10000 },
    { type: 'manual', description: 'November Bill', amount: 13500 }
  ];
  await sql`insert into market.vendor_invoices(id,vendor_email,vendor_name,business,billing_period,amount,items,status)
    values(${ID},'saltylunaco@gmail.com','Ashley','Salty Luna Co','2026-11',23500,${sql.json(items)},'emailed')`;
  await sql`insert into market.vendor_invoices(id,vendor_email,vendor_name,business,billing_period,amount,items,status,payment_method)
    values(${ID2},'pbriscoe.pb@gmail.com','Pam Briscoe','Handmade with Love by Pam','2026-11',13500,${sql.json([{ description: 'Booth fee', amount: 13500 }])},'emailed','Cash')`;
});

test('§37 (behavioral): delete-item removes the charge and recomputes the amount', async () => {
  const res = await call('delete-item', { id: ID, index: 0 });
  assert.equal(res.status, 200, 'delete-item must succeed');
  const v = await res.json();
  assert.equal(v.ok, true);
  assert.equal(v.invoice.amount, 13500, 'amount recomputed to the remaining charge');
  assert.equal(v.invoice.items.length, 1, 'one charge remains');
  assert.equal(v.invoice.items[0].amount, 13500, 'the $135 charge remains');

  const [row] = await sql`select amount, items from market.vendor_invoices where id=${ID}`;
  assert.equal(row.amount, 13500, 'stored amount recomputed');
  assert.equal(row.items.length, 1, 'stored items spliced');

  const audit = globalThis.__audits.find(a => a[2] === 'monthly invoice item deleted');
  assert.ok(audit, 'audit row written');
  assert.equal(audit[3].invoice_id, ID);
  assert.equal(audit[3].index, 0);
  assert.equal(audit[3].description, 'November Bill', 'audit names the removed charge');
  assert.equal(audit[3].amount, 10000, 'audit carries the removed amount');
});

test('§37 (behavioral): deleting the last charge leaves items [] and amount 0', async () => {
  const res = await call('delete-item', { id: ID, index: 0 });
  assert.equal(res.status, 200, 'deleting the last charge is allowed');
  const v = await res.json();
  assert.deepEqual(v.invoice.items, [], 'no charges remain');
  assert.equal(v.invoice.amount, 0, 'amount recomputes to 0');
  const [row] = await sql`select amount, items from market.vendor_invoices where id=${ID}`;
  assert.equal(row.amount, 0);
  assert.deepEqual(row.items, []);
});

test('§37 (behavioral): an out-of-range index errors and changes nothing', async () => {
  const res = await call('delete-item', { id: ID, index: 3 });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /Invoice item not found/);
  const [row] = await sql`select amount from market.vendor_invoices where id=${ID}`;
  assert.equal(row.amount, 0, 'the invoice is untouched');
});

test('§37 (behavioral): a non-integer or negative index is refused', async () => {
  for (const index of [-1, 1.5, 'x']) {
    const res = await call('delete-item', { id: ID, index });
    assert.equal(res.status, 400, 'index ' + JSON.stringify(index) + ' must be refused');
    assert.match((await res.json()).error, /Invalid invoice item/);
  }
});

test('§37 (behavioral): an unknown invoice id errors', async () => {
  const res = await call('delete-item', { id: '00000000-0000-4000-8000-000000000000', index: 0 });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /Invoice not found/);
});

test('§37 (behavioral): a non-admin caller is refused at the gate', async () => {
  globalThis.__who = { admin: false };
  try {
    const res = await call('delete-item', { id: ID, index: 0 });
    assert.equal(res.status, 403, 'organizer access only');
  } finally {
    globalThis.__who = { admin: true, email: 'org@example.com' };
  }
});

// ------------------------------------------------------- addendum 2 behavior
test('§37 addendum 2 (behavioral): discount reason + note round-trip through update', async () => {
  const res = await call('update', {
    id: ID2, discount: '25', comment: '', status: 'emailed', payment_method: 'Cash',
    discount_reason: 'Barter', discount_note: 'Tumbler order trade'
  });
  assert.equal(res.status, 200, 'update with reason keys must succeed');
  const v = await res.json();
  assert.equal(v.invoice.discount, 2500, 'discount stored in cents');
  assert.equal(v.invoice.discount_reason, 'Barter', 'reason stored');
  assert.equal(v.invoice.discount_note, 'Tumbler order trade', 'note stored');
  const [row] = await sql`select discount, discount_reason, discount_note from market.vendor_invoices where id=${ID2}`;
  assert.equal(row.discount_reason, 'Barter');
  assert.equal(row.discount_note, 'Tumbler order trade');
});

test('§37 addendum 2 (behavioral): update WITHOUT the reason keys preserves the stored values', async () => {
  // This is the billing card's Save Changes call shape — it carries no
  // reason/note controls and must not wipe what the sheet saved.
  const res = await call('update', { id: ID2, discount: '25', comment: 'Card note', status: 'emailed', payment_method: 'Cash' });
  assert.equal(res.status, 200);
  const [row] = await sql`select discount_reason, discount_note, payment_comment from market.vendor_invoices where id=${ID2}`;
  assert.equal(row.discount_reason, 'Barter', 'absent reason key preserves the stored reason');
  assert.equal(row.discount_note, 'Tumbler order trade', 'absent note key preserves the stored note');
  assert.equal(row.payment_comment, 'Card note', 'the fields the card does send still update');
});

test('§37 addendum 2 (behavioral): the printed invoice appends reason + note to the Discount line', async () => {
  const res = await handler(new Request('https://market.test/.netlify/functions/monthly-invoices?action=print&id=' + ID2 + '&token=' + ID2));
  assert.equal(res.status, 200, 'print page must render');
  const body = await res.text();
  assert.ok(body.includes('<span>Discount — Barter (Tumbler order trade)</span>'), 'Discount line carries " — <Reason> (<note>)"');
  assert.ok(body.includes('-$25.00'), 'discount amount renders');
});

test('§37 addendum 2 (behavioral): the emailed invoice carries the suffix in plain text and HTML', async () => {
  globalThis.__queued = [];
  const res = await call('email', { id: ID2 });
  assert.equal(res.status, 200, 'email action must succeed');
  assert.equal(globalThis.__queued.length, 1, 'exactly one email queued');
  const [, , , plain, emailedHtml] = globalThis.__queued[0];
  assert.ok(plain.includes('Discount: -$25.00 — Barter (Tumbler order trade)'), 'plain-text Discount line carries the suffix');
  assert.ok(emailedHtml.includes('Discount — Barter (Tumbler order trade)'), 'emailed HTML Discount line carries the suffix');
});

test('§37 addendum 2 (behavioral): an explicitly cleared reason removes the suffix everywhere', async () => {
  const res = await call('update', {
    id: ID2, discount: '25', comment: '', status: 'emailed', payment_method: 'Cash',
    discount_reason: '', discount_note: ''
  });
  assert.equal(res.status, 200);
  const [row] = await sql`select discount_reason, discount_note from market.vendor_invoices where id=${ID2}`;
  assert.equal(row.discount_reason, '', 'a present-but-empty reason clears the stored value');
  assert.equal(row.discount_note, '');
  const print = await handler(new Request('https://market.test/.netlify/functions/monthly-invoices?action=print&id=' + ID2 + '&token=' + ID2));
  const body = await print.text();
  assert.ok(body.includes('<span>Discount</span>'), 'the Discount line still renders');
  assert.ok(!body.includes('Discount —'), 'no suffix without a reason');
});
