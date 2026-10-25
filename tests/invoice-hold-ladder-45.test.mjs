// §45 — Unpaid manually-invoiced (GoDaddy) booking reminders + 48-hour
// close-out (AUDIT.md §45, Oct 24, 2026). The hourly maintenance sweep
// gains a ladder for bookings still in 'held' with a manually recorded
// invoice reference, on top of the existing 24-hour hold rule
// (handleHeldPayments — the inner rule, unchanged for everyone else):
//
//   rung 1 — 48 hours after the invoice was marked sent (the 'booking
//            held' audit / hold start, derived exactly like the legacy
//            path derives held_at): a reminder email.
//   rung 2 — 72 hours before the market: a final reminder.
//   close-out — 48 hours before the market: the held spot is released
//            and the booking moves to the wait-list (the organizer
//            waitlist transition's field semantics — a booking row
//            cannot be both 'cancelled' and waitlisted, and the
//            unique(application_id, event_id) constraint forbids a
//            second row), a final "released, you're on the wait-list"
//            email is sent, and the freed spot goes through the normal
//            waitlist scan.
// Every rung is claimed by a send-once stamp on the booking row inside
// the same transaction that queues the email (§35 pattern) — an hourly
// re-run or a racing sweep sends nothing twice.
//
// Exemption: applications.payment_reminder_exempt (data-driven toggle,
// also mirrored onto vendor_profiles when that table exists). The sweep
// seeds it ONCE (settings marker) for Pat's Potions — Pat Elalem,
// pelalem@msn.com, pays on the 1st by standing arrangement — and both
// the ladder AND the legacy 24-hour reminder/cancel skip exempt
// vendors, so her exemption covers reminders and close-out alike
// (Scott: "we don't need her getting one"). NOT Pam Briscoe (different
// person — Handmade with Love by Pam, pays cash, not exempt).
//
// Marks built (spec defaults, flagged "confirm at build" in §45 and
// shipped as proposed): rung 1 at invoice-sent +48h; rung 2 at
// market −72h; close-out at market −48h with the final email sent.
import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = p => readFileSync(join(root, p), 'utf8');
const SWEEP = read('netlify/functions/maintenance.mjs');
const PAT_EMAIL = 'pelalem@msn.com';

