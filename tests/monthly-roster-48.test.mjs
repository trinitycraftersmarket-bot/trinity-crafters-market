// §48 — Monthly billing roster dropdown (Oct 24, 2026). Scott: "fix the
// labels so who I mark regular vendors that are approved by me for
// monthly billing showed up and I want it added to monthly billing as a
// drop down to pick. Once billed I want it marked as billed in the drop
// down so I don't miss anyone."
//
// The Monthly Billing screen gains a "Monthly billing vendors" roster
// for the selected period: every vendor whose monthly_billing_amount is
// set (the §46/§47 approval flag as it exists in the flag store today —
// there is no separate approved boolean; the amount IS the flag, set in
// Vendors → Edit information; integer cents), each entry marked Billed
// (with the invoice status) when a non-cancelled monthly invoice exists
// for that vendor+period, else "Not billed yet". Picking a not-billed
// vendor starts their bill in the Add Bill form prefilled with their
// monthly amount; picking a billed vendor opens that invoice.
//
// The roster computation is pure and lives in public/v2/js/roster.js so
// it is behaviorally testable without a DOM; billing.js renders it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = p => readFileSync(join(root, p), 'utf8');
const BILL = read('public/v2/js/billing.js');
const CSS = read('public/v2/css/app.css');

const { monthlyRoster, rosterPrefill, cleanEmail } = await import(pathToFileURL(join(root, 'public/v2/js/roster.js')).href);

// ---------------------------------------------------------------- static pins
test('§48: billing.js renders the roster dropdown from roster.js', () => {
  assert.ok(BILL.includes("from './roster.js?v="), 'billing.js imports the roster module (stamped)');
  assert.ok(BILL.includes('Monthly billing vendors'), 'the roster heading renders');
  assert.ok(BILL.includes('id="v2-bill-roster-sel"'), 'the roster is a dropdown');
  assert.ok(BILL.includes('v2-bill-roster-slot'), 'the roster has its own slot so period changes do not disturb the Add Bill form');
  assert.ok(BILL.includes('Not billed yet'), 'unbilled entries say so');
  assert.ok(BILL.includes("'Billed (' + esc(r.status) + ')'"), 'billed entries carry the invoice status');
  assert.ok(BILL.includes('monthlyRoster(vendors, invoices, period)'), 'the roster is computed from the loaded vendors + invoices');
});

test('§48: the roster recomputes when the billing period changes', () => {
  assert.ok(BILL.includes('view.month = e.target.value; drawList(); drawRoster();'), 'the month filter redraws list AND roster');
  assert.ok(BILL.includes('const period = view.month || currentMonth;'), 'the roster period follows the selected month (current month when All months)');
});

test('§48: empty state points at the vendor settings flag', () => {
  assert.ok(BILL.includes('No vendors are set up for monthly billing yet'), 'empty state renders');
  assert.ok(BILL.includes('Monthly billing amount'), 'empty state names the setting');
  assert.ok(BILL.includes('Vendors → Edit information'), 'empty state says where to set it');
});

test('§48: picking a vendor starts a prefilled bill or opens the invoice', () => {
  assert.ok(BILL.includes('rosterPrefill(entry, period)'), 'the prefill comes from the roster entry');
  assert.ok(BILL.includes("slot.querySelector('#v2-bill-amount').value = pre.amount;"), 'the monthly amount lands in the Add Bill amount field');
  assert.ok(BILL.includes('periodInput.value = pre.billing_period;'), 'the selected period lands in the Add Bill period field');
  assert.ok(BILL.includes('if (opt) vendorSel.value = opt.value;'), 'the vendor lands in the Add Bill vendor select');
  assert.ok(BILL.includes('openInvoice(entry.invoice)'), 'a billed vendor opens their invoice');
  assert.ok(BILL.includes("card.classList.add('roster-flash')"), 'the opened invoice card flashes');
  assert.ok(CSS.includes('.roster-flash'), 'the flash style exists');
});

// ---------------------------------------------------------------- behavioral
const V = (email, amount, extra = {}) => ({ email, name: extra.name || '', business: extra.business || '', monthly_billing_amount: amount, ...extra });
const I = (email, period, status, extra = {}) => ({ vendor_email: email, billing_period: period, status, ...extra });

