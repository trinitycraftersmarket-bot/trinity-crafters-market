// §85 (Scott, Nov 24, 2026): on the floor plan, the only spot reference
// under a vendor's name was the bare number baked into the uploaded
// artwork ("under Salty Luna it says 6") — which doesn't say which
// room the booth is in. Every tag now carries the FULL spot ID
// (MR-06, H1-02, L-02) under the vendor name: the editor's draggable
// pins, the read-only plan views (organizer + vendor "mine" view),
// and the canvas renderer behind every plan printout.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const fp = readFileSync(new URL('../public/v2/js/floorplan.js', import.meta.url), 'utf8');
const fe = readFileSync(new URL('../public/v2/js/flooredit.js', import.meta.url), 'utf8');
const css = readFileSync(new URL('../public/v2/css/app.css', import.meta.url), 'utf8');

test('§85: the editor pin shows the full spot ID under the name', () => {
  assert.ok(fe.includes("'<span class=\"pin-spot\">' + esc(id) + '</span>'"), 'editor pin appends the spot span');
  assert.ok(!fe.includes('pin.textContent = String(vendor.business'), 'the name-only textContent pin is gone');
});

test('§85: the read-only plan views show the full spot ID under the name', () => {
  // floorplan.js source mixes \" and plain quotes in its HTML strings,
  // so pin on the quote-free seams around the spot span instead.
  assert.ok(fp.includes("esc(p.label) + '<span class="), 'organizer plan view pin opens a span after the label');
  assert.ok(fp.includes("esc(p.spot) + '</span></span>'"), 'organizer plan view pin prints the spot inside it');
  assert.ok(fp.includes('<span class="pin-spot">${esc(p.spot)}</span>'), 'vendor plan view pin carries the spot');
  assert.ok(css.includes('.fp-pin .pin-spot{display:block'), 'the spot line has its own style');
});

test('§85: the printed plan canvas draws the full spot ID under the name', () => {
  assert.ok(fp.includes('ctx.fillText(p.spot, cx, y + padY + lines.length * lineH)'), 'canvas draws the spot under the name lines');
  assert.ok(fp.includes('ctx.measureText(p.spot)'), 'the tag box widens for the spot text');
});
