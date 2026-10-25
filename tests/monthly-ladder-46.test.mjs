// §46 — Monthly-billing late ladder (AUDIT.md §46 REVISED, Oct 24, 2026).
// Monthly-billing vendors (a "Monthly billing" flag on the vendor —
// applications.monthly_billing_active, mirrored onto vendor_profiles for
// imported vendors, the §47 flag-store pattern) get a set ladder on
// their monthly invoices, run by the hourly maintenance sweep:
//
//   the 1st (due date) — the due-date email, Scott's approved wording
//     verbatim, claimed once by a send-once stamp on the invoice;
//   the 3rd — a $25 late fee, applied once (late_fee_applied_at), and
//     never re-applied after Scott zeroes/waives it (late_fee_waived_at
//     records the waiver; the applied stamp alone also protects a
//     zeroed fee);
//   the 5th — that month's bookings auto-cancel (existing cancel
//     semantics + audit + waitlist scan), unless Scott marked a
//     promised pay date on the invoice, which defers cancellation to
//     that date.
//
// §46 REPLACES the legacy applyMonthlyLateFees ($10 at due_date + 3 for
// every invoice, no flag gate, no exemption): unflagged vendors get no
// rungs at all now. Pat's Potions (payment_reminder_exempt, §45) is
// exempt from every rung. Partial payments (§49) count: balance > 0 is
// "unpaid"; a ledger-settled invoice is exempt even if its stored
// status lags. The invoice print/email carries the one-line term.
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
const MI = read('netlify/functions/monthly-invoices.mjs');
const API = read('netlify/functions/api.mjs');
const PROFILES = read('server/profiles.mjs');
const VENDORS = read('public/v2/js/vendors.js');
const BILLING = read('public/v2/js/billing.js');
const CODIFY = read('database/codify-live-schema.sql');
const PAT_EMAIL = 'pelalem@msn.com';

const TERM = 'Monthly invoices are due on the 1st. A $25 late fee is added on the 3rd, and unpaid bookings are cancelled on the 5th. If you need more time, reply to your invoice email to arrange it.';
const dueBody = (name, month, total) =>
  `Hi ${name} — your Trinity Crafters Market invoice for ${month}, totaling ${total}, was due on the 1st, and it isn't marked paid yet. If payment is already on its way, thank you, and please disregard this note.\n\nMonthly billing runs on a set schedule: a $25 late fee is added on the 3rd, and on the 5th, unpaid bookings for the month are cancelled and the spaces released. If you need more time, please reply to this email with the date you can pay, and I'll note it on your account and hold your spaces until then.\n\nThank you,\nScott — Trinity Crafters Market`;

// ---------------------------------------------------------------- static pins
function assertLadderPins(src) {
  assert.ok(src.includes('sweepMonthlyBillingLadder'), 'the sweep must define the §46 ladder');
  assert.ok(src.includes('await sweepMonthlyBillingLadder();'), 'the ladder must be wired into the hourly run');
  assert.ok(!src.includes('async function applyMonthlyLateFees'), 'the legacy $10 fee function is replaced, not layered over');
  assert.ok(!src.includes('late_fee=1000'), 'the legacy $10 amount is gone');
  assert.ok(src.includes('late_fee=2500'), 'the §46 fee is $25');
  for (const col of ['due_email_sent_at', 'promised_pay_date', 'late_fee_waived_at', 'monthly_bookings_cancelled_at'])
    assert.ok(src.includes(`add column if not exists ${col}`), `vendor_invoices must gain ${col} (runtime add-column pattern)`);
  assert.ok(src.includes('monthly_billing_active'), 'the ladder gates on the monthly-billing vendor flag');
  assert.ok(src.includes('payment_reminder_exempt'), 'the ladder honors the §45 exemption (Pat)');
  // Scott's approved due-date email, verbatim (the struck line stays struck).
  assert.ok(src.includes('was due on the 1st, and it isn\'t marked paid yet. If payment is already on its way, thank you, and please disregard this note.'), 'due email paragraph 1 verbatim');
  assert.ok(src.includes('Monthly billing runs on a set schedule: a $25 late fee is added on the 3rd, and on the 5th, unpaid bookings for the month are cancelled and the spaces released. If you need more time, please reply to this email with the date you can pay, and I\'ll note it on your account and hold your spaces until then.'), 'due email paragraph 2 verbatim');
  assert.ok(src.includes('Scott — Trinity Crafters Market'), 'the due email signs as Scott');
  assert.ok(!src.includes('so nobody has to chase anybody'), 'the line Scott struck stays struck');
  // Fee once-only + waiver protection.
  assert.ok(src.includes('late_fee_applied_at is null'), 'the fee claim requires the applied stamp to be empty');
  assert.ok(src.includes('late_fee_waived_at is null'), 'the fee claim requires no recorded waiver');
  // Promised date defers cancellation.
  assert.ok(src.includes('promised_pay_date'), 'cancellation reads the promised pay date');
  assert.ok(src.includes('monthly billing bookings auto-cancelled'), 'booking cancellations audit');
  assert.ok(src.includes('monthly invoice late fee applied'), 'the fee audits under the legacy action name');
  assert.ok(src.includes('monthly due-date email sent'), 'the due email audits');
}

