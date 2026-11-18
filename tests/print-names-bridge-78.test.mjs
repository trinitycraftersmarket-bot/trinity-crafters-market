// §78 (Scott, Nov 18, 2026): two complaints in one message — "Print
// button still fails" and "Names on floor plan on the print screen
// not listed."
//
// Names: a same-day browser inspection proved the names WERE drawn on
// the plan images (every assigned table carried its tag) — but the
// tags are drawn at ~1.7% of the image width, so on a phone screen
// they shrink to unreadable specks and the plans honestly read as
// nameless. §78 lists every plan's vendors as plain text under the
// image ("MR-19 — Angels of Hope"), in the Attendees printout and in
// both floor-plan printouts (v2 + classic), from the same resolved
// pins that draw the tags — one source, so the list can't drift.
//
// Print button: every Print button was a bare window.print(), which
// is a no-op inside the Android app WebView — the app is a Capacitor
// shell (server.url loads the live site). §78 makes the buttons
// bridge-aware: if the native shell's TrinityPrint bridge exists
// (MainActivity, added in this section), it opens the Android print
// dialog for the current page; otherwise window.print() as before.
// The bridge half ships in the APK, so in-app printing starts with
// the next app build; the web half is live immediately.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = p => readFileSync(join(root, p), 'utf8');

function captureWindow() {
  const doc = { html: '', write(s) { this.html += s; }, close() {} };
  const win = { document: doc, focus() {}, addEventListener() {}, print() {} };
  globalThis.window = { open: () => win };
  return doc;
}

test('§78 (behavioral): the attendance print lists vendor names as text under each plan', async () => {
  const doc = captureWindow();
  const { printAttendance } = await import(new URL('../public/v2/js/print.js', import.meta.url));
  printAttendance({
    market: 'Lutz Crafter\'s Market', subtitle: 'Sat, November 28, 2026', summary: '37 vendors',
    headers: ['Space', 'Spot', 'Business'], rows: [['Inside', 'MR-19', 'Angels of Hope']],
    plans: [
      { title: 'Main Event Room', image: 'data:image/png;base64,AAAA', names: ['MR-19 — Angels of Hope', 'MR-05 — Pat\'s Potions'] },
      { title: 'Outside', image: 'data:image/png;base64,BBBB' }
    ],
    legend: 'Spot key: MR = Main Event Room'
  });
  const html = doc.html;
  assert.ok(html.includes('Vendor names — Main Event Room'), 'the names block is headed by the area');
  assert.ok(html.includes('<li>MR-19 — Angels of Hope</li>'), 'spot + name listed as text');
  assert.ok(html.includes('<li>MR-05 — Pat&#39;s Potions</li>') || html.includes("<li>MR-05 — Pat's Potions</li>"), 'names are escaped into the list');
  assert.equal(html.split('<div class="plan-names">').length - 1, 1, 'exactly one names block — the unnamed plan gets none');
  assert.ok(html.includes('TrinityPrint.print()'), 'the Print button tries the app bridge first');
});

test('§78: every print path carries the names list and the bridge-aware Print button', () => {
  const att = read('public/v2/js/attendees.js');
  assert.ok(att.includes("names: pins.map(p => p.spot + ' — ' + p.label)"), 'Attendees passes the resolved pins as the names list');
  const fp = read('public/v2/js/floorplan.js');
  assert.ok(fp.includes('<div class="plan-names"><strong>Vendor names:</strong> '), 'v2 floor-plan print lists names under the plan');
  assert.ok(fp.includes('t.pins.map(p => esc(p.spot)'), 'v2 names come from the same pins that draw the tags');
  const classic = read('public/floor-areas.js');
  assert.ok(classic.includes('<div class="plan-names"><strong>Vendor names:</strong> '), 'classic floor-plan print lists names too');
  assert.ok(classic.includes('pins.push({spot:id,'), 'classic pins carry their spot id for the list');
  for (const p of ['public/v2/js/print.js', 'public/v2/js/floorplan.js', 'public/floor-areas.js']) {
    const src = read(p);
    assert.ok(!src.includes('onclick="window.print()"'), p + ': no bare window.print() Print button remains');
    assert.ok(src.includes('TrinityPrint.print()'), p + ': the Print button is bridge-aware');
  }
  const print = read('public/v2/js/print.js');
  assert.ok(!print.includes("addEventListener('load', () => w.print())"), 'the expense report no longer auto-fires print on load (§76 completed)');
});

test('§78: the Android shell exposes the TrinityPrint bridge', () => {
  const java = read('android/app/src/main/java/com/trinitylutzmarkets/app/MainActivity.java');
  assert.ok(java.includes('addJavascriptInterface(new TrinityPrintBridge(), "TrinityPrint")'), 'the bridge is registered under the name the web buttons call');
  assert.ok(java.includes('createPrintDocumentAdapter'), 'the bridge prints the WebView through the Android PrintManager');
  assert.ok(java.includes('@JavascriptInterface'), 'the print method is exposed to JavaScript');
});