// ---------------------------------------------------------------- static pins
function assertLadderPins(src) {
  assert.ok(src.includes('sweepInvoiceHoldLadder'), 'the sweep must define the §45 ladder');
  assert.ok(src.includes('await sweepInvoiceHoldLadder();'), 'the ladder must be wired into the hourly run');
  assert.ok(src.indexOf('await sweepInvoiceHoldLadder();') < src.indexOf('await handleHeldPayments();'),
    'the ladder runs before the legacy 24h path so due rungs fire on bookings still held when the sweep starts');
  assert.ok(src.includes('ensureInvoiceHoldLadder'), 'the sweep must ensure the §45 columns (runtime add-column pattern)');
  for (const col of ['invoice_reminder1_sent_at', 'invoice_reminder2_sent_at', 'invoice_closeout_at'])
    assert.ok(src.includes(`add column if not exists ${col} timestamptz`), `bookings must gain the ${col} send-once stamp`);
  assert.ok(src.includes('add column if not exists payment_reminder_exempt boolean not null default false'),
    'applications must gain the exemption toggle');
  assert.ok(src.includes(PAT_EMAIL), 'the seed must target Pat by email match');
  assert.ok(src.includes("key='payment_reminder_exempt_seeded'"), 'the seed must be one-time (settings marker)');
  // Audience: held + manual invoice reference + not exempt + not a PayPal hold.
  assert.ok(src.includes("nullif(trim(b.invoice_reference),'') is not null"), 'the ladder audience requires an invoice reference');
  assert.ok(src.includes('not coalesce(a.payment_reminder_exempt,false)'), 'the ladder must exclude exempt vendors');
  assert.ok(src.includes("x.action='paypal invoice sent'"), 'PayPal holds are not the ladder audience (their reference is a PayPal id, not GoDaddy)');
  // Marks.
  assert.ok(src.includes("interval '72 hours'"), 'rung 2 / close-out marks are market-relative (72h / 48h)');
  assert.ok(src.includes("interval '48 hours'"), 'the close-out mark is 48 hours before the market');
  assert.ok(src.includes('48*3600000'), 'rung 1 is 48 hours after the invoice was marked sent');
  // The five content points of the reminder (spec §45.1).
  for (const phrase of ['GoDaddy invoice', "can't hold spots without payment", 'closed out 48 hours before the market',
    'moved to the wait-list', "reply to this email and tell us when you'll pay"])
    assert.ok(src.includes(phrase), `the reminder body must carry: ${phrase}`);
  // Close-out: waitlist transition semantics + final email + audit + scan.
  assert.ok(src.includes("status='waitlist'"), 'close-out moves the booking to the wait-list');
  assert.ok(src.includes('waitlisted_at=now()'), 'close-out stamps waitlisted_at like the organizer transition');
  assert.ok(src.includes('invoice hold closed out'), 'close-out is audited');
  assert.ok(src.includes("you're on the wait-list"), 'the final email must say the vendor is on the wait-list');
  assert.ok(src.includes("don't pay the outstanding invoice while you're on the wait-list"),
    'the final email must carry the do-not-pay line from the existing waitlist semantics');
  // The legacy 24h path honors the exemption too (after the PayPal paid-sync,
  // so a paid invoice still settles; before its reminder/cancel).
  const legacy = src.slice(src.indexOf('async function handleHeldPayments'));
  assert.ok(legacy.includes('a.payment_reminder_exempt'), 'the legacy held-payment select must carry the exemption flag');
  assert.ok(legacy.indexOf('if(b.payment_reminder_exempt)continue;') > legacy.indexOf('paypal payment auto-synced'),
    'the legacy skip must sit after the PayPal paid-sync');
  assert.ok(legacy.indexOf('if(b.payment_reminder_exempt)continue;') < legacy.indexOf("action='payment reminder sent'"),
    'the legacy skip must sit before its reminder/cancel');
}

test('§45: the sweep carries the invoice-hold ladder, its marks, content, exemption, and close-out', () => {
  assertLadderPins(SWEEP);
});

test('§45 (negative control): the pins fail if the exemption check is removed', () => {
  const stripped = SWEEP
    .replaceAll('not coalesce(a.payment_reminder_exempt,false)', 'true')
    .replaceAll('if(b.payment_reminder_exempt)continue;', '');
  assert.notEqual(stripped, SWEEP, 'the mutation must actually change the source');
  assert.throws(() => assertLadderPins(stripped), 'pins must bite when the exemption checks are removed');
});

test('§45: the new columns are codified in the live-schema file', () => {
  const codify = read('database/codify-live-schema.sql');
  for (const stmt of [
    'alter table market.bookings add column if not exists invoice_reminder1_sent_at timestamptz;',
    'alter table market.bookings add column if not exists invoice_reminder2_sent_at timestamptz;',
    'alter table market.bookings add column if not exists invoice_closeout_at timestamptz;',
    'alter table market.applications add column if not exists payment_reminder_exempt boolean not null default false;',
    'alter table market.vendor_profiles add column if not exists payment_reminder_exempt boolean not null default false;',
  ]) assert.ok(codify.includes(stmt), `codify-live-schema.sql must carry: ${stmt}`);
});

// ---------------------------------------------------------------- shared PGlite adapter (§35)
function pgliteSql(db) {
  const sql = async (strings, ...values) => {
    let text = '', params = [];
    strings.forEach((s, i) => { text += s; if (i < values.length) { params.push(values[i]); text += '$' + params.length; } });
    return (await db.query(text, params)).rows;
  };
  sql.json = v => JSON.stringify(v);
  sql.unsafe = async (text, params = []) => (await db.query(text, params)).rows;
  sql.begin = async fn => {
    await db.exec('begin');
    try { const r = await fn(sql); await db.exec('commit'); return r; }
    catch (e) { await db.exec('rollback'); throw e; }
  };
  return sql;
}

