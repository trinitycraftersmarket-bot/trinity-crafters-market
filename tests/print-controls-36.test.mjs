// §36 — Printable reports trap in the app (Oct 24, 2026). Scott, from the
// Reports tab: the AR sheet opened as black text on the app's deep green —
// unreadable — filling the screen with no way back. Root cause: print.js's
// builders window.open() a bare document whose CSS sets a dark text color
// but NO background, then window.onload → window.print(). In the Android
// app WebView (1) window.print() is a no-op, (2) the document has no
// background of its own so the WebView's dark backdrop shows through, and
// (3) there are no controls at all. Fix: every builder forces a light
// canvas (body background #fff + color-scheme: light) and prepends ONE
// shared screen-only controls row (Print / Save PDF unchanged, Close with
// the §34 fallback to the app, the phone hint), hidden under @media print
// so the paper output is identical.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = p => readFileSync(join(root, p), 'utf8');
const FALLBACK = "location.href='https://trinitylutzmarkets.com/v2/'";
const HINT = 'On a phone? Printing lives in the browser menu';

// ---------------------------------------------------------------- static pins
test('§36: print.js has ONE shared controls helper + CSS, used by all three builders', () => {
  const src = read('public/v2/js/print.js');
  assert.ok(src.includes('function printControls()'), 'the shared controls helper must exist');
  assert.ok(src.includes('const PRINT_CONTROLS_CSS'), 'the shared controls CSS must exist');
  // 1 definition + 3 call sites (printTable, printAttendance, printExpenseReport).
  assert.equal(src.split('printControls()').length - 1, 4, 'all three builders must render the shared row');
  // 1 definition + 3 insertions into the builders' style blocks.
  assert.equal(src.split('PRINT_CONTROLS_CSS').length - 1, 4, 'all three builders must include the shared CSS');
  assert.ok(!src.includes('<button onclick="window.print()">Print / Save PDF</button>'),
    'the expense report lone Print button must be replaced by the shared row');
});

// ---------------------------------------------------------------- harness
// Same stubbed-window capture as the §31 print tests: the builders write
// into the window window.open() returns; capture document.write output.
function captureWindow() {
  const doc = { html: '', write(s) { this.html += s; }, close() {} };
  const win = { document: doc, focus() {}, addEventListener() {}, print() {} };
  globalThis.window = { open: () => win };
  return doc;
}

async function loadPrint() {
  captureWindow();
  return await import(new URL('../public/v2/js/print.js', import.meta.url));
}

function assertPrintableShell(html, label) {
  // Light canvas, forced.
  assert.ok(html.includes('background:#fff'), label + ': body must force a white background (§36)');
  assert.ok(html.includes('color-scheme:light'), label + ': CSS must declare color-scheme: light (§36)');
  // The shared controls row.
  assert.ok(html.includes('class="print-controls"'), label + ': controls row must be present');
  assert.equal(html.split('class="print-controls"').length - 1, 1, label + ': exactly one controls row');
  assert.ok(html.includes('window.print()">Print / Save PDF</button>'), label + ': Print / Save PDF button');
  assert.ok(html.includes('window.close()'), label + ': Close must call window.close()');
  assert.ok(html.includes('>Close</button>'), label + ': Close button is labelled');
  assert.ok(html.includes(FALLBACK), label + ': Close fallback must navigate back to the v2 app');
  assert.ok(html.includes(HINT), label + ': the phone hint must be present');
  // Screen only: the row must vanish on paper.
  assert.ok(html.includes('@media print{.print-controls{display:none}}'), label + ': @media print must hide the controls row');
}

