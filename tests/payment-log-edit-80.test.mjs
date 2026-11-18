// §80 (Scott, Nov 18, 2026): "Yeah fix the payment log also" — Dawn
// Houts paid $75 for Nov 28 but the Payment Log row said $60, and the
// log had NO edit control anywhere (her invoice could be corrected,
// the log row could not). §80 adds one: an Edit button on every
// non-monthly Payment Log row opens a correction sheet; the server
// action payment-log-edit updates the UNDERLYING record for the row's
// source (the log is a union of four sources, keyed since §80 by
// source + edit_id, a new column on every branch):
//   payment ledger          -> vendor_payments.amount (+ the imported
//                              attendee's invoice_amount sync that
//                              vendor-payment does when recording)
//   manual/imported booking -> imported_attendees.invoice_amount
//   online booking          -> bookings.price
//   monthly billing         -> REFUSED: the Invoice Center owns those
//                              totals (discounts/late fees), and a
//                              ledger row tied to a monthly invoice is
//                              refused the same way.
// Every correction is audit-logged with the old amount.
// Same message, second ask: the vendor portal's "Where will you be"
// view now states "Booth spots are subject to change without notice."
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = p => readFileSync(join(root, p), 'utf8');
const API = read('netlify/functions/api.mjs');
const PAY = read('public/v2/js/payments.js');
const FP = read('public/v2/js/floorplan.js');

test('§80: every paymentLog branch carries its edit_id', () => {
  assert.ok(API.includes("'payment ledger' source,vp.id edit_id"), 'ledger rows key to the payment id');
  assert.ok(API.includes("'manual/imported booking',i.id edit_id"), 'imported rows key to the attendee id');
  assert.ok(API.includes("'online booking',b.id edit_id"), 'online rows key to the booking id');
  assert.ok(API.includes("'monthly billing',vi.id edit_id"), 'monthly rows key to the invoice id');
});

test('§80: payment-log-edit corrects the underlying record, refuses monthly, audits the change', () => {
  const start = API.indexOf("if(action==='payment-log-edit')");
  assert.ok(start >= 0, 'the action exists');
  const block = API.slice(start, start + 3200);
  assert.ok(block.includes("if(!u.admin)return json({error:'Organizer access only'},403);"), 'organizer only, like the other payment actions');
  assert.ok(block.includes('update market.vendor_payments set amount='), 'ledger branch updates the payment');
  assert.ok(block.includes('update market.imported_attendees set invoice_amount='), 'imported amounts stay in step (both branches)');
  assert.ok(block.includes('update market.bookings set price='), 'online branch updates the booking price');
  assert.ok(block.includes('Monthly billing payments are edited from the Invoice Center'), 'monthly rows are refused with the reason');
  assert.ok(block.includes('cur.monthly_invoice_id'), 'a ledger payment tied to a monthly invoice is refused too');
  assert.ok(block.includes("'vendor payment log edited'"), 'the correction is audit-logged');
  assert.ok(block.includes('old_amount:oldAmount'), 'the audit entry carries the old amount');
});

test('§80: the Payment Log offers the correction sheet on non-monthly rows', () => {
  assert.ok(PAY.includes('data-pay-edit="${esc(x.edit_id)}"'), 'each editable row carries an Edit button keyed by edit_id');
  assert.ok(PAY.includes("x.source !== 'monthly billing'"), 'monthly rows get no Edit button');
  assert.ok(PAY.includes("api('payment-log-edit', { source: x.source, edit_id: x.edit_id, amount })"), 'the sheet saves through the new action');
  assert.ok(PAY.includes('Correct payment amount'), 'the sheet is labelled as a correction');
});

test('§80: the vendor portal spot view states spots can change', () => {
  assert.ok(FP.includes('<p class="note">Booth spots are subject to change without notice.</p>'), 'the notice renders under the vendor floor plan');
});
