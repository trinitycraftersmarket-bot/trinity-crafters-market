// §70 (Scott, Nov 18, 2026): the v2 Attendees screen gains (1) a mass
// inspection-approve button for the date and (2) a per-card Approve
// inspection / Check in button. Scott's hard rule, stated the same day:
// vendors he marked by hand — above all a FAILED (refused) inspection —
// must remain untouched by the mass approve, so the bulk action may only
// ever update rows whose inspection_status is 'not_inspected'.
// Source pins in the §44/§69 style.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const api = readFileSync(join(root, 'netlify/functions/api.mjs'), 'utf8');
const perms = readFileSync(join(root, 'server/permissions.mjs'), 'utf8');
const att = readFileSync(join(root, 'public/v2/js/attendees.js'), 'utf8');

test('§70: api has a bulk inspection approve action gated to organizer/manager', () => {
  assert.ok(api.includes("action==='inspection-bulk-approve'"), 'bulk approve action exists');
  const seg = api.slice(api.indexOf("action==='inspection-bulk-approve'"), api.indexOf("action==='imported-attendance'"));
  assert.ok(seg.includes("Organizer or Manager access only"), 'bulk approve checks organizer/manager');
  assert.ok(seg.includes("'vendor inspection bulk approve'"), 'bulk approve writes an audit row');
});

test('§70: the bulk approve only ever touches not-yet-inspected vendors — manual marks (incl. refused) stay untouched', () => {
  const seg = api.slice(api.indexOf("action==='inspection-bulk-approve'"), api.indexOf("action==='imported-attendance'"));
  assert.ok(seg.includes("update market.bookings set inspection_status='approved'"), 'bookings are approved in bulk');
  assert.ok(seg.includes("update market.imported_attendees set inspection_status='approved'"), 'imported attendees are approved in bulk');
  const guards = seg.match(/inspection_status='not_inspected'/g) || [];
  assert.equal(guards.length, 2, 'BOTH updates are guarded to not_inspected rows only');
  assert.ok(!seg.includes("inspection_status in ('not_inspected'"), 'no wider status list may slip in');
  assert.ok(seg.includes("status in ('approved','held','paid')"), 'booking update keeps the attendee-list scope');
  assert.ok(seg.includes('not cancelled'), 'imported update skips cancelled rows');
});

test('§70: staff permission map carries the bulk action', () => {
  assert.ok(perms.includes("'inspection-bulk-approve':'attendees'"), 'managers with attendees permission can bulk approve');
});

test('§70: attendees screen has the mass-approve button with the untouched promise', () => {
  assert.ok(att.includes('id="v2-att-insp-all"'), 'mass approve button renders in the tools row');
  assert.ok(att.includes("api('inspection-bulk-approve', { event_id: event.id })"), 'mass approve calls the bulk action for the shown date');
  assert.ok(att.includes("inspection_status === 'not_inspected'"), 'the confirm count only counts not-yet-inspected vendors');
  assert.ok(att.includes('including a failed inspection'), 'the confirm sheet promises manual marks stay untouched');
});

test('§70: every attendee card carries an approve-inspection or check-in button', () => {
  assert.ok(att.includes('data-act="inspect-approve"'), 'unapproved vendors get an Approve inspection button');
  assert.ok(att.includes('data-act="attendance" data-state="checked_in"'), 'approved vendors get a Check in button');
  assert.ok(att.includes('data-act="attendance" data-state="clear"'), 'checked-in vendors can be un-checked from the card');
  assert.ok(att.includes("api('inspection', { id: r.id, imported: r.imported, status: 'approved'"), 'per-card approve uses the shared inspection action');
  assert.ok(att.includes("api(r.imported ? 'imported-attendance' : 'attendance'"), 'per-card check-in uses the shared attendance actions');
});
