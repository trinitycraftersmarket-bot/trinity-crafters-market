// §79 (Scott, Nov 18, 2026): "printing the floor plan for November 28
// isn't attached to the booth assignments report and it's showing
// November 21."
//
// Two halves:
// - The Nov 21 part is the editor working as built: Setup & Floor
//   Plan opens on the soonest market (events[0]) unless an event is
//   picked, and it prints the event it is showing — Scott's screenshot
//   was the Nov 21 Hampton Inn plan (9 vendors he placed that day),
//   header date and all. Picking Nov 28 in the editor prints Nov 28.
// - The attachment part was a real gap: the Booth Assignments
//   printout was tables only. §79 attaches the plan pages for the
//   SAME event at the back of the printout — composited image plus
//   the §78 plain-text names list per area — in v2 printBoothList
//   (two-phase write, the printFloorPlan pattern) and mirrored in
//   the classic app's printAssignments. One print now carries the
//   booth tables AND the floor plans.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = p => readFileSync(join(root, p), 'utf8');
const FP = read('public/v2/js/floorplan.js');
const CLASSIC = read('public/floor-areas.js');

test('§79 (behavioral): boothPlanSections renders one page per area with its names list', () => {
  const start = FP.indexOf('export function boothPlanSections');
  assert.ok(start >= 0, 'boothPlanSections exists');
  const end = FP.indexOf('\n}\n', start);
  assert.ok(end > start, 'boothPlanSections extraction bounds');
  const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const boothPlanSections = new Function('esc', FP.slice(start, end + 3).replace('export function', 'function') + '\nreturn boothPlanSections;')(esc);
  const html = boothPlanSections(
    [
      { area: { title: 'Main Event Room' }, pins: [{ spot: 'MR-19', label: 'Angels of Hope' }, { spot: 'MR-05', label: "Pat's Potions" }] },
      { area: { title: 'Outside' }, pins: [] }
    ],
    ['data:image/png;base64,AAA', 'data:image/png;base64,BBB'],
    'Saturday, November 28, 2026'
  );
  assert.ok(html.includes('<h2>Main Event Room — floor plan</h2>'), 'area heading with the plan title');
  assert.ok(html.includes('2 vendors placed'), 'pin count in the sub-line');
  assert.ok(html.includes('<strong>Vendor names:</strong> MR-19 — Angels of Hope · MR-05 — Pat\'s Potions'), 'names listed as text with spots');
  assert.ok(html.includes('<h2>Outside — floor plan</h2>'), 'an imageless-but-printable area still gets a page');
  assert.equal(html.split('plan-names').length - 1, 1, 'no names strip for an area with no pins');
});

test('§79: both booth printouts attach the plans for the event being printed', () => {
  assert.ok(FP.includes('boothPlanSections(targets, urls, dateText)'), 'v2 booth list appends the plan sections before </body>');
  assert.ok(FP.includes("toast('Printable booth list opened — floor plans attached at the back.')"), 'v2 confirms the attachment to the organizer');
  assert.ok(FP.includes('.plan-page{break-before:page'), 'v2 booth stylesheet carries the plan-page rules');
  assert.ok(CLASSIC.includes('planSections'), 'classic booth list builds plan sections too');
  assert.ok(CLASSIC.includes("status('Printable booth list opened — floor plans attached at the back.')"), 'classic confirms the attachment');
  assert.ok(CLASSIC.includes('.plan-page{break-before:page'), 'classic booth stylesheet carries the plan-page rules');
  assert.ok(!FP.includes('On a phone? Printing lives in the browser menu'), 'the stale browser-menu hint is gone (the app button works now)');
});
