// §76 (Nov 18, 2026): the print pages no longer auto-fire window.print().
// Three browser verifications in a row showed the print pages' own
// controls (Print, Close, Back) doing nothing in desktop Chrome: the
// pages auto-opened Chrome's print dialog on load, and that dialog is
// modal — every click meant for the page is swallowed while it is up
// (it also never shows in the verifier's page screenshots, which is
// why the pages looked simply "dead"). In Scott's phone WebView the
// auto-fire was a no-op anyway, so nothing he uses is lost: the Print
// button on each page is the deliberate way in.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = p => readFileSync(join(root, p), 'utf8');

test('§76: no print page auto-fires the print dialog on load', () => {
  const PRINT = read('public/v2/js/print.js');
  assert.ok(!PRINT.includes('window.onload=()=>window.print()'), 'printTable carries no auto-print script');
  assert.ok(!PRINT.includes('window.onload=()=>setTimeout(()=>window.print(),50)'), 'printAttendance carries no auto-print script');
  assert.ok(PRINT.includes('onclick="window.print()"'), 'the deliberate Print button remains');
  for (const p of ['public/v2/js/floorplan.js', 'public/floor-areas.js']) {
    const src = read(p);
    assert.ok(!src.includes('PLAN_PRINT_SCRIPT'), p + ': the auto-print script is gone');
    assert.ok(!src.includes('addEventListener("load",p)'), p + ': no load-fired print remains');
    assert.ok(src.includes('onclick="window.print()"'), p + ': the deliberate Print button remains');
  }
});