// ---------------------------------------------------------------- builders
test('§36 (behavioral): printTable (the AR sheet) — light canvas, controls, paper markup unchanged', async () => {
  const { printTable } = await loadPrint();
  const doc = captureWindow();
  printTable('Accounts Receivable', 'Money owed to Trinity Crafters Market',
    ['Vendor', 'Email', 'Market / Period', 'Amount Due', 'Due Date'],
    [['Blissfully Bakery', 'blissfulbakerysd@gmail.com', 'Sat, January 9, 2027', '$30.00', '10/24/2026']],
    '33 outstanding · TOTAL DUE $1,890.08');
  const html = doc.html;
  assertPrintableShell(html, 'printTable');
  // Paper output unchanged: same @page, same table markup, auto-print kept.
  assert.ok(html.includes('@page{size:letter;margin:.5in}'), 'printTable: @page rule unchanged');
  assert.ok(html.includes('<table><thead><tr><th>Vendor</th><th>Email</th><th>Market / Period</th><th>Amount Due</th><th>Due Date</th></tr></thead>'), 'printTable: header row passes through untouched');
  assert.ok(html.includes('<tbody><tr><td>Blissfully Bakery</td><td>blissfulbakerysd@gmail.com</td><td>Sat, January 9, 2027</td><td>$30.00</td><td>10/24/2026</td></tr></tbody></table>'), 'printTable: body row passes through untouched');
  assert.ok(html.includes('<p class="summary">33 outstanding · TOTAL DUE $1,890.08</p>'), 'printTable: summary unchanged');
  assert.ok(html.includes('window.onload=()=>window.print()'), 'printTable: onload auto-print kept');
});

test('§36 (behavioral): printAttendance — light canvas, controls, paper markup unchanged', async () => {
  const { printAttendance } = await loadPrint();
  const doc = captureWindow();
  printAttendance({
    market: 'Hampton Inn Odessa',
    subtitle: 'Sat, October 24, 2026',
    summary: '9 vendors · 9 paid · 0 checked in',
    headers: ['Space', 'Business', 'Vendor'],
    rows: [['HI-01', 'A & B <Co>', 'Ann']],
    plans: [{ title: 'Indoor Room', image: 'data:image/png;base64,AAAA' }]
  });
  const html = doc.html;
  assertPrintableShell(html, 'printAttendance');
  assert.ok(html.includes('@page{size:letter;margin:.5in}'), 'printAttendance: @page rule unchanged');
  assert.ok(html.includes('<th>Space</th><th>Business</th><th>Vendor</th>'), 'printAttendance: header row passes through untouched');
  assert.ok(html.includes('<td>HI-01</td><td>A &amp; B &lt;Co&gt;</td><td>Ann</td>'), 'printAttendance: body row passes through untouched (still esc()-ed)');
  assert.ok(html.includes('.plan{break-before:page}'), 'printAttendance: floor plans still one per page');
  assert.ok(html.includes('<img src="data:image/png;base64,AAAA"'), 'printAttendance: original plan image still rendered');
  assert.ok(html.includes('window.onload=()=>setTimeout(()=>window.print(),50)'), 'printAttendance: onload auto-print kept');
});

test('§36 (behavioral): printExpenseReport — shared row replaces the lone button, paper markup unchanged', async () => {
  const { printExpenseReport } = await loadPrint();
  const doc = captureWindow();
  printExpenseReport(
    [{ expense_date: '2026-10-20', event_date: '2026-10-24', market: 'Hampton Inn Odessa', category: 'Supplies', description: 'Tablecloths', payee: 'Amazon', quantity: 0, amount: 4500, notes: '' }],
    'All expenses',
    () => false
  );
  const html = doc.html;
  assertPrintableShell(html, 'printExpenseReport');
  // The pre-§36 lone button is gone (the shared row's button carries type="button").
  assert.ok(!html.includes('<button onclick="window.print()">'), 'printExpenseReport: lone Print button replaced');
  // Paper output unchanged: landscape @page, itemized table, its own @media print button rule kept.
  assert.ok(html.includes('@page{size:letter landscape;margin:.45in}'), 'printExpenseReport: @page rule unchanged');
  assert.ok(html.includes('@media print{button{display:none}}'), 'printExpenseReport: its original @media print button rule kept');
  assert.ok(html.includes('<th>Expense date</th><th>Market date</th><th>Market</th><th>Category</th><th>Description / Payee</th><th>Qty</th><th>Amount</th><th>Notes</th>'), 'printExpenseReport: header row passes through untouched');
  assert.ok(html.includes('<strong>Tablecloths</strong><div>Amazon</div>'), 'printExpenseReport: row description/payee untouched');
  assert.ok(html.includes('<span>Total: $45.00</span>'), 'printExpenseReport: totals untouched');
});
