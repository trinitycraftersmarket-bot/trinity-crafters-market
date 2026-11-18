// §74 (Scott, Nov 18, 2026): "And it's still opening the browser." Every
// print view in the app was generated into a window.open('', '_blank')
// popup. On Scott's phone those popups leave the app for the browser,
// where the generated page arrives (or doesn't) with dead buttons —
// the root cause behind his §72 complaints that no button fix inside
// the popup could cure. §74 renders every printout in the SAME tab
// ('_self'): the printout stays inside the app, and the §36/§72 Close
// chain (window.close -> history.back -> app root) plus the permanent
// Back link are the way back. Because the floor-plan editor's page is
// replaced by its printouts, both editor printers refuse with a toast
// while autosave still holds unsaved changes, rather than discarding
// them; the editor passes its dirty flag in.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = p => readFileSync(join(root, p), 'utf8');
const PRINT = read('public/v2/js/print.js');
const FP = read('public/v2/js/floorplan.js');
const FE = read('public/v2/js/flooredit.js');
const CLASSIC = read('public/floor-areas.js');

test('§74: the shared printers open in the same tab', () => {
  const opens = PRINT.match(/window\.open\('', '_self'\)/g) || [];
  assert.equal(opens.length, 3, 'printTable, printAttendance and printExpenseReport all open same-tab');
  assert.ok(!PRINT.includes("window.open('', '_blank')"), 'no popup opens remain in print.js');
  assert.ok(!PRINT.includes('Allow pop-ups'), 'the stale pop-up wording is gone');
});

test('§74: the floor-plan printers open in the same tab and guard unsaved changes', () => {
  const opens = FP.match(/window\.open\('', '_self'\)/g) || [];
  assert.equal(opens.length, 2, 'printFloorPlan and printBoothList open same-tab');
  assert.ok(!FP.includes("window.open('', '_blank')"), 'no popup opens remain in floorplan.js');
  const guards = FP.match(/still saving — wait for the saved checkmark, then print/g) || [];
  assert.equal(guards.length, 2, 'both editor printers refuse while changes are saving');
  assert.ok(FE.includes('vendors: state.vendors, dirty: state.dirty, toast: ctx.toast'), 'the editor passes its dirty flag to printFloorPlan');
});

test('§74: the classic twins open in the same tab and guard unsaved changes', () => {
  const opens = CLASSIC.match(/window\.open\('', ?'_self'\)/g) || [];
  assert.equal(opens.length, 2, 'classic booth list and floor plan open same-tab');
  assert.ok(!CLASSIC.includes("window.open('','_blank')"), 'no popup opens remain in floor-areas.js');
  const guards = CLASSIC.match(/still saving — wait a moment, then print/g) || [];
  assert.equal(guards.length, 2, 'both classic printers refuse while changes are saving');
});
