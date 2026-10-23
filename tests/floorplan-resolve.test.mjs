// Download/print pin resolution (Oct 23, 2026 fix): the composed
// floor-plan image is drawn from resolvePins(area, vendors), shared by
// the editor Download, both Print paths and — via the client's
// compose-on-send — the setup email attachments. Attendee rows carry
// TWO id spaces: the row id (booking / imported-attendee id) and the
// master vendor id (row.vendor_id). Assignments recorded against
// either space must resolve to a name; a lookup that tries only the
// row id silently drops those pins and the "completed" plan downloads
// without the vendor's name.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const fp = await import(new URL('../public/v2/js/floorplan.js', import.meta.url));
const flooredit = readFileSync(join(root, 'public/v2/js/flooredit.js'), 'utf8');

const rows = [
  ['Ken Miller', 'Ken Miller'], ['Bomme Lee', 'Bomme Lee'],
  ['Handmade with Love by Pam', 'Pam'], ['Karen Goodwin', 'Karen Goodwin'],
  ["Destiny's Sweet Co", 'Destiny'], ['Salty Luna Co', 'Ashley Paige'],
  ['C & L Enterprises', 'C & L'], ['Seas the Moment Travel', 'Scott Weber'],
  ["Pat's Potions", 'Pat']
].map(([business, name], i) => ({
  id: 'row-uuid-' + (i + 1), vendor_id: 'master-uuid-' + (i + 1),
  name, business, email: 'v' + i + '@x.com', space: 'indoor', status: 'paid', products: 'goods'
}));
const areaWith = vendorKey => ({
  area_key: 'main', title: 'Indoor Room', prefix: 'HI', capacity: 9, space_type: 'indoor',
  image_data_url: 'data:image/jpeg;base64,AAAA',
  assignments: Object.fromEntries(rows.map((r, i) => ['HI-0' + (i + 1), { vendor_id: r[vendorKey] }]))
});

test('resolvePins: assignments storing the floor-attendees row id resolve every name', () => {
  const pins = fp.resolvePins(areaWith('id'), rows);
  assert.equal(pins.length, 9);
  assert.deepEqual(pins.map(p => p.label), rows.map(r => r.business));
  assert.equal(pins[0].spot, 'HI-01');
});

test('resolvePins: assignments storing the MASTER vendor id resolve the same names', () => {
  const pins = fp.resolvePins(areaWith('vendor_id'), rows);
  assert.equal(pins.length, 9, 'master-id assignments must not silently drop every pin');
  assert.deepEqual(pins.map(p => p.label), rows.map(r => r.business));
});

test('resolvePins: unknown ids are skipped, known neighbours still resolve', () => {
  const area = areaWith('id');
  area.assignments['HI-02'] = { vendor_id: 'no-such-row' };
  const pins = fp.resolvePins(area, rows);
  assert.equal(pins.length, 8);
  assert.ok(!pins.some(p => p.spot === 'HI-02'));
});

test('vendorLabel: both id spaces, row id wins, empty ids stay null', () => {
  assert.equal(fp.vendorLabel(rows, rows[3].id), 'Karen Goodwin');
  assert.equal(fp.vendorLabel(rows, rows[3].vendor_id), 'Karen Goodwin');
  assert.equal(fp.vendorLabel(rows, 'missing'), null);
  assert.equal(fp.vendorLabel(rows, ''), null);
  assert.equal(fp.vendorLabel(rows, null), null);
  assert.equal(fp.vendorLabel([], rows[0].id), null);
});

test('editor wiring: download refuses a silently nameless file, email sends composed named plans + test mode', () => {
  assert.ok(flooredit.includes('resolvePins(area, state.vendors)'), 'the download path checks pin resolution before composing');
  assert.ok(flooredit.includes('Vendor names could not be matched to the spots on this plan'), 'unresolvable names surface as an error instead of a nameless download');
  assert.ok(flooredit.includes('composePlanCanvas(a, state.vendors)'), 'the email flow composes each area with the shared composer');
  assert.ok(flooredit.includes('area_images: attach ? await composeAreaImages() : {}'), 'the real send ships the composed named plans keyed by area');
  assert.ok(flooredit.includes('area_images: attach ? await composeAreaImages() : {}, test: true'), 'the test send composes exactly like the real send, plus the test flag');
  assert.ok(flooredit.includes('id="fe-send-test">Send test email</button>'), 'the Send test email button sits beside Send');
  assert.ok(flooredit.includes("'Test setup email sent to ' + (r.sent_to || 'your email address')"), 'the test toast names the address it went to');
});
