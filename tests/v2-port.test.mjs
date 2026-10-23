// Full-port program (audit §20): each stage gives a classic-only tool a
// native v2 screen on the SAME server endpoints and rules. These static
// checks pin the wiring per stage, in the style of tests/v2-frontend.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const v2js = join(root, 'public', 'v2', 'js');
const read = (base, m) => readFileSync(join(base, m), 'utf8');

test('stage A: manual booking module exists and app.js routes to it', () => {
  assert.ok(existsSync(join(v2js, 'manualbooking.js')), 'missing manualbooking.js');
  const app = read(v2js, 'app.js');
  assert.ok(app.includes("live: 'manualbooking'"), 'section registry must wire live: manualbooking');
  assert.ok(app.includes("'manualbooking'"), 'router must accept the manualbooking route');
  assert.ok(app.includes('renderManualBooking'), 'app.js must dispatch to renderManualBooking');
});

test('stage A: manual booking uses the same endpoint and multi-date rules as legacy', () => {
  const mb = read(v2js, 'manualbooking.js');
  assert.ok(mb.includes("/.netlify/functions/manual-booking"), 'must call the manual-booking function');
  assert.ok(mb.includes("'?q=' + encodeURIComponent(q)"), 'vendor search must use the ?q= GET like the legacy panel');
  // Multi-date: one POST per ticked date, sequential, per-date amounts.
  assert.ok(mb.includes('event_id: r.check.value'), 'each ticked date posts its own booking');
  assert.ok(mb.includes('(rowCents(r) / 100).toFixed(2)'), 'multi-date amounts are the per-row rate');
  assert.ok(mb.includes('singleAmount'), 'single-date amount override stays editable');
  assert.ok(mb.includes('amount.readOnly = sel.length > 1'), 'combined total is read-only for several dates');
  // Credit card = one date at a time (GoDaddy amount must match).
  assert.ok(mb.includes('Credit card bookings are one date at a time'), 'card multi-date guard copy must be present');
  assert.ok(mb.includes('payment_reference'), 'the GoDaddy Txn ID flow must be ported');
  assert.ok(mb.includes('monthly billing'), 'monthly billing must be a payment option');
  // Partial failure reporting: failed dates stay ticked.
  assert.ok(mb.includes('still ticked'), 'failures must be reported with dates left ticked');
  assert.ok(mb.includes('done.forEach(r => { r.check.checked = false; })'), 'only successful dates are unticked');
  const css = readFileSync(join(root, 'public', 'v2', 'css', 'app.css'), 'utf8');
  for (const cls of ['.mb-list', '.mb-row', '.mb-rate'])
    assert.ok(css.includes(cls), `app.css must style ${cls} (stage A components)`);
});

test('stage B: credit issuance lives in the vendor directory sheet flow', () => {
  const v = read(v2js, 'vendors.js');
  assert.ok(v.includes("'admin-sources'"), 'directory must load creditable records via admin-sources');
  assert.ok(v.includes("'preview'"), 'issuance must preview the stored paid amount first');
  assert.ok(v.includes("action: 'issue'"), 'issuance must call the vendor-credit issue action');
  assert.ok(v.includes('Cancellation credits'), 'the directory must render the Cancellation credits section');
  assert.ok(v.includes('Credit issued'), 'already-issued records must show their remaining balance');
  assert.ok(v.includes('data-imported'), 'issuance must distinguish imported vs booking sources');
});

test('stage B: application review flags credits and offers Approve & apply credit (§19)', () => {
  const a = read(v2js, 'applications.js');
  assert.ok(a.includes("'applicant-credits'"), 'review must load applicant credits');
  assert.ok(a.includes("'application-conflicts'"), 'review must load the who-sells-what conflicts');
  assert.ok(a.includes('Holds a '), 'the credit flag line must render');
  assert.ok(a.includes('credit from '), 'the flag must name the credit source date');
  assert.ok(a.includes("'redeem-for-application'"), 'the override must settle via redeem-for-application');
  assert.ok(a.includes('Approve &amp; apply '), 'the Approve & apply credit button must render');
  assert.ok(a.includes('products not listed'), 'conflict lines must use the no-invention fallback');
  assert.ok(a.includes('sells '), 'conflict lines must use the "<Business> sells <products>" format');
});

test('stage C: cancelled vendors screen reinstates via the existing action', () => {
  assert.ok(existsSync(join(v2js, 'cancelled.js')), 'missing cancelled.js');
  const app = read(v2js, 'app.js');
  assert.ok(app.includes("live: 'cancelled'"), 'section registry must wire live: cancelled');
  assert.ok(app.includes('renderCancelled'), 'app.js must dispatch to renderCancelled');
  const c = read(v2js, 'cancelled.js');
  assert.ok(c.includes("'reinstate-cancelled'"), 'reinstatement must use the reinstate-cancelled action');
  assert.ok(c.includes('cancelledRows'), 'rows must be shaped from the admin payload');
  assert.ok(c.includes("x.status === 'cancelled'"), 'booking rows come from cancelled bookings');
  assert.ok(c.includes('cancellation_reason'), 'the cancellation reason must be shown');
  assert.ok(c.includes('Past market date'), 'past dates must not offer reinstatement');
});

test('stage C: banned vendors screen toggles bans via the existing action', () => {
  assert.ok(existsSync(join(v2js, 'banned.js')), 'missing banned.js');
  const app = read(v2js, 'app.js');
  assert.ok(app.includes("live: 'banned'"), 'section registry must wire live: banned');
  assert.ok(app.includes('renderBanned'), 'app.js must dispatch to renderBanned');
  const b = read(v2js, 'banned.js');
  assert.ok(b.includes("'ban'"), 'the screen must use the ban action');
  assert.ok(b.includes('active: !b.active'), 'unban / reapply must flip the active flag');
  assert.ok(b.includes('Add banned vendor'), 'the add-ban form must exist');
});
