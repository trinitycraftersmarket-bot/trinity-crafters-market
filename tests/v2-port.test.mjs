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
