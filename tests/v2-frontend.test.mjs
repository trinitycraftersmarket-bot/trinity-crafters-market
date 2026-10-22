// Stage-1 v2 front end static checks (audit §10 Phase 3: the new UI is a
// self-contained app under public/v2 — it must never reach back into the
// legacy front end, reintroduce patch-layer techniques, or let its asset
// version stamps drift apart).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const v2 = join(root, 'public', 'v2');
const jsFiles = readdirSync(join(v2, 'js')).filter(f => f.endsWith('.js')).map(f => join(v2, 'js', f));
const allFiles = [
  join(v2, 'index.html'),
  join(v2, 'css', 'app.css'),
  ...jsFiles
];

test('v2 assets exist', () => {
  for (const f of allFiles) assert.ok(existsSync(f), `missing ${f}`);
  assert.ok(jsFiles.length >= 5, 'expected the v2 module set');
});

test('every v2 JS file parses as an ES module', () => {
  for (const f of jsFiles) execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' });
});

test('one version stamp across all v2 assets', () => {
  const versionSrc = readFileSync(join(v2, 'js', 'version.js'), 'utf8');
  const version = versionSrc.match(/VERSION = '([^']+)'/)?.[1];
  assert.ok(version, 'version.js must export a literal VERSION');
  for (const f of allFiles) {
    const src = readFileSync(f, 'utf8');
    for (const m of src.matchAll(/\?v=([0-9A-Za-z-]+)/g)) {
      assert.equal(m[1], version, `${f} uses stamp ${m[1]}, expected ${version}`);
    }
  }
  const html = readFileSync(join(v2, 'index.html'), 'utf8');
  assert.ok(html.includes(`/v2/js/app.js?v=${version}`), 'index.html must load the stamped app module');
  assert.ok(html.includes(`/v2/css/app.css?v=${version}`), 'index.html must load the stamped stylesheet');
});

test('v2 never references legacy front-end internals or patch techniques', () => {
  const banned = [
    'MutationObserver',          // audit §1 rule 2: no patch layers
    'localStorage',              // token lives in sessionStorage; no local copies of business data
    'account-hotfix', 'system-tools', 'attendance-hotfix', 'app-controls',
    '/app.js',                   // the legacy entry point (also catches /v2/js/app.js loader typos below)
    "from '../", 'from "..'      // imports must stay inside public/v2
  ];
  for (const f of jsFiles) {
    const src = readFileSync(f, 'utf8');
    for (const b of banned) assert.ok(!src.includes(b), `${f} must not reference ${b}`);
    // Module imports stay inside v2 and carry the version stamp.
    for (const m of src.matchAll(/from\s+'([^']+)'/g)) {
      assert.ok(m[1].startsWith('./'), `${f} imports outside v2: ${m[1]}`);
      assert.ok(m[1].includes('?v='), `${f} import lacks a version stamp: ${m[1]}`);
    }
  }
});

test('the five navigation groups and the stage-1 screens are defined once', () => {
  const app = readFileSync(join(v2, 'js', 'app.js'), 'utf8');
  for (const label of ['Market Day', 'Vendors', 'Money', 'Messages', 'Setup']) {
    assert.ok(app.includes(`label: '${label}'`), `missing nav group ${label}`);
  }
  assert.ok(app.includes("live: 'event-day'"), 'Event Day must be wired live in stage 1');
  const home = readFileSync(join(v2, 'js', 'home.js'), 'utf8');
  const day = readFileSync(join(v2, 'js', 'eventday.js'), 'utf8');
  assert.ok(home.includes("api") || home.includes('eventStats'), 'home renders from payload data');
  assert.ok(day.includes("'inspection'"), 'event day must use the inspection action');
  assert.ok(day.includes("'imported-attendance'") && day.includes("'attendance'"), 'event day must use both attendance actions');
  assert.ok(day.includes('refreshAdmin'), 'event day must re-fetch after mutations');
});

test('stage-2 modules exist and app.js routes to them', () => {
  for (const m of ['money', 'applications', 'attendees', 'waitlist', 'moves', 'vendors', 'payments', 'invoices']) {
    assert.ok(existsSync(join(v2, 'js', m + '.js')), `missing stage-2 module ${m}.js`);
  }
  const app = readFileSync(join(v2, 'js', 'app.js'), 'utf8');
  for (const live of ['attendees', 'applications', 'waitlist', 'directory', 'moves', 'payments', 'invoices']) {
    assert.ok(app.includes(`live: '${live}'`), `section registry must wire live: '${live}'`);
    assert.ok(app.includes(`'${live}'`), `router must accept the ${live} route`);
  }
  for (const renderer of ['renderAttendees', 'renderApplications', 'renderWaitlist', 'renderMoves', 'renderVendors', 'renderPayments', 'renderInvoices']) {
    assert.ok(app.includes(renderer), `app.js must dispatch to ${renderer}`);
  }
});

