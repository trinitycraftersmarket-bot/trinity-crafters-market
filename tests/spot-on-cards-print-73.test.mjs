// §73 (Scott, Nov 18, 2026): "Add to the report what spot they are in as
// well as the vendor cards, and give a legend for location abbreviation
// such as MR=MAIN ROOM." Plus his follow-up screenshots the same hour:
// the printed attendance list's floor-plan pages showed the bare layout
// images with NO vendor names, and the 11-column table crushed to
// unreadable slivers on his phone.
//
// What §73 does:
// - floorplan.js gains spotLegend(areas): "Spot key: MR = Main Event
//   Room · H1 = Hallway 1 · …" derived from the event's own areas.
// - v2 Attendees cards carry a "📍 Spot MR-19" chip (assignments resolved
//   with findVendorSpot, the vendor-view helper), and the printed
//   attendance list gains a Spot column + the legend line.
// - The attendance print's plan pages composite the assignment pins onto
//   the layout images (composePlanCanvas — the floor-plan print's own
//   renderer) so names print; the list printed landscape (§73–§83) and
//   no longer crushed on a phone screen (min-width + horizontal scroll
//   on screen). §84 (Nov 24, 2026) superseded the orientation: the
//   whole packet — list and plan pages — prints portrait now, with a
//   combined Business / Vendor column keeping it readable.
// - The Booth Assignments printout (v2 + classic) gains the legend too.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = p => readFileSync(join(root, p), 'utf8');
const FP = read('public/v2/js/floorplan.js');
const ATT = read('public/v2/js/attendees.js');
const PRINT = read('public/v2/js/print.js');
const CLASSIC = read('public/floor-areas.js');

test('§73 (behavioral): spotLegend builds the abbreviation key from the event areas', () => {
  const start = FP.indexOf('export function spotLegend');
  assert.ok(start >= 0, 'spotLegend exists');
  const end = FP.indexOf('\n}\n', start);
  const fnSrc = FP.slice(start, end + 3).replace('export function', 'function');
  const spotLegend = vm.runInContext(fnSrc + '; spotLegend', vm.createContext({}));
  assert.equal(
    spotLegend([
      { title: 'Main Event Room', spots: ['MR-01', 'MR-02'] },
      { title: 'Hallway 1', spots: ['H1-01'] },
      { title: 'Hallway 2', spots: ['H2-01'] },
      { title: 'Lobby', spots: ['L-01'] },
      { title: 'Outside', spots: ['OUT-01'] }
    ]),
    'Spot key: MR = Main Event Room · H1 = Hallway 1 · H2 = Hallway 2 · L = Lobby · OUT = Outside');
  assert.equal(spotLegend([{ title: 'Empty Area', spots: [] }]), '', 'an area with no spots contributes nothing');
  assert.equal(spotLegend([]), '', 'no areas, no legend');
});

test('§73: Attendees cards and the printed list carry the booth spot', () => {
  assert.ok(ATT.includes('findVendorSpot(spotAreas, [r.id, r.vendor_id])'), 'cards resolve spots through the shared helper and both id spaces');
  assert.ok(ATT.includes('📍 Spot ${esc(spotOf(r))}'), 'the card chip shows the spot');
  assert.ok(ATT.includes("headers: ['Space', 'Spot', 'Business / Vendor'"), 'the printed list has a Spot column after Space (§84: combined name column)');
  assert.ok(ATT.includes("spotOf(r) || '—'"), 'unassigned vendors print a dash, not a blank');
  assert.ok(ATT.includes('legend') && ATT.includes('spotLegend(areas.map('), 'the printed list carries the legend');
});

test('§73: the attendance print composites names onto the plan pages and prints portrait (§84)', () => {
  assert.ok(ATT.includes("api('floor-attendees'"), 'pin labels come from the floor-attendees rows');
  assert.ok(ATT.includes('composePlanCanvas(a, floorRows || [])'), 'plan pages are composited canvases, not bare layout images');
  const attPrint = PRINT.slice(PRINT.indexOf('export function printAttendance'), PRINT.indexOf('export function printExpenseReport'));
  assert.ok(attPrint.includes('size:letter portrait'), 'the attendance list prints portrait since §84 (was landscape §73–§83)');
  assert.ok(attPrint.includes('table{min-width:680px}'), '§87: the phone SCREEN view keeps readable columns (print itself still fits the portrait page — the min-width is screen-only)');
  assert.ok(PRINT.includes('legend = \'\'') && PRINT.includes('class="legend"'), 'printAttendance renders the optional legend line');
});

test('§73: the Booth Assignments printouts carry the legend', () => {
  assert.ok(FP.includes("'<p class=\"legend\">' + esc(legend) + '</p>'"), 'v2 booth list prints the legend');
  // §83 (Nov 24, 2026): printBoothList no longer builds per-area blocks
  // (its tables are grouped by check-in time now), so the legend is
  // derived from the areas directly — same spotLegend, same output.
  assert.ok(FP.includes('const legend = spotLegend(areas.map('), 'v2 booth legend derives from its areas');
  assert.ok(CLASSIC.includes('Spot key: '), 'classic booth list prints the legend');
});
