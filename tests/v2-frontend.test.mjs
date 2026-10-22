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
