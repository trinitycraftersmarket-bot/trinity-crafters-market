// §75 (Nov 18, 2026): the print pages' return controls actually return.
// The §74 browser verification passed everything except the way back:
// clicking Close or "← Back to the app" did nothing. Cause: since §74
// the print page is rendered into the app's own tab at the app's own
// URL, so the §36/§72 return chain's steps are no-ops there —
// history.back() has no print entry to go back to, and location.href
// to the same path only drops the hash (a same-document navigation:
// no reload, no navigation). §75 makes both controls RELOAD:
// location.reload() re-fetches the app from the server at the print
// page's URL (the app's hash route survives, so the organizer lands
// exactly where they printed from), and the fallback/back-link URL
// gains '?from=print' so it really navigates even with JS off.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = p => readFileSync(join(root, p), 'utf8');
const PRINT = read('public/v2/js/print.js');
const FP = read('public/v2/js/floorplan.js');
const CLASSIC = read('public/floor-areas.js');

test('§75: the shared print controls reload back into the app', () => {
  assert.ok(PRINT.includes('if(!window.closed)location.reload()},300)'), 'Close falls back to a reload, not history.back');
  assert.ok(PRINT.includes("location.href='https://trinitylutzmarkets.com/v2/?from=print'"), 'the last-resort URL differs from the app path, so it navigates');
  assert.ok(PRINT.includes('href="https://trinitylutzmarkets.com/v2/?from=print" onclick="location.reload();return false;"'), 'the Back link reloads with JS and still navigates without it');
  const controls = PRINT.slice(PRINT.indexOf('function printControls()'));
  assert.ok(!controls.slice(0, controls.indexOf('\n}')).includes('history.back'), 'no history.back step remains in the shared controls handler');
});

test('§75: the floor-plan print controls reload back into the app', () => {
  for (const [name, src, base] of [['v2 floorplan', FP, 'https://trinitylutzmarkets.com/v2/'], ['classic floor-areas', CLASSIC, 'https://trinitylutzmarkets.com/']]) {
    const reloads = src.match(/if\(!window\.closed\)location\.reload\(\)\},300\)/g) || [];
    assert.equal(reloads.length, 2, name + ': both Close chains reload');
    const links = src.match(new RegExp('href="' + base.replace(/\//g, '\\/') + '\\?from=print" onclick="location\\.reload\\(\\);return false;"', 'g')) || [];
    assert.equal(links.length, 2, name + ': both Back links reload / navigate');
    assert.ok(!src.includes('history.back'), name + ': no history.back step remains');
  }
});
