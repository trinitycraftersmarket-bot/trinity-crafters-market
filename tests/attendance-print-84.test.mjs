// §84 (Scott, Nov 24, 2026): the printed Attendance List is a door list,
// not a data dump. Drop the Email, Payment, Attendance and Inspection
// columns (Scott works those in the app); keep Space, Spot, Category,
// Phone, Setup Arrival and Tables; end every row with an empty Checked
// In box to tick by hand. Business and Vendor share ONE column —
// business first, the person's name after it when the two differ — so
// nobody standing at the door is unfindable and nothing else had to go.
// Plain and readable: no heavy frame, larger type (11pt), roomier rows.
// Order stays check-in order (§71) with the no-check-in vendors at the
// bottom — now in ABC order (§84 tie-break). The whole packet prints
// portrait, list and floor plans alike: one orientation, no print
// surprises at a busy event.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const attendees = readFileSync(new URL('../public/v2/js/attendees.js', import.meta.url), 'utf8');
const print = readFileSync(new URL('../public/v2/js/print.js', import.meta.url), 'utf8');
const attBlock = print.slice(print.indexOf('<title>Attendance List</title>'), print.indexOf('<title>Attendance List</title>') + 2200);

test('§84: the door list prints exactly the eight kept columns', () => {
  assert.ok(attendees.includes("headers: ['Space', 'Spot', 'Business / Vendor', 'Category', 'Phone', 'Setup Arrival', 'Tables', 'Checked In']"),
    'headers are the §84 set, in order');
  assert.ok(!/headers: \[[^\]]*'(Email|Payment|Attendance|Inspection)'/.test(attendees),
    'no dropped column survives in the print headers');
});

test('§84: business and vendor share one column, person named when different', () => {
  assert.ok(attendees.includes("(r.business || '') + (r.name && r.name !== r.business ? ' — ' + r.name : '')"),
    'combined name cell: business first, person after it, once when identical');
});

test('§84: every printed row ends with the hand-tick checkbox', () => {
  assert.ok(attendees.includes("'☐'"), 'rows carry the ballot-box cell');
  assert.ok(attBlock.includes('chk'), 'printAttendance renders the checkbox cell large');
  assert.ok(attBlock.includes('.chk{font-size:15pt'), 'checkbox glyph is oversized for a pen tick');
});

test('§84: order is check-in time, names in ABC order by first name inside it', () => {
  assert.ok(attendees.includes("String(a.setup_arrival_time || '99:99')"), 'missing times still sort last');
  assert.ok(attendees.includes("String(a.name || a.business || '').localeCompare(String(b.name || b.business || ''))"),
    'inside a time, names sort by the person\'s first name');
});

test('§84: the list prints in headed sections, one per check-in time', () => {
  assert.ok(attendees.includes("heading: key ? 'Check-in ' + (ARRIVAL_PRINT[key] || key) : 'No check-in time chosen'"),
    'sections are headed by their check-in time; the no-check-in section comes last');
  assert.ok(attendees.includes('groups,'), 'attendees passes sections to the printer');
  assert.ok(print.includes('class=\\"grp\\"'), 'printAttendance renders section headings');
  assert.ok(attBlock.includes('.grp{font-size:12.5pt'), 'section headings are styled in the print CSS');
});

test('§84: the print is plain, readable and portrait throughout', () => {
  assert.ok(attBlock.includes('font-size:11pt'), 'body type bumped to 11pt');
  assert.ok(attBlock.includes('th,td{padding:7px 6px;'), 'roomier rows');
  assert.ok(attBlock.includes('@page{size:letter portrait;margin:.5in}'), 'the list page is portrait');
  assert.ok(!attBlock.includes('planpage'), 'no mixed-orientation named pages');
  assert.ok(attBlock.includes('.plan img{width:100%;max-height:9in'), 'plan image sized for the portrait page');
});
