// §66 — The printed attendance list must show the ONLINE check-in
// state (Nov 12, 2026). buildAttendanceReport (public/attendance-
// hotfix.js) scrapes the on-screen .inspection-row cards; its
// Attendance column carried only the ORGANIZER-marked state
// (Checked in / No show / Not marked). The vendor's own online
// check-in — the card's "Online Check-In: Completed ✓ / Not
// completed" line, from bookings.setup_checkin_at — was never
// scraped, so a vendor who had checked in online (Faces of Promise,
// Nov 28) printed as "Not marked" with no trace of it. The scrape
// now reads the Online Check-In line and prints it as a sub-line in
// the Attendance cell ("Online check-in: Completed ✓" /
// "Online check-in: Not completed"); the fixed 8-column layout, the
// other columns' scrapes and the correction highlighting are
// unchanged.
//
// Test pattern follows §51 (print-controls): stub the document,
// load the browser script, exercise the real builder, assert on the
// generated HTML. attendance-hotfix.js is a classic script, so it
// is loaded into a vm context whose globals are the stubs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = p => readFileSync(join(root, p), 'utf8');
const SRC = read('public/attendance-hotfix.js');

// ---------------------------------------------------------------- static pins
test('§66: the report scrapes the Online Check-In line and prints it in the Attendance cell', () => {
  assert.ok(SRC.includes("onlineCheckin=(allText.match(/Online Check-In:\\s*(Completed|Not completed)/i)||[])[1]||'Not completed'"), 'the scrape reads the card Online Check-In line, defaulting to Not completed');
  assert.ok(SRC.includes("<div>Online check-in: ${onlineCheckin==='Completed'?'Completed ✓':'Not completed'}</div>"), 'the Attendance cell carries the online check-in sub-line');
  // Untouched neighbors: the organizer Attendance scrape, the
  // correction highlighting and the other columns stay as they were.
  assert.ok(SRC.includes("attendance=(allText.match(/Attendance:\\s*(Checked in|No show|Not marked)/i)||[])[1]||'Not marked'"), 'the organizer Attendance scrape is unchanged');
  assert.ok(SRC.includes("alert=inspection==='Needs correction'||inspection==='Refused'"), 'the correction-row rule is unchanged');
  assert.ok(SRC.includes('<th>#</th><th>Vendor / Business</th><th>Category</th><th>Space</th><th>Phone</th><th>Inspection</th><th>Attendance</th><th>Setup Arrival</th>'), 'the fixed 8-column layout is unchanged');
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

const completedRow = () => fakeRow({
  name: 'Faces of Promise inc.',
  firstP: "Kemberly K Arfaras · Children's Products · inside",
  text: "Faces of Promise inc. Booking ID: e264bb39 Kemberly K Arfaras · Children's Products · inside Phone: 3522507777 · Email: facesofpromise2@gmail.com Attendance: Not marked Online Check-In: Completed ✓ Setup Arrival: —"
});
const notCompletedRow = () => fakeRow({
  name: 'Quiet Quilts',
  firstP: 'Pat Payer · Quilts · inside',
  text: 'Quiet Quilts Booking ID: abcd1234 Pat Payer · Quilts · inside Phone: 3525550100 · Email: pat@example.com Attendance: Not marked Online Check-In: Not completed Setup Arrival: 8:30 AM'
});

test('§66 (behavioral): a card with Online Check-In Completed prints as completed on paper', () => {
  const { build, state } = loadReportBuilder();
  state.rows = [completedRow()];
  const html = build();
  assert.ok(html, 'a report is generated');
  assert.ok(html.includes('Online check-in: Completed ✓'), 'the printed Attendance cell shows the completed online check-in');
  assert.ok(html.includes('Not marked'), 'the organizer-marked state still prints alongside it');
  assert.ok(html.includes('Faces of Promise inc.'), 'the vendor row itself prints');
});

test('§66 (behavioral): a card without a completed online check-in prints as not completed', () => {
  const { build, state } = loadReportBuilder();
  state.rows = [notCompletedRow()];
  const html = build();
  assert.ok(html, 'a report is generated');
  assert.ok(html.includes('Online check-in: Not completed'), 'the printed Attendance cell shows the online check-in is not completed');
  assert.ok(!html.includes('Completed ✓'), 'nothing on the page claims a completed check-in');
  assert.ok(html.includes('8:30 AM'), 'the Setup Arrival column still scrapes as before');
});
