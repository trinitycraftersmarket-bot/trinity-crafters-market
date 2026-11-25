// §88 (Scott, Nov 24, 2026, with a print-preview screenshot):
// the Attendance List printed with a thick dark frame around every
// page — the white list sat inset on a dark green field. Cause: the
// print documents in print.js painted only the BODY white; on his
// phone the app window's dark background showed through everywhere
// the body box doesn't cover (the page margins and below short
// content), framing every sheet. The floor-plan prints never showed
// it because floorplan.js already paints html,body white. Fix: every
// print.js document now paints the ROOT element white too, so the
// whole page — margins included — is white.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const prn = readFileSync(new URL('../public/v2/js/print.js', import.meta.url), 'utf8');
const flr = readFileSync(new URL('../public/v2/js/floorplan.js', import.meta.url), 'utf8');

test('§88: every print.js print document paints the page root white', () => {
  const docs = [
    ['printTable', prn.indexOf('export function printTable'), prn.indexOf('export function printAttendance')],
    ['printAttendance', prn.indexOf('export function printAttendance'), prn.indexOf('export function printExpenseReport')],
    ['printExpenseReport', prn.indexOf('export function printExpenseReport'), prn.length],
  ];
  for (const [name, a, b] of docs) {
    assert.ok(a > -1, name + ' found');
    assert.ok(prn.slice(a, b).includes('html{background:#fff}'), name + ': html painted white so no dark frame can show');
  }
  assert.ok(flr.includes('html,body{margin:0;padding:0;height:100%;background:#fff'), 'floor-plan prints already paint the root white (the control case)');
});