test('§46: the sweep carries the ladder — verbatim email, $25 once-only fee, promise deferral, exemption', () => {
  assertLadderPins(SWEEP);
});

test('§46 (negative control): the pins fail if the exemption check is removed', () => {
  const stripped = SWEEP.replaceAll('payment_reminder_exempt', 'payment_reminder_REMOVED');
  assert.notEqual(stripped, SWEEP, 'the mutation must actually change the source');
  assert.throws(() => assertLadderPins(stripped), 'pins must bite when the exemption checks are removed');
});

test('§46 (negative control): the pins fail if the approved email wording drifts', () => {
  const drifted = SWEEP.replace('was due on the 1st', 'was due on the first');
  assert.notEqual(drifted, SWEEP);
  assert.throws(() => assertLadderPins(drifted), 'pins must bite when Scott\'s wording changes');
});

test('§46: the one-line term rides the invoice print/email', () => {
  assert.ok(MI.includes(TERM), 'monthly-invoices carries the approved one-line term');
  assert.ok(MI.includes('INVOICE_TERM'), 'the term is a single constant shared by the print document and the email');
});

test('§46: update accepts late_fee (waiver stamps) and promised_pay_date', () => {
  assert.ok(MI.includes("hasOwnProperty.call(p,'late_fee')"), 'late_fee uses preserve semantics (absent key keeps the stored fee)');
  assert.ok(MI.includes("hasOwnProperty.call(p,'promised_pay_date')"), 'promised_pay_date uses preserve semantics');
  assert.ok(MI.includes('late_fee_waived_at=case when'), 'zeroing an applied fee records the waiver');
  assert.ok(MI.includes('monthly invoice terms updated'), 'term edits audit');
});

test('§46: the Monthly billing flag is wired through both flag stores and the settings sheet', () => {
  assert.ok(PROFILES.includes('add column if not exists monthly_billing_active boolean not null default false'), 'vendor_profiles gains the flag');
  assert.ok(PROFILES.includes('monthly_billing_active: row.monthly_billing_active === true'), 'presentProfile exposes the flag');
  assert.ok(PROFILES.includes('monthlyBillingActive'), 'saveVendorFlags carries the flag for imported vendors');
  assert.ok(API.includes('a.monthly_billing_active'), 'the Directory application rows carry the flag');
  assert.ok(API.includes('p.monthly_billing_active'), 'the Directory imported rows read the flag from the profile store');
  assert.ok(API.includes('monthly_billing_active=case when'), 'vendor-save writes the flag on applications only when the caller sends it');
  assert.ok(API.includes("'monthly_billing' in p"), 'vendor-save preserves the flag for callers that predate it (the parked classic UI)');
  assert.ok(VENDORS.includes('name="monthly_billing"'), 'the vendor settings sheet has the Monthly billing checkbox');
  assert.ok(VENDORS.includes("monthly_billing: f.get('monthly_billing') === 'on'"), 'the sheet submits the checkbox');
});

test('§46: the Monthly Billing card edits the late fee and the promised pay date', () => {
  assert.ok(BILLING.includes('data-f="latefee"'), 'the card has a late-fee field');
  assert.ok(BILLING.includes('data-f="promised"'), 'the card has a promised-pay-date field');
  assert.ok(BILLING.includes("late_fee: card.querySelector('[data-f=\"latefee\"]').value || 0"), 'Save Changes submits the late fee');
  assert.ok(BILLING.includes("promised_pay_date: card.querySelector('[data-f=\"promised\"]').value || ''"), 'Save Changes submits the promised date');
  assert.ok(BILLING.includes('late_fee_waived_at'), 'the card shows the waiver state');
});

