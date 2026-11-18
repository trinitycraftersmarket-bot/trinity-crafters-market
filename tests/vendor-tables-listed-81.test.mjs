// §81 (Scott, Nov 18, 2026): "Also on the vendor cards please list how
// many tables they've decided to bring and on the report as well."
// §69 stored the count at online check-in and showed it only buried
// inside the check-in pill ("Online check-in ✓ · arrives 8:15 AM ·
// 2 tables"). §81 makes it first-class: a labelled "Tables: N" chip on
// the Attendees card and the Event Day card (the pill keeps check-in +
// arrival only), and a Tables column on the printed Attendance List
// next to Setup Arrival. Vendors who have not checked in online have
// stated no count, so the chip/column stay blank for them — nothing is
// invented.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = p => readFileSync(join(root, p), 'utf8');
const ATT = read('public/v2/js/attendees.js');
const DAY = read('public/v2/js/eventday.js');

test('§81: Attendees and Event Day cards carry a labelled Tables chip', () => {
  for (const [name, src] of [['attendees', ATT], ['eventday', DAY]]) {
    assert.ok(src.includes('Tables: ${esc(r.setup_tables)}'), name + ' card shows the labelled chip');
    assert.ok(!src.includes("' · ' + esc(r.setup_tables)"), name + ' pill no longer buries the count');
  }
});

test('§81: the printed Attendance List has a Tables column beside Setup Arrival', () => {
  assert.ok(ATT.includes("'Setup Arrival', 'Tables']"), 'Tables header follows Setup Arrival');
  assert.ok(ATT.includes("r.setup_tables ? String(r.setup_tables) : '—'"), 'rows print the stated count or a dash');
});