test('stage-2 screens use the same endpoints as the legacy UI', () => {
  const read = m => readFileSync(join(v2, 'js', m), 'utf8');
  const apps = read('applications.js');
  for (const s of ["'booking'", "'paypal-invoice'", "'paypal-sync'", "'payment-reminder-now'", "'reinstate-booking'", "'category-review-approve'", "'ban'", "'photo'"])
    assert.ok(apps.includes(s), `applications.js must use ${s}`);
  const att = read('attendees.js');
  for (const s of ["'move-space'", "'vendor-payment'", "'imported-attendance'", "'checkin-reminder'", "'featured-post'"])
    assert.ok(att.includes(s), `attendees.js must use ${s}`);
  assert.ok(!att.includes("'inspection'"), 'attendees management must not duplicate the Event Day inspection flow');
  const wait = read('waitlist.js');
  assert.ok(wait.includes("'waitlist-offer'"), 'waitlist.js must use the waitlist-offer action');
  assert.ok(wait.includes('waitlistOffers'), 'waitlist.js must read live offer state from the payload');
  const moves = read('moves.js');
  assert.ok(moves.includes("'move-requests'") && moves.includes('override_cutoff'), 'moves.js must use the move-requests function with the 48h override');
  const dirs = read('vendors.js');
  for (const s of ["'vendor-list'", "'vendor-profile'", 'organizer-save', "'vendor-save'", "'vendor-payment'", "'vendor-receipt'", "'vendor-statement-email'", "'vendor-reengage'"])
    assert.ok(dirs.includes(s), `vendors.js must use ${s}`);
  const pays = read('payments.js');
  assert.ok(pays.includes('paymentLog'), 'payments.js must render the server paymentLog');
  assert.ok(pays.includes('paymentGroups'), 'payments.js must group via the shared money module');
  const inv = read('invoices.js');
  for (const s of ["'imported-invoice-status'", "'imported-invoice-update'", "'imported-invoice-email'", "'imported-invoice-void'", "'vendor-payment'", "'vendor-receipt'", 'invoiceRows'])
    assert.ok(inv.includes(s), `invoices.js must use ${s}`);
  const moneyMod = read('money.js');
  for (const s of ['invoiceRows', 'invoiceStats', 'paymentGroups', 'isOverdue'])
    assert.ok(moneyMod.includes('export function ' + s), `money.js must export ${s}`);
});

test('stage-3a modules exist and app.js routes to them', () => {
  for (const m of ['flooredit', 'setup']) {
    assert.ok(existsSync(join(v2, 'js', m + '.js')), `missing stage-3a module ${m}.js`);
  }
  const app = readFileSync(join(v2, 'js', 'app.js'), 'utf8');
  for (const live of ['flooredit', 'dates', 'categories', 'managers', 'connections', 'surveys', 'archive', 'tools']) {
    assert.ok(app.includes(`live: '${live}'`), `section registry must wire live: '${live}'`);
    assert.ok(app.includes(`'${live}'`), `router must accept the ${live} route`);
  }
  for (const renderer of ['renderFloorEditor', 'renderDates', 'renderCategories', 'renderManagers', 'renderConnections', 'renderSurveys', 'renderArchive', 'renderTools']) {
    assert.ok(app.includes(renderer), `app.js must dispatch to ${renderer}`);
  }
  const version = readFileSync(join(v2, 'js', 'version.js'), 'utf8');
  assert.ok(version.includes("STAGE = 'Stage 3a'"), 'version.js must name Stage 3a');
});

test('one floor-plan implementation: shared pin math lives only in floorplan.js', () => {
  const fp = readFileSync(join(v2, 'js', 'floorplan.js'), 'utf8');
  for (const s of ['export function autoLabelPosition', 'export function resolvePins', 'export function resolvePinPosition', 'export async function renderSavedFloorPlan', 'export async function printFloorPlan', 'export function printBoothList', 'export function composePlanCanvas', 'export function fitPins'])
    assert.ok(fp.includes(s), `floorplan.js must export ${s}`);
  // Coordinates clamp into 0–100 at resolve time (the §13.9 vertical-strip
  // bug) and stacked pins cascade apart so every assigned vendor renders.
  assert.ok(fp.includes('Math.max(0, Math.min(100, n))'), 'floorplan.js must clamp coordinates into 0–100');
  assert.ok(fp.includes('cascade'), 'floorplan.js must document/apply the duplicate-pin cascade');
  assert.ok(fp.includes("api('floor-area-plans'"), 'the read-only renderer must read the one store');
  // No second copy of the math: neither the editor nor the Event Day view
  // may carry the venue label tables or its own clamp.
  for (const m of ['flooredit.js', 'eventday.js', 'attendees.js']) {
    const src = readFileSync(join(v2, 'js', m), 'utf8');
    assert.ok(!src.includes('mainRoomLabels'), `${m} must not copy the floor-plan label tables`);
  }
  const ed = readFileSync(join(v2, 'js', 'flooredit.js'), 'utf8');
  assert.ok(ed.includes("from './floorplan.js"), 'the editor must import the shared floor-plan module');
  const day = readFileSync(join(v2, 'js', 'eventday.js'), 'utf8');
  assert.ok(day.includes('renderSavedFloorPlan'), 'event day must render through the shared module');
  assert.ok(day.includes("navigate('flooredit'"), 'event day must link into the one editor');
});