test('§46: the new columns are codified in the live-schema file', () => {
  for (const stmt of [
    'alter table market.vendor_invoices add column if not exists due_email_sent_at timestamptz;',
    'alter table market.vendor_invoices add column if not exists promised_pay_date date;',
    'alter table market.vendor_invoices add column if not exists late_fee_waived_at timestamptz;',
    'alter table market.vendor_invoices add column if not exists monthly_bookings_cancelled_at timestamptz;',
    'alter table market.vendor_profiles add column if not exists monthly_billing_active boolean not null default false;',
  ]) assert.ok(CODIFY.includes(stmt), `codify-live-schema.sql must carry: ${stmt}`);
});

// ---------------------------------------------------------------- shared PGlite adapter (§35/§45)
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

// America/New_York calendar helpers — rung fixtures are offsets from ET
// today, so the ladder's marks are deterministic whenever the suite runs.
const etToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const addDays = (ymd, n) => { const d = new Date(ymd + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const monthOf = ymd => ymd.slice(0, 7);
const monthLabel = period => new Date(period + '-01T12:00:00').toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
const T = etToday();
const DUE_TODAY = T, DUE_FEE = addDays(T, -2), DUE_CANCEL = addDays(T, -4), DUE_FUTURE = addDays(T, 1);

// ---------------------------------------------------------------- sweep harness (§45 pattern)
let sweep, sweepSql;
const mailTo = (email, subjectPart) => globalThis.__queued.filter(q => q[1] === email && (!subjectPart || String(q[2]).includes(subjectPart)));

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

const LOC = '11111111-1111-4111-8111-111111111111';
let seq = 0;
const uid = p => p + String(++seq).padStart(7, '0') + '-1111-4111-8111-111111111111';

async function freshSweepDb() {
  const db = new PGlite();
  await db.exec(`create schema market;
    create table market.audit(id uuid primary key default gen_random_uuid(), actor text, action text, detail jsonb, created_at timestamptz not null default now());
    create table market.settings(key text primary key, value text);
    create table market.locations(id uuid primary key, name text not null, address text);
    create table market.events(id uuid primary key, location_id uuid not null, date date not null, start_time time, end_time time);
    create table market.applications(id uuid primary key, name text, business text, email text, regular_vendor boolean not null default false, monthly_billing_active boolean not null default false, payment_reminder_exempt boolean not null default false);
    create table market.bookings(id uuid primary key, application_id uuid, event_id uuid, status text, invoice_reference text, hold_until timestamptz, price integer, space text, checked_in boolean not null default false, payment_reference text, payment_method text, paid_at timestamptz, decision_reason text, waitlist_offered_at timestamptz);
    create table market.imported_attendees(id uuid primary key, event_id uuid, name text, business text, email text, space text, cancelled boolean not null default false, attendance_state text, created_at timestamptz not null default now());
    create table market.imported_category_reservations(id uuid primary key default gen_random_uuid(), imported_attendee_id uuid);
    create table market.vendor_profiles(id uuid primary key default gen_random_uuid(), email text, monthly_billing_active boolean not null default false, payment_reminder_exempt boolean not null default false);
    create table market.vendor_invoices(id uuid primary key, vendor_id uuid, vendor_email text, vendor_name text, business text, billing_period text, amount integer not null default 0, discount integer not null default 0, late_fee integer not null default 0, late_fee_applied_at timestamptz, items jsonb, due_date date, status text not null default 'draft', payment_method text, payment_reference text, payment_comment text, cancel_reason text, cancelled_at timestamptz, paid_at timestamptz, sent_at timestamptz, due_email_sent_at timestamptz, promised_pay_date date, late_fee_waived_at timestamptz, monthly_bookings_cancelled_at timestamptz, created_at timestamptz not null default now(), updated_at timestamptz not null default now());
    create table market.vendor_payments(id uuid primary key default gen_random_uuid(), monthly_invoice_id uuid, vendor_id uuid, application_id uuid, booking_id uuid, imported_attendee_id uuid, amount integer not null, payment_method text, paid_at timestamptz, note text, recorded_by text, receipt_sent_at timestamptz, created_at timestamptz not null default now());
    create table market.vendor_surveys(id uuid primary key default gen_random_uuid(), event_id uuid, booking_id uuid, imported_attendee_id uuid, vendor_name text, business text, email text, token uuid default gen_random_uuid(), emailed_at timestamptz);
    create table market.shopper_rsvps(id uuid primary key default gen_random_uuid(), event_id uuid not null, user_id uuid not null, name text not null, email text not null, party_size integer not null, referral_source text not null, referral_group text not null default '', created_at timestamptz not null default now(), unique(event_id,user_id));`);
  const sql = pgliteSql(db);
  const utcDay = new Date().toISOString().slice(0, 10);
  await sql`insert into market.audit(actor,action,detail,created_at) values('system','automatic system backup created',${sql.json({ seeded: true })},${utcDay + 'T12:00:00Z'})`;
  await sql`insert into market.locations(id,name,address) values(${LOC},'Hampton Inn Odessa Trinity','11780 State Rd 54, Odessa, FL 33556')`;
  return sql;
}

const eventOn = async (sql, ymd) => { const id = uid('e'); await sql`insert into market.events(id,location_id,date,start_time,end_time) values(${id},${LOC},${ymd},'10:00','15:00')`; return id; };
const appVendor = async (sql, name, email, { monthly = true, exempt = false } = {}) => { const id = uid('a'); await sql`insert into market.applications(id,name,business,email,monthly_billing_active,payment_reminder_exempt) values(${id},${name},${name + ' Co'},${email},${monthly},${exempt})`; return id; };
const invoice = async (sql, email, name, due, extra = {}) => {
  const id = uid('f');
  await sql`insert into market.vendor_invoices(id,vendor_email,vendor_name,business,billing_period,amount,discount,late_fee,late_fee_applied_at,items,due_date,status,sent_at)
    values(${id},${email},${name},${name + ' Co'},${monthOf(due)},${extra.amount ?? 13500},${extra.discount ?? 0},${extra.lateFee ?? 0},${extra.appliedAt ?? null},${sql.json([{ description: 'Monthly Bill', amount: extra.amount ?? 13500 }])},${due},${extra.status ?? 'emailed'},now())`;
  if (extra.promised) await sql`update market.vendor_invoices set promised_pay_date=${extra.promised} where id=${id}`;
  if (extra.waivedAt) await sql`update market.vendor_invoices set late_fee_waived_at=${extra.waivedAt} where id=${id}`;
  if (extra.dueEmailedAt) await sql`update market.vendor_invoices set due_email_sent_at=${extra.dueEmailedAt} where id=${id}`;
  return id;
};
const booking = async (sql, appId, eventId, status) => { const id = uid('b'); await sql`insert into market.bookings(id,application_id,event_id,status,price,space) values(${id},${appId},${eventId},${status},4500,'indoor')`; return id; };
const invRow = async id => (await sweepSql`select * from market.vendor_invoices where id=${id}`)[0];
const bkRow = async id => (await sweepSql`select * from market.bookings where id=${id}`)[0];

const F = {}; // fixture ids

test.before(async () => {
  delete process.env.PAYPAL_CLIENT_ID; delete process.env.PAYPAL_CLIENT_SECRET; delete process.env.GOOGLE_REFRESH_TOKEN;
  sweep = await buildSweep(await readFile(join(root, 'netlify/functions/maintenance.mjs'), 'utf8'));
  sweepSql = await freshSweepDb();
  globalThis.__sweepSql = sweepSql;
  globalThis.__queued = []; globalThis.__audits = []; globalThis.__scans = []; globalThis.__flushed = 0;

  const evPeriod = await eventOn(sweepSql, monthOf(DUE_CANCEL) + '-15');
  const evNext = await eventOn(sweepSql, addDays(monthOf(DUE_CANCEL) + '-01', 40).slice(0, 8) + '15');
  F.evPeriod = evPeriod; F.evNext = evNext;

  // Due today → email rung only.
  F.appEmail = await appVendor(sweepSql, 'Due Dana', 'dana@example.com');
  F.invEmail = await invoice(sweepSql, 'dana@example.com', 'Due Dana', DUE_TODAY);
  // Not yet due → nothing.
  F.invFuture = await invoice(sweepSql, 'dana@example.com', 'Due Dana', DUE_FUTURE);
  // Fee rung (3rd), due email already sent.
  F.appFee = await appVendor(sweepSql, 'Fee Fred', 'fred@example.com');
  F.invFee = await invoice(sweepSql, 'fred@example.com', 'Fee Fred', DUE_FEE, { dueEmailedAt: new Date().toISOString() });
  // Waived fee (applied then zeroed by Scott, waiver stamped) → never re-applied.
  F.invWaived = await invoice(sweepSql, 'fred@example.com', 'Fee Fred', DUE_FEE, { appliedAt: new Date().toISOString(), waivedAt: new Date().toISOString(), dueEmailedAt: new Date().toISOString() });
  // Zeroed fee with only the applied stamp → also never re-applied.
  F.invZeroed = await invoice(sweepSql, 'fred@example.com', 'Fee Fred', DUE_FEE, { appliedAt: new Date().toISOString(), dueEmailedAt: new Date().toISOString() });
  // Cancel rung (5th) with bookings in and out of the period.
  F.appCancel = await appVendor(sweepSql, 'Cancel Cara', 'cara@example.com');
  F.invCancel = await invoice(sweepSql, 'cara@example.com', 'Cancel Cara', DUE_CANCEL, { dueEmailedAt: new Date().toISOString() });
  F.bkApproved = await booking(sweepSql, F.appCancel, evPeriod, 'approved');
  F.bkHeld = await booking(sweepSql, F.appCancel, evPeriod, 'held');
  await sweepSql`insert into market.audit(actor,action,detail,created_at) values('organizer@test','booking held',${sweepSql.json({ id: F.bkHeld })},${new Date(Date.now() - 3600000).toISOString()})`;
  F.bkPaid = await booking(sweepSql, F.appCancel, evPeriod, 'paid');
  F.bkNext = await booking(sweepSql, F.appCancel, evNext, 'approved');
  // Promised date in the future defers the 5th cancellation (fee still lands).
  F.appPromise = await appVendor(sweepSql, 'Promise Pete', 'pete@example.com');
  F.invPromise = await invoice(sweepSql, 'pete@example.com', 'Promise Pete', DUE_CANCEL, { promised: addDays(T, 3), dueEmailedAt: new Date().toISOString() });
  F.bkPromise = await booking(sweepSql, F.appPromise, evPeriod, 'approved');
  // Promised date already passed → cancellation proceeds.
  F.appPromisePast = await appVendor(sweepSql, 'Promise Paul', 'paul@example.com');
  F.invPromisePast = await invoice(sweepSql, 'paul@example.com', 'Promise Paul', DUE_CANCEL, { promised: addDays(T, -1), dueEmailedAt: new Date().toISOString() });
  F.bkPromisePast = await booking(sweepSql, F.appPromisePast, evPeriod, 'approved');
  // Pat — exempt from every rung.
  F.appPat = await appVendor(sweepSql, 'Pat Elalem', PAT_EMAIL, { exempt: true });
  F.invPat = await invoice(sweepSql, PAT_EMAIL, 'Pat Elalem', DUE_CANCEL);
  F.bkPat = await booking(sweepSql, F.appPat, evPeriod, 'approved');
  // Paid invoice → untouched.
  F.invPaid = await invoice(sweepSql, 'dana@example.com', 'Due Dana', DUE_CANCEL, { status: 'paid' });
  // Partially paid (§49 ledger) with a balance → still "unpaid" for the ladder.
  F.appPartial = await appVendor(sweepSql, 'Partial Pam', 'partial@example.com');
  F.invPartial = await invoice(sweepSql, 'partial@example.com', 'Partial Pam', DUE_TODAY, { status: 'partial' });
  await sweepSql`insert into market.vendor_payments(monthly_invoice_id,amount,payment_method,paid_at) values(${F.invPartial},4500,'Cash',now())`;
  // Ledger-settled (status lags at 'partial') → exempt from rungs.
  F.invSettled = await invoice(sweepSql, 'partial@example.com', 'Partial Pam', DUE_CANCEL, { status: 'partial', dueEmailedAt: new Date().toISOString() });
  await sweepSql`insert into market.vendor_payments(monthly_invoice_id,amount,payment_method,paid_at) values(${F.invSettled},13500,'Cash',now())`;
  // Unflagged vendor → no rungs at all (the legacy fee would have fired).
  F.appPlain = await appVendor(sweepSql, 'Plain Paula', 'paula@example.com', { monthly: false });
  F.invPlain = await invoice(sweepSql, 'paula@example.com', 'Plain Paula', DUE_CANCEL);
  // Imported vendor — the flag lives on vendor_profiles (§47 store).
  await sweepSql`insert into market.vendor_profiles(email,monthly_billing_active) values('imported@example.com',true)`;
  F.invImported = await invoice(sweepSql, 'imported@example.com', 'Imported Ivy', DUE_TODAY);
  F.invImportedCancel = await invoice(sweepSql, 'imported@example.com', 'Imported Ivy', DUE_CANCEL, { dueEmailedAt: new Date().toISOString() });
  F.attImported = uid('d');
  await sweepSql`insert into market.imported_attendees(id,event_id,name,business,email,space) values(${F.attImported},${evPeriod},'Imported Ivy','Ivy Imports','imported@example.com','indoor')`;
  await sweepSql`insert into market.imported_category_reservations(imported_attendee_id) values(${F.attImported})`;

  await sweep();
});

test('§46 (behavioral): on the 1st the due-date email goes out once, Scott\'s wording verbatim', async () => {
  const mine = mailTo('dana@example.com', 'was due on the 1st');
  assert.equal(mine.length, 1, 'exactly one due-date email');
  const [, , subject, body] = mine[0];
  assert.ok(subject.includes(monthLabel(monthOf(DUE_TODAY))), 'the subject names the invoice month');
  assert.equal(body, dueBody('Due Dana', monthLabel(monthOf(DUE_TODAY)), '$135.00'), 'the body is the approved wording, verbatim');
  const row = await invRow(F.invEmail);
  assert.ok(row.due_email_sent_at, 'the send-once stamp is claimed');
  const audits = await sweepSql`select * from market.audit where action='monthly due-date email sent' and detail->>'invoice_id'=${F.invEmail}`;
  assert.equal(audits.length, 1, 'the send audits once');
  await sweep();
  assert.equal(mailTo('dana@example.com', 'was due on the 1st').length, 1, 'a second sweep sends nothing twice');
});

test('§46 (behavioral): an invoice not yet due gets nothing', async () => {
  const row = await invRow(F.invFuture);
  assert.equal(row.due_email_sent_at, null);
  assert.equal(Number(row.late_fee), 0);
});

test('§46 (behavioral): on the 3rd the $25 fee applies once', async () => {
  const row = await invRow(F.invFee);
  assert.equal(Number(row.late_fee), 2500, 'the fee is $25');
  assert.ok(row.late_fee_applied_at, 'the applied stamp is set');
  const audits = await sweepSql`select * from market.audit where action='monthly invoice late fee applied' and detail->>'invoice_id'=${F.invFee}`;
  assert.equal(audits.length, 1, 'the fee audits once');
  assert.equal(audits[0].detail.amount, 2500);
  await sweep();
  const again = await invRow(F.invFee);
  assert.equal(Number(again.late_fee), 2500, 're-runs never stack the fee');
});

test('§46 (behavioral): a fee Scott waived or zeroed is never re-applied', async () => {
  assert.equal(Number((await invRow(F.invWaived)).late_fee), 0, 'the waived fee stays $0');
  assert.equal(Number((await invRow(F.invZeroed)).late_fee), 0, 'a zeroed fee stays $0 (the applied stamp alone protects it)');
  const audits = await sweepSql`select * from market.audit where action='monthly invoice late fee applied' and detail->>'invoice_id' in (${F.invWaived},${F.invZeroed})`;
  assert.equal(audits.length, 0, 'no new fee audit for waived/zeroed invoices');
});

test('§46 (behavioral): on the 5th that month\'s bookings auto-cancel — and only that month\'s', async () => {
  assert.equal((await bkRow(F.bkApproved)).status, 'cancelled', 'the approved in-period booking cancels');
  assert.equal((await bkRow(F.bkHeld)).status, 'cancelled', 'the held in-period booking cancels');
  assert.equal((await bkRow(F.bkPaid)).status, 'paid', 'an already-paid booking is not the ladder\'s to cancel');
  assert.equal((await bkRow(F.bkNext)).status, 'approved', 'next month\'s booking is untouched');
  const row = await invRow(F.invCancel);
  assert.ok(row.monthly_bookings_cancelled_at, 'the cancel stamp is claimed');
  const audits = await sweepSql`select * from market.audit where action='monthly billing bookings auto-cancelled'`;
  assert.equal(audits.filter(a => a.detail.invoice_id === F.invCancel).length, 2, 'one audit per cancelled booking');
  assert.ok(globalThis.__scans.some(a => a[1] === F.evPeriod), 'the freed spots go through the waitlist scan');
  const mine = mailTo('cara@example.com', 'cancelled');
  assert.equal(mine.length, 1, 'the vendor gets one cancellation notice');
  await sweep();
  assert.equal((await sweepSql`select count(*)::int n from market.audit where action='monthly billing bookings auto-cancelled' and detail->>'invoice_id'=${F.invCancel}`)[0].n, 2, 're-runs never re-cancel');
});

test('§46 (behavioral): a promised pay date defers cancellation past the 5th — the fee still lands', async () => {
  assert.equal((await bkRow(F.bkPromise)).status, 'approved', 'the promised vendor keeps their spot');
  const row = await invRow(F.invPromise);
  assert.equal(row.monthly_bookings_cancelled_at, null, 'no cancel stamp while the promise runs');
  assert.equal(Number(row.late_fee), 2500, 'the 3rd fee is not deferred by a promise');
});

test('§46 (behavioral): once the promised date passes, cancellation proceeds', async () => {
  const row = await invRow(F.invPromisePast);
  assert.ok(row.monthly_bookings_cancelled_at, 'the lapsed promise no longer holds the cancellation off');
  assert.equal((await bkRow(F.bkPromisePast)).status, 'cancelled', 'the lapsed-promise booking cancels');
});

test('§46 (behavioral): Pat is untouched at every rung', async () => {
  assert.equal(mailTo(PAT_EMAIL).filter(q => !String(q[2]).startsWith('Reminder:')).length, 0, 'no ladder email to Pat (the generic day-before market reminder is a different system)');
  const row = await invRow(F.invPat);
  assert.equal(Number(row.late_fee), 0, 'no fee for Pat');
  assert.equal(row.due_email_sent_at, null);
  assert.equal(row.monthly_bookings_cancelled_at, null);
  assert.equal((await bkRow(F.bkPat)).status, 'approved', 'Pat\'s booking is never auto-cancelled');
});

test('§46 (behavioral): paid and ledger-settled invoices are exempt; a partial balance is not', async () => {
  const paid = await invRow(F.invPaid);
  assert.equal(paid.due_email_sent_at, null, 'a paid invoice gets no due email');
  assert.equal(Number(paid.late_fee), 0);
  const settled = await invRow(F.invSettled);
  assert.equal(settled.monthly_bookings_cancelled_at, null, 'a ledger-settled invoice never reaches the cancel rung');
  assert.equal(Number(settled.late_fee), 0, 'and never takes the fee');
  const partial = mailTo('partial@example.com', 'was due on the 1st');
  assert.equal(partial.length, 1, 'a partial balance still owes — the due email fires');
  assert.ok(partial[0][3].includes('totaling $135.00'), 'the email totals the invoice (payments are the vendor\'s to reconcile)');
});

test('§46 (behavioral): an unflagged vendor gets no rungs — the legacy fee is gone', async () => {
  const row = await invRow(F.invPlain);
  assert.equal(Number(row.late_fee), 0, 'no $10 legacy fee, no $25 ladder fee');
  assert.equal(row.due_email_sent_at, null);
  assert.equal(mailTo('paula@example.com').length, 0);
});

test('§46 (behavioral): an imported vendor\'s flag lives on vendor_profiles — ladder and spot-release included', async () => {
  assert.equal(mailTo('imported@example.com', 'was due on the 1st').length, 1, 'the due email fires off the profile flag');
  const [att] = await sweepSql`select cancelled from market.imported_attendees where id=${F.attImported}`;
  assert.equal(att.cancelled, true, 'the imported spot is released at the cancel rung');
  const left = await sweepSql`select count(*)::int n from market.imported_category_reservations where imported_attendee_id=${F.attImported}`;
  assert.equal(left[0].n, 0, 'the category reservation is released with it (vendor-credit cancel semantics)');
});

// ---------------------------------------------------------------- monthly-invoices handler (§49 harness)
let handler, hSql, hDb, seq2 = 0;
const nid = () => '00000000-0000-4000-8000-' + String(++seq2).padStart(12, '0');

test.before(async () => {
  let source = await readFile(join(root, 'netlify/functions/monthly-invoices.mjs'), 'utf8');
  source = source.replace(/^import .*;\n/gm, '');
  const mock = `
const db=()=>globalThis.__sql;
const identity=async()=>globalThis.__who;
const queue=async(tx,to,subject,body,htmlBody=null)=>{const id=globalThis.__uuid();await globalThis.__db.query('insert into market.outbox(id,recipient,subject,body,html_body) values($1,$2,$3,$4,$5)',[id,to,subject,body,htmlBody]);return {id};};
const flushMail=async()=>{await globalThis.__db.query('update market.outbox set sent_at=now() where sent_at is null and error is null');};
const audit=async(tx,u,action,detail)=>{globalThis.__audits.push([action,detail]);};
`;
  ({ default: handler } = await import('data:text/javascript;base64,' + Buffer.from(mock + source).toString('base64')));
  hDb = new PGlite();
  await hDb.exec(`create schema market;
    create table market.vendors(id uuid primary key, email text);
    create table market.vendor_invoices(
      id uuid primary key, vendor_id uuid, vendor_email text, vendor_name text, business text,
      billing_period text, amount integer not null default 0, discount integer not null default 0,
      late_fee integer not null default 0, late_fee_applied_at timestamptz, items jsonb, due_date date, status text not null default 'draft',
      payment_method text, payment_reference text, payment_comment text, cancel_reason text,
      cancelled_at timestamptz, paid_at timestamptz, sent_at timestamptz,
      created_at timestamptz not null default now(), updated_at timestamptz not null default now());
    create table market.vendor_payments(
      id uuid primary key default gen_random_uuid(), monthly_invoice_id uuid, vendor_id uuid,
      application_id uuid, booking_id uuid, imported_attendee_id uuid, amount integer not null,
      payment_method text, paid_at timestamptz, note text, recorded_by text,
      receipt_sent_at timestamptz, created_at timestamptz not null default now());
    create table market.outbox(
      id uuid primary key, recipient text, subject text, body text, html_body text,
      attachments jsonb, sent_at timestamptz, error text, created_at timestamptz not null default now());`);
  hSql = pgliteSql(hDb);
  globalThis.__sql = hSql;
  globalThis.__db = hDb;
  globalThis.__who = { admin: true, email: 'organizer@test' };
  globalThis.__uuid = nid;
  globalThis.__audits = [];
});

const post = (action, body) => handler(new Request('https://market.test/.netlify/functions/monthly-invoices?action=' + action, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }));
const get = qs => handler(new Request('https://market.test/.netlify/functions/monthly-invoices' + qs, { method: 'GET' }));
const hInv = async id => (await hSql`select * from market.vendor_invoices where id=${id}`)[0];
const ymdOf = v => { if (!v) return ''; if (v instanceof Date) return v.toISOString().slice(0, 10); const m = String(v).match(/\d{4}-\d{2}-\d{2}/); return m ? m[0] : ''; };
async function seedInvoice(extra = {}) {
  const id = nid();
  await hSql`insert into market.vendor_invoices(id,vendor_email,vendor_name,business,billing_period,amount,items,status,due_date)
    values(${id},'fred@example.com','Fee Fred','Fred Crafts','2026-11',13500,${hSql.json([{ description: 'November Bill', amount: 13500 }])},'emailed','2026-11-01')`;
  if (extra.appliedAt) await hSql`update market.vendor_invoices set late_fee=2500,late_fee_applied_at=${extra.appliedAt} where id=${id}`;
  return id;
}
const baseUpdate = id => ({ id, discount: 0, comment: '', status: 'emailed', payment_method: '' });

test('§46 (behavioral): update stores and clears the promised pay date; absent keys preserve both new fields', async () => {
  const id = await seedInvoice();
  let res = await post('update', { ...baseUpdate(id), promised_pay_date: '2026-11-12', late_fee: 0 });
  assert.equal(res.status, 200);
  let row = await hInv(id);
  assert.equal(ymdOf(row.promised_pay_date), '2026-11-12', 'the promised date is stored');
  res = await post('update', baseUpdate(id));
  row = await hInv(id);
  assert.equal(ymdOf(row.promised_pay_date), '2026-11-12', 'an update without the key preserves the promised date (the discount-save path)');
  res = await post('update', { ...baseUpdate(id), promised_pay_date: '' });
  row = await hInv(id);
  assert.equal(row.promised_pay_date, null, 'an empty value clears the promise');
  res = await post('update', { ...baseUpdate(id), promised_pay_date: 'next Friday' });
  assert.equal(res.status, 400, 'a non-date promise is refused');
});

test('§46 (behavioral): zeroing an applied fee stamps the waiver; a manual fee clears it', async () => {
  const id = await seedInvoice({ appliedAt: new Date().toISOString() });
  let res = await post('update', { ...baseUpdate(id), late_fee: 0 });
  assert.equal(res.status, 200);
  let row = await hInv(id);
  assert.equal(Number(row.late_fee), 0, 'the fee is zeroed');
  assert.ok(row.late_fee_waived_at, 'the waiver is recorded — the ladder must never re-add this fee');
  assert.ok(globalThis.__audits.some(([a]) => a === 'monthly invoice terms updated'), 'the waiver audits');
  res = await post('update', { ...baseUpdate(id), late_fee: 25 });
  row = await hInv(id);
  assert.equal(Number(row.late_fee), 2500, 'Scott can set a fee by hand ($25 → 2500 cents)');
  assert.equal(row.late_fee_waived_at, null, 'a fresh manual fee supersedes the waiver record');
});

test('§46 (behavioral): the printed invoice and the invoice email carry the one-line term', async () => {
  const id = await seedInvoice();
  const printRes = await get('?action=print&id=' + id + '&token=' + id);
  assert.equal(printRes.status, 200);
  const htmlDoc = await printRes.text();
  assert.ok(htmlDoc.includes(TERM), 'the print document carries the term');
  const res = await post('email', { id });
  assert.equal(res.status, 200);
  const [mail] = await hSql`select * from market.outbox where recipient='fred@example.com' order by created_at desc limit 1`;
  assert.ok(mail, 'the invoice email was queued');
  assert.ok(mail.body.includes(TERM), 'the plain-text email carries the term');
  assert.ok(mail.html_body.includes(TERM), 'the HTML email carries the term');
});
