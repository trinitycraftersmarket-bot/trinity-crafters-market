// §48 — Monthly billing roster dropdown (Oct 24, 2026). Scott: "fix the
// labels so who I mark regular vendors that are approved by me for
// monthly billing showed up and I want it added to monthly billing as a
// drop down to pick. Once billed I want it marked as billed in the drop
// down so I don't miss anyone." Refinement, same evening: "in monthly
// billing can I see and select regular vendors" — the roster IS the
// regular vendors.
//
// The Monthly Billing screen gains a "Monthly billing vendors" roster
// for the selected period: every vendor flagged regular_vendor (the
// unified §47 flag store — market.applications for application vendors,
// market.vendor_profiles for imported ones; vendor-list surfaces it for
// everyone), each entry marked Billed (with the invoice status) when a
// non-cancelled monthly invoice exists for that vendor+period, else
// "Not billed yet". A regular vendor with no monthly_billing_amount set
// is still listed, marked "no monthly amount set"; picking them starts
// their bill with the amount left blank for Scott to enter. Picking a
// billed vendor opens that invoice. A vendor with a monthly amount but
// no regular flag is NOT on the roster — regular is the roster.
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
  assert.ok(BILL.includes('no monthly amount set'), 'regular vendors without a monthly amount are marked as such');
  assert.ok(BILL.includes('monthlyRoster(vendors, invoices, period)'), 'the roster is computed from the loaded vendors + invoices');
});

test('§48: the roster recomputes when the billing period changes', () => {
  assert.ok(BILL.includes('view.month = e.target.value; drawList(); drawRoster();'), 'the month filter redraws list AND roster');
  assert.ok(BILL.includes('const period = view.month || currentMonth;'), 'the roster period follows the selected month (current month when All months)');
});

test('§48: empty state points at the regular-vendor flag', () => {
  assert.ok(BILL.includes('No regular vendors yet'), 'empty state renders when nobody is flagged regular');
  assert.ok(BILL.includes('Regular vendor'), 'empty state names the flag');
  assert.ok(BILL.includes('Vendors → Edit information'), 'empty state says where to set it');
});

test('§48: picking a vendor starts a prefilled bill or opens the invoice', () => {
  assert.ok(BILL.includes('rosterPrefill(entry, period)'), 'the prefill comes from the roster entry');
  assert.ok(BILL.includes("slot.querySelector('#v2-bill-amount').value = pre.amount;"), 'the monthly amount lands in the Add Bill amount field (blank when none is set)');
  assert.ok(BILL.includes('periodInput.value = pre.billing_period;'), 'the selected period lands in the Add Bill period field');
  assert.ok(BILL.includes('if (opt) vendorSel.value = opt.value;'), 'the vendor lands in the Add Bill vendor select');
  assert.ok(BILL.includes('openInvoice(entry.invoice)'), 'a billed vendor opens their invoice');
  assert.ok(BILL.includes("card.classList.add('roster-flash')"), 'the opened invoice card flashes');
  assert.ok(CSS.includes('.roster-flash'), 'the flash style exists');
});

// ---------------------------------------------------------------- behavioral
const V = (email, amount, extra = {}) => ({ email, name: extra.name || '', business: extra.business || '', monthly_billing_amount: amount, regular_vendor: true, ...extra });
const I = (email, period, status, extra = {}) => ({ vendor_email: email, billing_period: period, status, ...extra });

test('§48: the roster lists exactly the regular vendors — amount or not', () => {
  const roster = monthlyRoster([
    V('saltylunaco@gmail.com', 10000, { business: 'Salty Luna Co' }),
    V('pbriscoe.pb@gmail.com', null, { business: 'Handmade with Love by Pam' }),
    V('amountonly@example.com', 5000, { business: 'Amount-Only Andy', regular_vendor: false }),
    V('plain@example.com', null, { business: 'Plain Paula', regular_vendor: false })
  ], [], '2026-11');
  assert.deepEqual(roster.map(r => r.email), ['pbriscoe.pb@gmail.com', 'saltylunaco@gmail.com'], 'only regular vendors, sorted by name; the amount-only vendor is excluded');
  const pam = roster.find(r => r.email === 'pbriscoe.pb@gmail.com');
  assert.equal(pam.hasAmount, false, 'a regular vendor with no monthly amount is still listed, flagged as such');
  assert.equal(pam.amountCents, 0);
  const salty = roster.find(r => r.email === 'saltylunaco@gmail.com');
  assert.equal(salty.hasAmount, true);
  assert.equal(salty.amountCents, 10000);
  assert.ok(roster.every(r => !r.billed && !r.invoice), 'nobody is billed without invoices');
});

test('§48: a duplicate regular vendor row (application + import) yields one roster entry', () => {
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

test('§48: the prefill for a regular vendor with no monthly amount leaves the amount blank', () => {
  const [entry] = monthlyRoster([V('pbriscoe.pb@gmail.com', null, { name: 'Pam Briscoe', business: 'Handmade with Love by Pam' })], [], '2026-11');
  const pre = rosterPrefill(entry, '2026-11');
  assert.equal(pre.amount, '', 'no stored amount → the field is left for Scott to enter');
  assert.equal(pre.vendor_email, 'pbriscoe.pb@gmail.com');
  assert.equal(pre.billing_period, '2026-11');
});
