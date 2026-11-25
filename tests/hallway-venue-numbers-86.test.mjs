// §86 (Scott, Nov 24, 2026): "Fizzy Jill is H1-23, Cottage Prims
// H1-24, Sylvia H1-25, Mindi is H1-26, and Dorian is H1-27. Then
// H2-28 is Blank, H2-29 is Pamela and H2-30 is Barb. Please change
// the labels on each to be correct on the report." The Hilton Garden
// Inn numbers booths continuously: Main Room 1–21, Hallway 1 = 23–27,
// Hallway 2 = 28–30. Storage keys stay H1-01… (the server's save
// merge + validation enumerate prefix-(i+1)); spotLabel() is the only
// number a person reads — reports, plan tags, booth lists, emails.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spotLabel, SPOT_LABEL_START } from '../public/v2/js/floorplan.js';

const fp = readFileSync(new URL('../public/v2/js/floorplan.js', import.meta.url), 'utf8');
const fe = readFileSync(new URL('../public/v2/js/flooredit.js', import.meta.url), 'utf8');
const at = readFileSync(new URL('../public/v2/js/attendees.js', import.meta.url), 'utf8');
const api = readFileSync(new URL('../netlify/functions/api.mjs', import.meta.url), 'utf8');

test('§86: hallway storage keys read as venue booth numbers', () => {
  assert.deepEqual(SPOT_LABEL_START, { H1: 23, H2: 28 });
  assert.equal(spotLabel('H1-01'), 'H1-23'); // Fizzy Jill
  assert.equal(spotLabel('H1-02'), 'H1-24'); // Cottage Prims
  assert.equal(spotLabel('H1-03'), 'H1-25'); // Sylvia
  assert.equal(spotLabel('H1-04'), 'H1-26'); // Mindi
  assert.equal(spotLabel('H1-05'), 'H1-27'); // Dorian
  assert.equal(spotLabel('H1-06'), 'H1-28'); // beyond the 5 — visible until moved/cleared
  assert.equal(spotLabel('H2-01'), 'H2-28');
  assert.equal(spotLabel('H2-02'), 'H2-29'); // Pamela
  assert.equal(spotLabel('H2-03'), 'H2-30'); // Barb
});

test('§86: every other prefix reads unchanged', () => {
  assert.equal(spotLabel('MR-06'), 'MR-06');
  assert.equal(spotLabel('MR-21'), 'MR-21');
  assert.equal(spotLabel('L-02'), 'L-02');
  assert.equal(spotLabel('OUT-01'), 'OUT-01');
  assert.equal(spotLabel('HI-04'), 'HI-04');
  assert.equal(spotLabel(''), '');
  assert.equal(spotLabel('nonsense'), 'nonsense');
});

test('§86: the reports and lists print labels, never storage keys', () => {
  assert.ok(fp.includes('boothRows.push({ id: spotLabel(id)'), 'booth assignments report rows carry the label');
  assert.ok(fp.includes('open.push(spotLabel(id))'), 'open-booth summary carries labels');
  assert.ok(at.includes('spotLabel(f.spot)'), 'attendance list + vendor cards carry the label');
  assert.ok(fe.includes('esc(spotLabel(id))'), 'editor booth rows and picker carry the label');
  assert.ok(api.includes('list.push(spotLabelServer(spot))'), 'vendor setup email notes carry the label');
  assert.ok(api.includes('SPOT_LABEL_START={H1:23,H2:28}'), 'server label map matches the client');
});

test('§86: storage keys are untouched — spotId still enumerates from 1', () => {
  assert.ok(fp.includes("String(i + 1).padStart(2, '0')"), 'spotId generation unchanged');
  assert.ok(api.includes("const slot=prefix+'-'+String(i+1).padStart(2,'0')"), 'server save merge enumeration unchanged');
});
