// §82 (Scott, Nov 21, 2026): "add to the category flag with who is
// there and what they sell." The §19 who-sells-what comparison lived in
// a separate panel under the card; the category flag itself only named
// the filled category. §82 folds the holders into the flag: when the
// application-conflicts payload has vendors holding the filled
// category on that date, the flag gains an "Already in <Category>:"
// block with one "<Business> sells <products>" line per holder (the
// owner's line format, shared with the panel). The separate panel now
// renders only when the saved-scan flag does not — the same holders
// are never shown twice on one card — and still covers rows the flag
// skips (e.g. wait-list). Display only: no payload, limit, or
// approve-anyway change.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = p => readFileSync(join(root, p), 'utf8');
const APP = read('public/v2/js/applications.js');

test('§82: the category flag carries the holders of the filled category', () => {
  assert.ok(APP.includes('function conflictHoldersHtml(b)'), 'holders block builder exists');
  assert.ok(APP.includes('<strong>Already in ${esc(c.category)}:</strong>'), 'flag names the filled category before the holders');
  assert.ok(APP.includes('c.vendors.map(v => sellsLine(v.business, v.sells))'), 'one sells line per holder from the conflicts payload');
  assert.ok(APP.includes("${conflictHoldersHtml(b)}</p>` : ''}"), 'holders render inside the category flag paragraph');
});

test('§82: holder lines share the panel line format and never invent products', () => {
  assert.ok(APP.includes("const sellsLine = (business, sells) =>"), 'one shared line builder');
  assert.ok(APP.includes("'products not listed'"), 'empty product text falls back, never invented');
  assert.ok(APP.includes('sellsLine(c.applicant.business, c.applicant.sells)'), 'panel keeps the applicant line via the shared builder');
});

test('§82: the separate who-sells-what panel yields when the flag is shown', () => {
  assert.ok(APP.includes("${flag ? '' : conflictPanelHtml(b)}"), 'panel suppressed on flagged cards — holders shown once, in the flag');
  assert.ok(APP.includes('function conflictPanelHtml(b)'), 'panel still exists for rows the saved-scan flag skips');
});
