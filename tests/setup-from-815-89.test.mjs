// §89 (Scott, Nov 24, 2026): "change setup from 8:30 to 8:15" —
// the displayed setup start moves to 8:15 AM everywhere it is
// stated: the Market Day next-market pill, the vendor's next-market
// note, and the setup email intro. The vendor arrival CHOICES
// (8:15 / 8:30 / 8:45 / 9:00) are untouched — vendors can still
// pick 8:30; setup simply OPENS at 8:15.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const home = readFileSync(new URL('../public/v2/js/home.js', import.meta.url), 'utf8');
const vendor = readFileSync(new URL('../public/v2/js/vendor.js', import.meta.url), 'utf8');
const flooredit = readFileSync(new URL('../public/v2/js/flooredit.js', import.meta.url), 'utf8');

test('§89: setup opens at 8:15 AM in every displayed statement', () => {
  assert.ok(home.includes("const SETUP_FROM = '8:15 AM'"), 'Market Day pill source');
  assert.ok(vendor.includes('Setup from 8:15 AM — be ready by 9:45 AM.'), 'vendor next-market note');
  assert.ok(flooredit.includes('Setup begins as early as 8:15 AM.'), 'setup email intro');
  assert.ok(!home.includes("'8:30 AM'") && !vendor.includes('Setup from 8:30'), 'no stale 8:30 statement left');
  assert.ok(vendor.includes('<option>08:30</option>'), 'the 8:30 arrival choice itself stays');
});