// Event date + start_time (America/New_York wall clock) for an instant,
// so mark margins are deterministic (71.5h / 47.5h out, not "about 3 days").
const etDateTime = ms => {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date(ms)).filter(p => p.type !== 'literal').map(p => [p.type, p.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${String(Number(parts.hour) % 24).padStart(2, '0')}:${parts.minute}` };
};
const H = 3600000, NOW = Date.now();
const iso = ms => new Date(ms).toISOString();

const LOC = '11111111-1111-4111-8111-111111111111';
const EV_FAR = 'e1111111-1111-4111-8111-111111111111';   // +20 days
const EV_MID = 'e2222222-2222-4222-8222-222222222222';   // +10 days
const EV_R2 = 'e3333333-3333-4333-8333-333333333333';    // +71.5h → rung 2 due, close-out not
const EV_CO = 'e4444444-4444-4444-8444-444444444444';    // +47.5h → close-out due
const APP = n => `a${n}111111-1111-4111-8111-111111111111`;
const BK = n => `b${n}111111-1111-4111-8111-111111111111`;

let sweep, sweepDb, sweepSql;
const mailTo = email => globalThis.__queued.filter(q => q[1] === email);

async function buildSweep(source) {
  source = source.replace(/^import .*;\n/gm, '');
  const mock = `
const ready=()=>true;
const db=()=>globalThis.__sweepSql;
const flushMail=async()=>{globalThis.__flushed++;};
const queue=async(...a)=>{globalThis.__queued.push(a);};
const audit=async(tx,actor,action,detail)=>{globalThis.__audits.push([actor,action,detail]);
  await globalThis.__sweepSql\`insert into market.audit(actor,action,detail) values(\${actor},\${action},\${globalThis.__sweepSql.json(detail||{})})\`;};
const supa=()=>({storage:{createBucket:async()=>({error:null}),from:()=>({upload:async()=>({error:{message:'stub'}})})}});
const syncCalendar=async()=>{};
const scanAllFutureWaitlists=async()=>{};
const scanWaitlist=async(...a)=>{globalThis.__scans.push(a);};
const sweepWaitlist=async()=>{};
`;
  return (await import('data:text/javascript;base64,' + Buffer.from(mock + source).toString('base64'))).default;
}

async function freshDb(withProfiles) {
  const db = new PGlite();
  await db.exec(`create schema market;
    create table market.audit(id uuid primary key default gen_random_uuid(), actor text, action text, detail jsonb, created_at timestamptz not null default now());
    create table market.settings(key text primary key, value text);
    create table market.locations(id uuid primary key, name text not null, address text);
    create table market.events(id uuid primary key, location_id uuid not null, date date not null, start_time time, end_time time);
    create table market.applications(id uuid primary key, name text, business text, email text, regular_vendor boolean not null default false);
    create table market.bookings(id uuid primary key, application_id uuid, event_id uuid, status text, invoice_reference text, hold_until timestamptz, price integer, space text, checked_in boolean not null default false, payment_reference text, payment_method text, paid_at timestamptz, decision_reason text, waitlist_offered_at timestamptz);
    create table market.imported_attendees(id uuid primary key, event_id uuid, name text, business text, email text, space text, cancelled boolean not null default false, attendance_state text);
    create table market.vendor_invoices(id uuid primary key, vendor_email text, status text, due_date date, late_fee integer not null default 0, late_fee_applied_at timestamptz, updated_at timestamptz);
    create table market.vendor_surveys(id uuid primary key default gen_random_uuid(), event_id uuid, booking_id uuid, imported_attendee_id uuid, vendor_name text, business text, email text, token uuid default gen_random_uuid(), emailed_at timestamptz);
    create table market.shopper_rsvps(id uuid primary key default gen_random_uuid(), event_id uuid not null, user_id uuid not null, name text not null, email text not null, party_size integer not null, referral_source text not null, referral_group text not null default '', created_at timestamptz not null default now(), unique(event_id,user_id));
    ${withProfiles ? 'create table market.vendor_profiles(id uuid primary key default gen_random_uuid(), email text);' : ''}`);
  const sql = pgliteSql(db);
  // The daily backup no-ops when today's backup row already exists.
  const utcDay = new Date().toISOString().slice(0, 10);
  await sql`insert into market.audit(actor,action,detail,created_at) values('system','automatic system backup created',${sql.json({ seeded: true })},${utcDay + 'T12:00:00Z'})`;
  await sql`insert into market.locations(id,name,address) values(${LOC},'Hampton Inn Odessa Trinity','11780 State Rd 54, Odessa, FL 33556')`;
  return { db, sql };
}

async function seedEvent(sql, id, instantMs) {
  const { date, time } = etDateTime(instantMs);
  await sql`insert into market.events(id,location_id,date,start_time,end_time) values(${id},${LOC},${date},${time},'15:00')`;
}
async function seedApp(sql, id, name, business, email, regular = false) {
  await sql`insert into market.applications(id,name,business,email,regular_vendor) values(${id},${name},${business},${email},${regular})`;
}
async function seedHeld(sql, id, appId, eventId, ref, heldMs, holdUntilMs, status = 'held') {
  await sql`insert into market.bookings(id,application_id,event_id,status,invoice_reference,hold_until,price,space)
    values(${id},${appId},${eventId},${status},${ref},${iso(holdUntilMs)},4500,'indoor')`;
  // The organizer transition audits 'booking held' — the invoice-sent
  // timestamp both the legacy path and the ladder derive held_at from.
  await sql`insert into market.audit(actor,action,detail,created_at)
    values('organizer@trinitycraftersmarket.com','booking held',${sql.json({ id })},${iso(heldMs)})`;
}

test.before(async () => {
  delete process.env.PAYPAL_CLIENT_ID; delete process.env.PAYPAL_CLIENT_SECRET; delete process.env.GOOGLE_REFRESH_TOKEN;
  const source = await readFile(join(root, 'netlify/functions/maintenance.mjs'), 'utf8');
  sweep = await buildSweep(source);
  ({ db: sweepDb, sql: sweepSql } = await freshDb(false)); // no vendor_profiles here — the guard must tolerate it
  globalThis.__sweepSql = sweepSql;

  await seedEvent(sweepSql, EV_FAR, NOW + 20 * 24 * H);
  await seedEvent(sweepSql, EV_MID, NOW + 10 * 24 * H);
  await seedEvent(sweepSql, EV_R2, NOW + 71.5 * H);
  await seedEvent(sweepSql, EV_CO, NOW + 47.5 * H);

  await seedApp(sweepSql, APP(1), 'Vendor One', 'One Crafts', 'vendor1@example.com');
  await seedApp(sweepSql, APP(2), 'Vendor Two', 'Two Crafts', 'vendor2@example.com');
  await seedApp(sweepSql, APP(3), 'Vendor Three', 'Three Crafts', 'vendor3@example.com');
  await seedApp(sweepSql, APP(4), 'Vendor Four', 'Four Crafts', 'vendor4@example.com');
  await seedApp(sweepSql, APP(5), 'Vendor Five', 'Five Crafts', 'vendor5@example.com', true); // a regular vendor
  await seedApp(sweepSql, APP(6), 'Pat Elalem', "Pat's Potions", PAT_EMAIL);

  await seedHeld(sweepSql, BK(1), APP(1), EV_FAR, 'GD-1001', NOW - 49 * H, NOW - 25 * H); // rung 1 due
  await seedHeld(sweepSql, BK(2), APP(2), EV_R2, 'GD-1002', NOW - 2 * H, NOW + 22 * H);  // rung 2 due
  await seedHeld(sweepSql, BK(3), APP(3), EV_CO, 'GD-1003', NOW - 3 * H, NOW + 21 * H);  // close-out due
  await seedHeld(sweepSql, BK(4), APP(4), EV_CO, 'GD-1004', NOW - 49 * H, NOW - 25 * H, 'paid'); // paid — untouched
  await seedHeld(sweepSql, BK(5), APP(5), EV_MID, 'GD-1005', NOW - 25 * H, NOW - 1 * H); // regular, legacy 24h rule
  await seedHeld(sweepSql, BK(6), APP(6), EV_FAR, 'GD-1006', NOW - 49 * H, NOW - 25 * H); // Pat, identical to BK(1)
  await seedHeld(sweepSql, BK(7), APP(6), EV_CO, 'GD-1007', NOW - 3 * H, NOW + 21 * H);  // Pat, identical to BK(3)
});

test('§45 (behavioral): the sweep seeds Pat\'s exemption once, by email match', async () => {
  globalThis.__queued = []; globalThis.__audits = []; globalThis.__scans = []; globalThis.__flushed = 0;
  await sweep();
  const [pat] = await sweepSql`select payment_reminder_exempt from market.applications where id=${APP(6)}`;
  assert.equal(pat.payment_reminder_exempt, true, 'Pat is seeded exempt by email match');
  const [marker] = await sweepSql`select key from market.settings where key='payment_reminder_exempt_seeded'`;
  assert.ok(marker, 'the seed marker is written');
  const others = await sweepSql`select count(*)::int n from market.applications where payment_reminder_exempt and id<>${APP(6)}`;
  assert.equal(others[0].n, 0, 'nobody else is seeded exempt');
});

test('§45 (behavioral): rung 1 fires 48h after the invoice was sent, with all five content points, once', async () => {
  const mine = mailTo('vendor1@example.com').filter(q => String(q[2]).startsWith('Payment reminder'));
  assert.equal(mine.length, 1, 'exactly one rung-1 reminder');
  const [, , subject, body] = mine[0];
  assert.ok(subject.includes('Payment reminder'), 'subject announces the reminder');
  assert.ok(body.includes('GoDaddy invoice'), 'point 1: check for the GoDaddy invoice');
  assert.ok(body.includes('GD-1001'), 'point 1: the invoice reference is named so they can find it');
  assert.ok(body.includes("can't hold spots without payment"), 'point 2: no hold without payment');
  assert.ok(body.includes('closed out 48 hours before the market'), 'point 3: the 48h close-out is stated');
  assert.ok(body.includes('moved to the wait-list'), 'point 4: release means the wait-list');
  assert.ok(body.includes("reply to this email and tell us when you'll pay"), 'point 5: reply and tell us when you\'ll pay');
  assert.ok(body.includes('Amount due: $45.00'), 'the amount due is stated');
  const [b] = await sweepSql`select invoice_reminder1_sent_at from market.bookings where id=${BK(1)}`;
  assert.ok(b.invoice_reminder1_sent_at, 'the rung-1 stamp is claimed');
  const audits = await sweepSql`select * from market.audit where action='invoice payment reminder sent' and detail->>'id'=${BK(1)}`;
  assert.equal(audits.length, 1, 'the send is audited once');
  assert.equal(audits[0].detail.rung, 1, 'the audit records rung 1');
  // Catch-up reality, asserted honestly: this booking was already past
  // the legacy 24-hour deadline when the sweep ran, so the legacy path
  // cancels it in the same run — the ladder ran first and got its
  // reminder in. In steady state the 24h rule lands a day earlier and
  // the ladder simply never sees the booking.
  const [after] = await sweepSql`select status from market.bookings where id=${BK(1)}`;
  assert.equal(after.status, 'cancelled', 'the legacy 24h cancel still lands in a catch-up run');
});

test('§45 (behavioral): rung 2 fires 72 hours before the market, once', async () => {
  const mine = mailTo('vendor2@example.com');
  assert.equal(mine.length, 1, 'exactly one email to the rung-2 vendor');
  const [, , subject, body] = mine[0];
  assert.ok(subject.includes('Final payment reminder'), 'subject marks it as the final reminder');
  assert.ok(body.includes('GoDaddy invoice') && body.includes('GD-1002'), 'the GoDaddy content points carry over');
  assert.ok(body.includes("reply to this email and tell us when you'll pay"), 'the reply ask carries over');
  const [b] = await sweepSql`select status, invoice_reminder2_sent_at from market.bookings where id=${BK(2)}`;
  assert.equal(b.status, 'held', 'rung 2 does not disturb the booking');
  assert.ok(b.invoice_reminder2_sent_at, 'the rung-2 stamp is claimed');
});

test('§45 (behavioral): close-out at T-48h releases the spot, waitlists the vendor, sends the final email once', async () => {
  const [b] = await sweepSql`select status, hold_until, waitlisted_at, decision_reason, invoice_closeout_at from market.bookings where id=${BK(3)}`;
  assert.equal(b.status, 'waitlist', 'the booking lands on the wait-list (the spot is released — waitlist holds nothing)');
  assert.equal(b.hold_until, null, 'the hold is cleared');
  assert.ok(b.waitlisted_at, 'waitlisted_at is stamped like the organizer transition');
  assert.ok(String(b.decision_reason).includes('48-hour close-out'), 'the vendor-facing reason records the close-out');
  assert.ok(b.invoice_closeout_at, 'the close-out stamp is claimed');
  const mine = mailTo('vendor3@example.com');
  assert.equal(mine.length, 1, 'exactly one final email');
  const [, , subject, body] = mine[0];
  assert.ok(subject.includes("you're on the wait-list"), 'subject says the vendor is on the wait-list');
  assert.ok(body.includes('has been released') || body.includes('space has been released'), 'body says the spot was released');
  assert.ok(body.includes("don't pay the outstanding invoice while you're on the wait-list"), 'body carries the do-not-pay line');
  const audits = await sweepSql`select * from market.audit where action='invoice hold closed out' and detail->>'id'=${BK(3)}`;
  assert.equal(audits.length, 1, 'the close-out is audited once');
  assert.ok(globalThis.__scans.some(a => a[1] === EV_CO), 'the freed spot goes through the waitlist scan');
});

test('§45 (behavioral): a paid booking is untouched', async () => {
  assert.equal(mailTo('vendor4@example.com').length, 0, 'no email to the paid vendor');
  const [b] = await sweepSql`select status, invoice_reminder1_sent_at, invoice_reminder2_sent_at, invoice_closeout_at from market.bookings where id=${BK(4)}`;
  assert.equal(b.status, 'paid');
  assert.deepEqual([b.invoice_reminder1_sent_at, b.invoice_reminder2_sent_at, b.invoice_closeout_at], [null, null, null], 'no ladder stamps');
});

test('§45 (behavioral): a regular vendor\'s 24-hour expiry is unchanged — the legacy path, no ladder additions', async () => {
  const [b] = await sweepSql`select status, invoice_reminder1_sent_at, invoice_reminder2_sent_at, invoice_closeout_at from market.bookings where id=${BK(5)}`;
  assert.equal(b.status, 'cancelled', 'the legacy 24h rule cancels the regular\'s unpaid hold');
  assert.deepEqual([b.invoice_reminder1_sent_at, b.invoice_reminder2_sent_at, b.invoice_closeout_at], [null, null, null], 'the ladder adds nothing');
  const mine = mailTo('vendor5@example.com');
  assert.equal(mine.length, 1, 'exactly the one legacy email');
  assert.ok(String(mine[0][2]).startsWith('Reservation cancelled'), 'it is the legacy cancellation email, not a ladder email');
  const audits = await sweepSql`select * from market.audit where action='payment hold auto-cancelled' and detail->>'id'=${BK(5)}`;
  assert.equal(audits.length, 1, 'the legacy audit is intact');
});

test('§45 (behavioral): Pat gets nothing at any rung — no reminder, no close-out, no legacy cancel', async () => {
  assert.equal(mailTo(PAT_EMAIL).length, 0, 'no email of any kind to Pat');
  for (const id of [BK(6), BK(7)]) {
    const [b] = await sweepSql`select status, invoice_reminder1_sent_at, invoice_reminder2_sent_at, invoice_closeout_at from market.bookings where id=${id}`;
    assert.equal(b.status, 'held', `Pat's booking ${id} is still held — exempt from every rung incl. close-out`);
    assert.deepEqual([b.invoice_reminder1_sent_at, b.invoice_reminder2_sent_at, b.invoice_closeout_at], [null, null, null], 'no ladder stamps for Pat');
  }
});

test('§45 (behavioral): a second sweep sends nothing twice', async () => {
  const before = globalThis.__queued.length;
  await sweep();
  assert.equal(globalThis.__queued.length, before, 'the re-run queues no email at all — stamps + status guards hold');
});

test('§45 (behavioral): the exemption seed is one-time — a later manual change is data, not re-seeded', async () => {
  await sweepSql`update market.applications set payment_reminder_exempt=false where id=${APP(6)}`;
  await sweep();
  const [pat] = await sweepSql`select payment_reminder_exempt from market.applications where id=${APP(6)}`;
  assert.equal(pat.payment_reminder_exempt, false, 'with the marker written, the sweep never re-seeds over a manual change');
});

test('§45 (behavioral): when vendor_profiles exists, the seed mirrors the exemption onto it', async () => {
  const { sql } = await freshDb(true);
  globalThis.__sweepSql = sql;
  globalThis.__queued = []; globalThis.__audits = []; globalThis.__scans = [];
  await sql`insert into market.vendor_profiles(email) values(${PAT_EMAIL})`;
  await seedApp(sql, APP(6), 'Pat Elalem', "Pat's Potions", PAT_EMAIL);
  await sweep();
  const [p] = await sql`select payment_reminder_exempt from market.vendor_profiles where email=${PAT_EMAIL}`;
  assert.equal(p.payment_reminder_exempt, true, 'the profile row is seeded exempt too');
  globalThis.__sweepSql = sweepSql; // restore the main harness
});

test('§45 (behavioral, negative control): with Pat\'s seed email removed, her identical booking IS closed out', async () => {
  const source = await readFile(join(root, 'netlify/functions/maintenance.mjs'), 'utf8');
  const mutated = source.split(PAT_EMAIL).join('nobody@example.com');
  assert.notEqual(mutated, source, 'the mutation must actually change the source');
  const badSweep = await buildSweep(mutated);
  const { sql } = await freshDb(false);
  globalThis.__sweepSql = sql;
  globalThis.__queued = []; globalThis.__audits = []; globalThis.__scans = [];
  await seedEvent(sql, EV_CO, NOW + 47.5 * H);
  await seedApp(sql, APP(6), 'Pat Elalem', "Pat's Potions", PAT_EMAIL);
  await seedHeld(sql, BK(7), APP(6), EV_CO, 'GD-1007', NOW - 3 * H, NOW + 21 * H);
  await badSweep();
  const [b] = await sql`select status from market.bookings where id=${BK(7)}`;
  assert.equal(b.status, 'waitlist', 'without the exemption, the close-out fires on Pat — the check is what protects her');
  assert.ok(mailTo(PAT_EMAIL).some(q => String(q[2]).includes("you're on the wait-list")), 'and the final email goes out');
  globalThis.__sweepSql = sweepSql; // restore the main harness
});
