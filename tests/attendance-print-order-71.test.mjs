// §71 (Scott, Nov 18, 2026): the printed attendance report must print in
// order of desired check-in time (the vendor's chosen setup arrival time),
// earliest to latest. Vendors who never picked a time have no desired
// check-in time and print last. Applies to BOTH printed lists: the classic
// buildAttendanceReport scrape (public/attendance-hotfix.js) and the v2
// Attendees "Print attendance list" (which also gains the Setup Arrival
// column so the order is visible on paper).
//
// The classic half is behavioral, following the §66 harness: stub the
// document, load the real script in a vm, feed it cards in scrambled
// arrival order, and read the generated HTML.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = p => readFileSync(join(root, p), 'utf8');
const SRC = read('public/attendance-hotfix.js');
const ATT = read('public/v2/js/attendees.js');

// ---------------------------------------------------------------- static pins
test('§71: the classic report sorts by setup arrival rank, no-time last', () => {
  assert.ok(SRC.includes("const arrivalRank=t=>({'8:15 AM':1,'8:30 AM':2,'8:45 AM':3,'9:00 AM':4}[t]||5)"), 'arrival rank map exists, unknown/no time ranks last');
  assert.ok(SRC.includes('vendorData.sort((a,b)=>arrivalRank(a.setupArrival)-arrivalRank(b.setupArrival))'), 'rows are sorted by arrival rank before printing');
  assert.ok(SRC.includes('const vendorRows=vendorData.map((v,i)=>'), 'the sorted data is what gets numbered and printed');
});

test('§71: the v2 print sorts by setup arrival and shows the time column', () => {
  assert.ok(ATT.includes("String(a.setup_arrival_time || '99:99')"), 'v2 print sorts on the stored arrival time with a last-place fallback');
  assert.ok(ATT.includes("'Setup Arrival'"), 'v2 print headers include Setup Arrival');
  assert.ok(ATT.includes('ARRIVAL_PRINT[String(r.setup_arrival_time'), 'v2 print renders the arrival label per row');
});

// ---------------------------------------------------------------- vm harness
function fakeRow({ name, firstP, text, classes = [] }) {
  const cls = new Set(classes);
  return {
    textContent: text,
    classList: { contains: c => cls.has(c) },
    parentElement: { parentElement: { textContent: 'Saturday, November 28, 2026' } },
    querySelector(sel) {
      if (sel === 'h3') return { textContent: name };
      if (sel === '.rowhead .tag') return { textContent: 'not inspected' };
      return null;
    },
    querySelectorAll(sel) {
      if (sel === 'p') return [{ textContent: firstP }];
      return [];
    }
  };
}

function loadReportBuilder() {
  const state = { rows: [] };
  const documentStub = {
    documentElement: {},
    addEventListener() {},
    createElement() { return { style: {}, dataset: {}, classList: { contains: () => false } }; },
    querySelectorAll(sel) { return sel === '.inspection-row' ? state.rows : []; },
    querySelector() { return null; }
  };
  class MutationObserverStub { observe() {} disconnect() {} }
  const sandbox = {
    document: documentStub,
    MutationObserver: MutationObserverStub,
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    window: { open: () => null },
    location: { reload() {} },
    alert() {},
    fetch: async () => { throw new Error('no network in tests'); },
    console
  };
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox, { filename: 'attendance-hotfix.js' });
  assert.equal(typeof sandbox.buildAttendanceReport, 'function', 'the script loads and exposes buildAttendanceReport');
  return { build: sandbox.buildAttendanceReport, state };
}

const row = (name, arrival) => fakeRow({
  name,
  firstP: `${name} Person · Goods · inside`,
  text: `${name} Booking ID: x ${name} Person · Goods · inside Phone: 3525550100 · Email: a@example.com Attendance: Not marked Online Check-In: ${arrival ? 'Completed ✓' : 'Not completed'} Setup Arrival: ${arrival || '—'}`
});

test('§71 (behavioral): the printed report runs earliest desired check-in first, no-time vendors last', () => {
  const { build, state } = loadReportBuilder();
  state.rows = [row('Nine Shop', '9:00 AM'), row('No Time Goods', null), row('Early Bird', '8:15 AM'), row('Half Past', '8:30 AM')];
  const html = build();
  assert.ok(html, 'a report is generated');
  const pos = n => html.indexOf(n);
  assert.ok(pos('Early Bird') < pos('Half Past'), '8:15 prints before 8:30');
  assert.ok(pos('Half Past') < pos('Nine Shop'), '8:30 prints before 9:00');
  assert.ok(pos('Nine Shop') < pos('No Time Goods'), 'a vendor with no chosen time prints after every timed vendor');
  assert.ok(html.includes('<td>1</td><td><strong>Early Bird</strong>'), 'the row numbers follow the new order');
  assert.ok(html.includes('<td>4</td><td><strong>No Time Goods</strong>'), 'the no-time vendor is numbered last');
});
