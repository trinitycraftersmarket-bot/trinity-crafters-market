// §83 (Scott, Nov 24, 2026): "I want their elected check in time to
// show on this report, then grouped by time on the print out, anyone
// who didn't check in gets put at the bottom of the report."
//
// The Booth Assignments printout (v2 printBoothList + the classic
// printAssignments mirror) no longer renders one table per area. The
// data half: vendors elect a setup arrival time at online check-in
// (setup_arrival_time on bookings / imported_attendees, one of
// 08:15/08:30/08:45/09:00), but loadSetupRows never selected it, so
// the floor-attendees rows the printout is built from had no time to
// show. Both UNION branches now carry it. The print half: assigned
// booths are grouped by that elected time, earliest first, each group
// headed "Check-in 8:15 AM"; vendors with no elected time — they
// never completed online check-in — form the final group, "No
// check-in time chosen". Open booths leave the tables (they have no
// vendor and no time) and are listed on one summary line instead, so
// no information the old per-area tables carried is lost.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = p => readFileSync(join(root, p), 'utf8');
const FP = read('public/v2/js/floorplan.js');
const CLASSIC = read('public/floor-areas.js');
const API = read('netlify/functions/api.mjs');

test('§83: loadSetupRows carries setup_arrival_time for bookings and imported attendees', () => {
  const at = API.indexOf('async function loadSetupRows');
  assert.ok(at >= 0, 'loadSetupRows exists');
  const body = API.slice(at, API.indexOf('order by business,name', at));
  assert.ok(body.includes('b.setup_arrival_time'), 'bookings branch selects the elected time');
  assert.ok(body.includes('i.setup_arrival_time'), 'imported branch selects the elected time');
});

test('§83 (behavioral): boothCheckinGroups groups by elected time, earliest first, no-time last', () => {
  const start = FP.indexOf('export function boothCheckinGroups');
  assert.ok(start >= 0, 'boothCheckinGroups exists');
  const end = FP.indexOf('\n}\n', start);
  assert.ok(end > start, 'boothCheckinGroups extraction bounds');
  const boothCheckinGroups = new Function(FP.slice(start, end + 3).replace('export function', 'function') + '\nreturn boothCheckinGroups;')();
  const { groups, none } = boothCheckinGroups([
    { id: 'MR-09', name: 'Nine AM B', time: '09:00' },
    { id: 'H1-02', name: 'Early A', time: '08:15' },
    { id: 'MR-03', name: 'No Time', time: '' },
    { id: 'H1-01', name: 'Early B', time: '08:15' },
    { id: 'L-04', name: 'Nine AM A', time: '09:00' },
    { id: 'OUT-01', name: 'Null Time', time: null }
  ]);
  assert.deepEqual(groups.map(g => g.label), ['8:15 AM', '9:00 AM'], 'groups are labeled in 12-hour time, earliest first');
  assert.deepEqual(groups[0].rows.map(r => r.id), ['H1-01', 'H1-02'], 'rows sort by booth inside a group');
  assert.deepEqual(groups[1].rows.map(r => r.id), ['L-04', 'MR-09'], 'booth sort is natural across areas');
  assert.deepEqual(none.map(r => r.id), ['MR-03', 'OUT-01'], 'vendors with no elected time collect at the bottom');
});

test('§83: both booth printouts render the check-in groups and the open-booth line', () => {
  for (const [name, src] of [['v2', FP], ['classic', CLASSIC]]) {
    assert.ok(src.includes('boothCheckinGroups(boothRows)'), name + ' groups its assigned rows');
    assert.ok(src.includes('Check-in '), name + ' heads each group with its check-in time');
    assert.ok(src.includes('No check-in time chosen'), name + ' puts the no-time vendors in a final group');
    assert.ok(src.includes('not checked in online'), name + ' labels the final group honestly');
    assert.ok(src.includes('Open booths: '), name + ' lists open booths on a summary line');
    assert.ok(src.includes('vendor.setup_arrival_time'), name + ' reads the elected time off the attendee rows');
  }
  assert.ok(FP.includes('export function boothCheckinGroups'), 'v2 exports the grouping helper');
});