test('§48: the roster lists exactly the vendors with a monthly amount set', () => {
  const roster = monthlyRoster([
    V('saltylunaco@gmail.com', 10000, { business: 'Salty Luna Co' }),
    V('pbriscoe.pb@gmail.com', 6000, { business: 'Handmade with Love by Pam' }),
    V('walkin@example.com', null, { business: 'Walk-in Wendy' }),
    V('zero@example.com', 0, { business: 'Zero Zelda' }),
    V('unset@example.com', undefined, { business: 'Unset Uma' })
  ], [], '2026-11');
  assert.deepEqual(roster.map(r => r.email), ['pbriscoe.pb@gmail.com', 'saltylunaco@gmail.com'], 'only amount>0 vendors, sorted by name');
  assert.ok(roster.every(r => !r.billed && !r.invoice), 'nobody is billed without invoices');
});

test('§48: a duplicate vendor row (application + import) yields one roster entry', () => {
  const roster = monthlyRoster([
    V('dup@example.com', 5000, { business: 'Dup Dairy' }),
    V('dup@example.com', 5000, { business: 'Dup Dairy' })
  ], [], '2026-11');
  assert.equal(roster.length, 1, 'one entry per email');
});

test('§48: billed state flips when an invoice is created for the period — and only that period', () => {
  const vendors = [V('saltylunaco@gmail.com', 10000, { business: 'Salty Luna Co' })];
  const before = monthlyRoster(vendors, [], '2026-11');
  assert.equal(before[0].billed, false, 'not billed before the invoice exists');
  const after = monthlyRoster(vendors, [I('saltylunaco@gmail.com', '2026-11', 'draft')], '2026-11');
  assert.equal(after[0].billed, true, 'billed once the period invoice exists');
  assert.equal(after[0].status, 'draft', 'the invoice status rides along');
  const otherPeriod = monthlyRoster(vendors, [I('saltylunaco@gmail.com', '2026-11', 'draft')], '2026-12');
  assert.equal(otherPeriod[0].billed, false, 'a November invoice does not bill December');
});

test('§48: a cancelled invoice does not count as billed; a live one beside it does', () => {
  const vendors = [V('saltylunaco@gmail.com', 10000, { business: 'Salty Luna Co' })];
  const cancelledOnly = monthlyRoster(vendors, [I('saltylunaco@gmail.com', '2026-11', 'cancelled')], '2026-11');
  assert.equal(cancelledOnly[0].billed, false, 'cancelled ≠ billed');
  const mixed = monthlyRoster(vendors, [
    I('saltylunaco@gmail.com', '2026-11', 'cancelled'),
    I('saltylunaco@gmail.com', '2026-11', 'paid')
  ], '2026-11');
  assert.equal(mixed[0].billed, true, 'the live invoice bills the vendor');
  assert.equal(mixed[0].status, 'paid', 'the live invoice status is shown, not the cancelled one');
});

test('§48: vendor/invoice email matching ignores case and stray commas', () => {
  const vendors = [V('SaltyLunaCo@gmail.com ', 10000, { business: 'Salty Luna Co' })];
  const roster = monthlyRoster(vendors, [I('saltylunaco@gmail.com', '2026-11', 'emailed')], '2026-11');
  assert.equal(roster[0].billed, true, 'normalized emails match');
  assert.equal(roster[0].status, 'emailed');
  assert.equal(cleanEmail('A@b.com, '), 'a@b.com', 'cleanEmail trims trailing commas + case');
});

test('§48: the prefill carries the monthly amount (dollars), vendor and period', () => {
  const [entry] = monthlyRoster([V('saltylunaco@gmail.com', 10000, { name: 'Ashley', business: 'Salty Luna Co' })], [], '2026-11');
  const pre = rosterPrefill(entry, '2026-11');
  assert.equal(pre.amount, '100.00', 'cents become the form\u2019s dollar string');
  assert.equal(pre.vendor_email, 'saltylunaco@gmail.com');
  assert.equal(pre.vendor_name, 'Ashley');
  assert.equal(pre.business, 'Salty Luna Co');
  assert.equal(pre.billing_period, '2026-11', 'the selected period carries into the bill');
});