test('stage-3a editor wiring: same store, same save, setup email', () => {
  const ed = readFileSync(join(v2, 'js', 'flooredit.js'), 'utf8');
  for (const s of ["api('floor-area-plans'", "api('floor-attendees'", "api('floor-area-plans-save'", "api('setup-email'"])
    assert.ok(ed.includes(s), `flooredit.js must use ${s}`);
  for (const s of ['base_areas', 'image_changed', 'venueDefaults', 'addHamptonHallway', 'printFloorPlan', 'printBoothList', 'composePlanCanvas'])
    assert.ok(ed.includes(s), `flooredit.js must include ${s} (legacy area-manager parity)`);
  // The legacy second store is never touched by the v2 editor.
  assert.ok(!ed.includes("'floor-plan-save'"), 'the editor must not write the legacy events.floor_plan store');
  assert.ok(!ed.includes("'floor-plan-image'"), 'the editor must not use the legacy single-image store');
});

test('stage-3a setup screens use the legacy endpoints at parity', () => {
  const s = readFileSync(join(v2, 'js', 'setup.js'), 'utf8');
  for (const a of ["'event'", "'location'", "'sync'", "'category'", "'event-category-limit'", "'staff-list'", "'staff-save'", "'bug-report-list'", "'survey-report'", "'email-test'", "'paypal-test'", 'organizer-tools'])
    assert.ok(s.includes(a), `setup.js must use ${a}`);
  assert.ok(s.includes("'moves:approve'"), 'managers screen must offer the moves:approve permission (§13.3)');
  assert.ok(s.includes("'floor_plans'"), 'managers screen must offer the floor_plans permission');
  for (const renderer of ['renderDates', 'renderCategories', 'renderManagers', 'renderConnections', 'renderSurveys', 'renderArchive', 'renderTools'])
    assert.ok(s.includes('export function ' + renderer), `setup.js must export ${renderer}`);
  // Mutating setup screens re-fetch before re-rendering.
  for (const marker of ['refreshAdmin'])
    assert.ok(s.includes(marker), `setup.js must ${marker} after mutations`);
});

test('bug-report inbox endpoint is additive and organizer-only', () => {
  const apiSrc = readFileSync(join(root, 'netlify', 'functions', 'api.mjs'), 'utf8');
  const idx = apiSrc.indexOf("action==='bug-report-list'");
  assert.ok(idx > 0, 'api.mjs must implement the bug-report-list action');
  const block = apiSrc.slice(idx, idx + 900);
  assert.ok(block.includes("who?.admin"), 'bug-report-list must require the organizer');
  assert.ok(block.includes('Organizer access only'), 'bug-report-list must refuse non-organizers');
  assert.ok(block.includes('from market.bug_reports'), 'bug-report-list must read the reports table');
  // The public report action still exists untouched above it.
  assert.ok(apiSrc.indexOf("action==='bug-report'") < idx, 'the public bug-report action must remain');
});

test('stage-2 screens re-fetch after mutations (server is the only truth)', () => {
  // Mutating screens re-fetch via ctx.refreshAdmin (or vendor-list for the
  // directory). payments.js is display-only — its freshness comes from the
  // router-level refreshAdmin before render, like home.js in stage 1.
  for (const m of ['applications.js', 'attendees.js', 'waitlist.js', 'invoices.js']) {
    const src = readFileSync(join(v2, 'js', m), 'utf8');
    assert.ok(src.includes('refreshAdmin'), `${m} must re-fetch after mutations`);
  }
  assert.ok(readFileSync(join(v2, 'js', 'vendors.js'), 'utf8').includes("api('vendor-list')"), 'vendors.js must re-fetch vendor-list');
  const css = readFileSync(join(v2, 'css', 'app.css'), 'utf8');
  for (const cls of ['.pay-row', '.pay-group-head', '.filter-card', '.checkline', '.flag-note', '.mini-row'])
    assert.ok(css.includes(cls), `app.css must style ${cls} (stage-2 components)`);
});

test('stage-3a components are styled', () => {
  const css = readFileSync(join(v2, 'css', 'app.css'), 'utf8');
  for (const cls of ['.fe-pin', '.fe-placeholder', '.fe-card', '.panel-details', '.panel-body', '.conn-row', '.content-card', '.sheet-grid', '.login-log'])
    assert.ok(css.includes(cls), `app.css must style ${cls} (stage-3a components)`);
  // Editor pins must be interactive where read-only pins are not.
  assert.ok(css.includes('.fe-pin{pointer-events:auto'), 'editor pins must re-enable pointer events');
});
