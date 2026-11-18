// §69 — Online check-in asks how many tables the vendor is bringing
// (Nov 18, 2026). Scott: "The online check in needs a field with how
// many tables are they bringing 1 or 2." The check-in previously
// captured only the setup arrival time, so setup planning had no idea
// how much table space each vendor would occupy.
// Fix: a required 1-or-2 "tables" choice joins the arrival time in
// BOTH vendor check-in flows (v2 vendor portal → api action
// 'vendor-setup-checkin'; classic account page → setup-checkin
// function), stored as setup_tables (smallint) on market.bookings and
// market.imported_attendees alongside setup_arrival_time. The column
// self-migrates (admin-action alters in api.mjs + ensure alters at the
// top of setup-checkin.mjs + codify-live-schema.sql). Organizer
// surfaces show the count: the v2 Online Check-In page, the Attendees
// and Event Day check-in pills, and the organizer notification email
// the setup-checkin function sends. A date move clears setup_tables
// with the rest of the check-in (moves.mjs). Vendors who already
// checked in before §69 are not forced to redo it — the field gates
// new submissions only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = p => readFileSync(join(root, p), 'utf8');

const API = read('netlify/functions/api.mjs');
const FN = read('netlify/functions/setup-checkin.mjs');
const VENDOR = read('public/v2/js/vendor.js');
const DATA = read('public/v2/js/data.js');
const CHECKIN = read('public/v2/js/checkin.js');
const ATTENDEES = read('public/v2/js/attendees.js');
const EVENTDAY = read('public/v2/js/eventday.js');
const CLASSIC = read('public/setup-checkin.js');
const MOVES = read('server/moves.mjs');
const CODIFY = read('database/codify-live-schema.sql');

test('v2 vendor check-in form asks how many tables (1 or 2), required', () => {
  assert.match(VENDOR, /How many tables are you bringing\?/);
  assert.match(VENDOR, /<select name="tables" required>/);
  assert.match(VENDOR, /<option value="1">1 table<\/option><option value="2">2 tables<\/option>/);
});

test('v2 vendor check-in submits tables with the arrival time', () => {
  assert.match(VENDOR, /tables: new FormData\(form\)\.get\('tables'\)/);
  assert.match(VENDOR, /Bringing <strong>\$\{esc\(r\.setup_tables\)\}/);
});

test('api vendor-setup-checkin validates tables is 1 or 2 and stores it on both record kinds', () => {
  assert.match(API, /const tables=Number\(p\.tables\);if\(!\[1,2\]\.includes\(tables\)\)throw Error\('Choose how many tables you are bringing: 1 or 2\.'\);/);
  assert.match(API, /update market\.imported_attendees set setup_arrival_time=\$\{p\.arrival_time\},setup_tables=\$\{tables\},setup_checkin_at=now\(\)/);
  assert.match(API, /update market\.bookings set setup_arrival_time=\$\{p\.arrival_time\},setup_tables=\$\{tables\},setup_checkin_at=now\(\)/);
});

test('api payloads carry setup_tables (mine imported + admin bookings) and the column self-migrates', () => {
  assert.match(API, /i\.setup_arrival_time,i\.setup_tables,i\.setup_checkin_at/);
  assert.match(API, /b\.setup_arrival_time,b\.setup_tables,b\.setup_checkin_at/);
  assert.match(API, /alter table market\.bookings add column if not exists featured_posted_at[^;]*setup_tables smallint/);
  assert.match(API, /alter table market\.imported_attendees add column if not exists payment_reference[^;]*setup_tables smallint/);
  assert.match(CODIFY, /alter table market\.bookings add column if not exists setup_tables smallint;/);
  assert.match(CODIFY, /alter table market\.imported_attendees add column if not exists setup_tables smallint;/);
});

test('setup-checkin function ensures the column, validates and stores tables, and reports it', () => {
  assert.match(FN, /alter table market\.bookings add column if not exists setup_tables smallint/);
  assert.match(FN, /alter table market\.imported_attendees add column if not exists setup_tables smallint/);
  assert.match(FN, /const tables=Number\(p\.tables\);if\(!\[1,2\]\.includes\(tables\)\)/);
  assert.match(FN, /update market\.imported_attendees set setup_arrival_time=\$\{arrival\}::time,setup_tables=\$\{tables\}/);
  assert.match(FN, /update market\.bookings set setup_arrival_time=\$\{arrival\}::time,setup_tables=\$\{tables\}/);
  assert.match(FN, /Tables: \$\{tables\}\\nRecord: PDF imported vendor/);
  assert.match(FN, /Tables: \$\{tables\}\\nRecord: Website booking/);
  // admin + vendor lists both select the new column for bookings and imported
  assert.ok((FN.match(/b\.setup_tables/g) || []).length >= 2);
  assert.ok((FN.match(/i\.setup_tables/g) || []).length >= 2);
});

test('classic vendor check-in has the tables field and sends it', () => {
  assert.match(CLASSIC, /How many tables are you bringing\?<select data-setup-tables>/);
  assert.match(CLASSIC, /tables:tbl\.value/);
  assert.match(CLASSIC, /Choose how many tables you are bringing: 1 or 2\./);
});

test('organizer surfaces show the table count', () => {
  assert.match(DATA, /setup_tables: b\.setup_tables/);
  assert.match(DATA, /setup_tables: i\.setup_tables/);
  assert.match(CHECKIN, /Bringing <strong>\$\{esc\(r\.setup_tables\)\}/);
  // §81 (Scott, Nov 18, 2026): the count moved OUT of the check-in pill
  // into its own labelled chip — same data, plainly listed on the card.
  assert.match(ATTENDEES, /Tables: \$\{esc\(r\.setup_tables\)\}/);
  assert.match(EVENTDAY, /Tables: \$\{esc\(r\.setup_tables\)\}/);
});

test('a date move clears the table count with the rest of the check-in', () => {
  assert.match(MOVES, /setup_arrival_time = null, setup_tables = null, checked_in = false/);
  assert.match(MOVES, /setup_arrival_time = null, setup_tables = null, attendance_state = 'not_marked'/);
});
