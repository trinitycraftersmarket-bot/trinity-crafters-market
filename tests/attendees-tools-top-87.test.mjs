// §87 (Scott, Nov 24, 2026, with screenshots): on the Attendees
// screen the action buttons (Export CSV / Import / Print attendance
// list / Approve all / Open Event Day) sat BELOW all 33 vendor cards —
// he had to scroll the whole list to print. "move the buttons to the
// top." And the print view the Print button opens crushed every
// column to single letters on his phone ("SP ACE", "SETU P ARRI
// VAL") because the screen stylesheet zeroed the table's min-width;
// the printed page itself was fine. The screen view now keeps a
// readable 680px table and scrolls sideways instead.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const att = readFileSync(new URL('../public/v2/js/attendees.js', import.meta.url), 'utf8');
const prn = readFileSync(new URL('../public/v2/js/print.js', import.meta.url), 'utf8');
const css = readFileSync(new URL('../public/v2/css/app.css', import.meta.url), 'utf8');

test('§87: the Attendees action buttons render above the vendor cards', () => {
  const tools = att.indexOf('att-tools');
  const list = att.indexOf('id="v2-att-list"');
  assert.ok(tools > -1 && list > -1 && tools < list, 'the tools row comes before the vendor list in the template');
  for (const id of ['v2-att-csv', 'v2-att-import', 'v2-att-print', 'v2-att-insp-all'])
    assert.ok(att.slice(tools, list).includes(id), id + ' rides in the top tools row');
  assert.ok(css.includes('.att-tools{margin:14px 0}'), 'the tools row keeps breathing room in its new spot');
});

test('§87: the attendance print view no longer crushes columns on a phone screen', () => {
  const block = prn.slice(prn.indexOf('export function printAttendance'), prn.indexOf('export function printExpenseReport'));
  assert.ok(block.includes('@media screen{body{overflow-x:auto}table{min-width:680px}}'), 'screen view: readable min-width + sideways scroll');
  assert.ok(!block.includes('table{min-width:0}'), 'the crushing rule is gone');
  assert.ok(block.includes('@page{size:letter portrait;margin:0;background:#fff}'), 'the printed page itself is unchanged');
});
