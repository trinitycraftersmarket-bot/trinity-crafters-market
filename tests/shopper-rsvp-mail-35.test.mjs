// §35 — Shopper RSVP emails (Oct 24, 2026). Scott: "when a shopper
// rsvps I want an email sent to me plus a reminder email sent to them
// the day before." Build: (1) the api 'rsvp' action queues ONE organizer
// email per submit alongside the upsert (worded "RSVP received (new or
// updated)" — a resubmit updates the row, and the organizer hears about
// it either way); (2) the hourly maintenance sweep sends each shopper a
// "See you tomorrow" reminder the day before their market, guarded by
// the new shopper_rsvps.reminder_sent_at stamp (codified in
// database/codify-live-schema.sql section 13; the sweep also ALTERs it
// in at runtime, the monthly-invoices pattern). No client changes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = p => readFileSync(join(root, p), 'utf8');
const API = read('netlify/functions/api.mjs');
const SWEEP = read('netlify/functions/maintenance.mjs');
const ORGANIZER = 'trinitycraftersmarket@gmail.com';

// ---------------------------------------------------------------- static pins
test('§35: the rsvp action queues the organizer email with honest new-or-updated wording', () => {
  const action = API.slice(API.indexOf("action==='rsvp'"), API.indexOf("action==='messages'"));
  assert.ok(action.includes(`queue(tx,'${ORGANIZER}'`), 'rsvp must queue the organizer email inside the transaction');
  assert.ok(action.includes('New shopper RSVP — '), 'subject must announce the RSVP');
  assert.ok(action.includes('RSVP received (new or updated)'), 'the upsert means a resubmit re-notifies — the body must say so');
  assert.ok(action.includes('marketDateLabel(e.date)'), 'the email must name the market date');
  assert.ok(action.includes('await flushMail();'), 'the action must flush after queueing, like its siblings');
});

test('§35: the sweep carries the shopper reminder, wired into the hourly run', () => {
  assert.ok(SWEEP.includes('sendDayBeforeShopperReminders'), 'the sweep must define the shopper reminder');
  assert.ok(SWEEP.includes('await sendDayBeforeShopperReminders();'), 'the default export must call it');
  assert.ok(SWEEP.includes("'See you tomorrow at Trinity Crafters Market!'"), 'the reminder subject is exact');
  assert.ok(SWEEP.includes('reminder_sent_at is null'), 'selection must be stamp-guarded');
  assert.ok(SWEEP.includes("add column if not exists reminder_sent_at timestamptz"), 'the sweep must ALTER the column in (runtime pattern)');
  assert.ok(SWEEP.includes('reply to this email if your plans change'), 'the body must invite a reply on plan changes');
});

test('§35: reminder_sent_at is codified in the live-schema file', () => {
  const codify = read('database/codify-live-schema.sql');
  assert.ok(codify.includes('alter table market.shopper_rsvps add column if not exists reminder_sent_at timestamptz;'),
    'codify-live-schema.sql must carry the reminder stamp');
});

// ---------------------------------------------------------------- shared PGlite adapter (§34)
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

// ================================================================ Part A: the api rsvp action
const LOC_ID = '11111111-1111-4111-8111-111111111111';
const EVENT_ID = '22222222-2222-4222-8222-222222222222';
const USER_ID = '33333333-3333-4333-8333-333333333333';
let apiHandler, apiDb, apiSql;

test.before(async () => {
  let source = await readFile(join(root, 'netlify/functions/api.mjs'), 'utf8');
  source = source.replace(/^import .*;\n/gm, '');
  const noop = async () => {};
  const mock = `
const ready=()=>true;
const db=()=>globalThis.__apiSql;
const supa=()=>({});
const identity=async()=>globalThis.__who;
const banned=async()=>false;
const expire=${noop.toString()};
const audit=async(...a)=>{globalThis.__audits.push(a);};
const queue=async(...a)=>{globalThis.__queued.push(a);};
const publicData=async()=>({});
const flushMail=async()=>{globalThis.__flushed++;};
const isUserError=()=>false;
const staffActionAllowed=()=>true;
const hasStaffPermission=()=>false;
const normalizePhone=s=>String(s||'').replace(/\\D/g,'');
const eventInventory=async()=>({categories:new Map(),indoor:0,outdoor:0});
const categoryUsed=async()=>0;
const assertCapacity=${noop.toString()};
const vendorIdentityKey=()=>'';
const syncInspection=${noop.toString()};
const acceptOffer=${noop.toString()};
const declineOffer=${noop.toString()};
const ensureWaitlistSchema=${noop.toString()};
const offerAnyway=${noop.toString()};
const resolveOffers=${noop.toString()};
const scanWaitlist=${noop.toString()};
const decisionEmail=async()=>'';
const banEmail=async()=>'';
const syncCalendar=${noop.toString()};
const claimImported=async()=>({matched:false});
const ensureProfileSchema=${noop.toString()};
const upsertProfileFromApplication=${noop.toString()};
const vendorPaymentHistory=async()=>[];
const recordManualPayment=${noop.toString()};
const ensureVendorPaymentColumns=${noop.toString()};
const pickAreaAttachment=async()=>null;
const allAreaAttachments=async()=>[];
const blockedRecipients=async()=>[];
`;
  ({ default: apiHandler } = await import('data:text/javascript;base64,' + Buffer.from(mock + source).toString('base64')));

  apiDb = new PGlite();
  await apiDb.exec(`create schema market;
    create table market.locations(id uuid primary key, name text not null, address text, market_name text not null default '');
    create table market.events(id uuid primary key, location_id uuid not null references market.locations(id), date date not null, start_time time not null default '10:00', end_time time, open boolean not null default true);
    create table market.shopper_rsvps(id uuid primary key default gen_random_uuid(), event_id uuid not null references market.events(id), user_id uuid not null, name text not null, email text not null, party_size integer not null, referral_source text not null, referral_group text not null default '', created_at timestamptz not null default now(), unique(event_id,user_id));`);
  apiSql = pgliteSql(apiDb);
  globalThis.__apiSql = apiSql;
  globalThis.__who = { id: USER_ID, email: 'shopper@example.com', admin: false, manager: false, permissions: [] };
  await apiSql`insert into market.locations(id,name,address) values(${LOC_ID},'Hampton Inn Odessa Trinity','11780 State Rd 54, Odessa, FL 33556')`;
  await apiSql`insert into market.events(id,location_id,date,start_time,end_time) values(${EVENT_ID},${LOC_ID},'2027-01-09','10:00','15:00')`;
});

const rsvpPost = body => apiHandler(new Request('https://market.test/.netlify/functions/api?action=rsvp', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
}));

test('§35 (behavioral): an RSVP submit stores the row and queues exactly one organizer email', async () => {
  globalThis.__queued = []; globalThis.__audits = []; globalThis.__flushed = 0;
  const res = await rsvpPost({ event_id: EVENT_ID, name: 'Jamie Shopper', party_size: 3, referral_source: 'Facebook', referral_group: 'Odessa Moms' });
  assert.equal(res.status, 200, 'rsvp must succeed');
  assert.deepEqual(await res.json(), { ok: true });

  const [row] = await apiSql`select * from market.shopper_rsvps where event_id=${EVENT_ID} and user_id=${USER_ID}`;
  assert.ok(row, 'the RSVP row must be stored');
  assert.equal(row.party_size, 3);
  assert.equal(row.email, 'shopper@example.com', 'the server stores the account email');

  assert.equal(globalThis.__queued.length, 1, 'exactly one organizer email queued');
  const [, to, subject, body] = globalThis.__queued[0];
  assert.equal(to, ORGANIZER);
  assert.ok(subject.startsWith('New shopper RSVP — '), 'subject announces the RSVP');
  assert.ok(subject.includes('January 9, 2027'), 'subject carries the market date');
  assert.ok(subject.includes('Hampton Inn Odessa Trinity'), 'subject carries the location');
  assert.ok(body.includes('RSVP received (new or updated)'), 'body carries the honest wording');
  assert.ok(body.includes('Jamie Shopper'), 'body names the shopper');
  assert.ok(body.includes('shopper@example.com'), 'body carries the account email');
  assert.ok(body.includes('Party size: 3'), 'body carries the party size');
  assert.ok(body.includes('Facebook (Odessa Moms)'), 'body carries the source and the group');
  assert.ok(globalThis.__flushed >= 1, 'mail must be flushed');
});

test('§35 (behavioral): a resubmit upserts the row and notifies once more', async () => {
  globalThis.__queued = [];
  const res = await rsvpPost({ event_id: EVENT_ID, name: 'Jamie Shopper', party_size: 5, referral_source: 'Instagram' });
  assert.equal(res.status, 200);
  const rows = await apiSql`select * from market.shopper_rsvps where event_id=${EVENT_ID} and user_id=${USER_ID}`;
  assert.equal(rows.length, 1, 'still one row — the resubmit updated it');
  assert.equal(rows[0].party_size, 5, 'party size updated');
  assert.equal(globalThis.__queued.length, 1, 'the resubmit queues exactly one more organizer email');
  const [, , , body] = globalThis.__queued[0];
  assert.ok(body.includes('Party size: 5'), 'the second email carries the updated size');
  assert.ok(body.includes('How they heard: Instagram'), 'a non-Facebook source carries no group suffix');
});

// ================================================================ Part B: the maintenance sweep
const S_LOC = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const nyToday = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
const addDays = (ymd, n) => { const d = new Date(ymd + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const TOMORROW = addDays(nyToday, 1), TODAY = nyToday, YESTERDAY = addDays(nyToday, -1);
let sweep, sweepDb, sweepSql;

test.before(async () => {
  delete process.env.PAYPAL_CLIENT_ID; delete process.env.PAYPAL_CLIENT_SECRET; delete process.env.GOOGLE_REFRESH_TOKEN;
  let source = await readFile(join(root, 'netlify/functions/maintenance.mjs'), 'utf8');
  source = source.replace(/^import .*;\n/gm, '');
  const mock = `
const ready=()=>true;
const db=()=>globalThis.__sweepSql;
const flushMail=async()=>{globalThis.__flushed++;};
const queue=async(...a)=>{globalThis.__queued.push(a);};
const audit=async(...a)=>{globalThis.__audits.push(a);};
const supa=()=>({storage:{createBucket:async()=>({error:null}),from:()=>({upload:async()=>({error:{message:'stub'}})})}});
const syncCalendar=async()=>{};
const scanAllFutureWaitlists=async()=>{};
const scanWaitlist=async()=>{};
const sweepWaitlist=async()=>{};
`;
  ({ default: sweep } = await import('data:text/javascript;base64,' + Buffer.from(mock + source).toString('base64')));

  sweepDb = new PGlite();
  await sweepDb.exec(`create schema market;
    create table market.audit(id uuid primary key default gen_random_uuid(), actor text, action text, detail jsonb, created_at timestamptz not null default now());
    create table market.settings(key text primary key, value text);
    create table market.locations(id uuid primary key, name text not null, address text);
    create table market.events(id uuid primary key, location_id uuid not null, date date not null, start_time time, end_time time);
    create table market.applications(id uuid primary key, name text, business text, email text);
    create table market.bookings(id uuid primary key, application_id uuid, event_id uuid, status text, invoice_reference text, hold_until timestamptz, price integer, space text, checked_in boolean not null default false);
    create table market.imported_attendees(id uuid primary key, event_id uuid, name text, business text, email text, space text, cancelled boolean not null default false, attendance_state text);
    create table market.vendor_invoices(id uuid primary key, vendor_email text, status text, due_date date, late_fee integer not null default 0, late_fee_applied_at timestamptz, updated_at timestamptz);
    create table market.vendor_surveys(id uuid primary key default gen_random_uuid(), event_id uuid, booking_id uuid, imported_attendee_id uuid, vendor_name text, business text, email text, token uuid default gen_random_uuid(), emailed_at timestamptz);
    create table market.shopper_rsvps(id uuid primary key default gen_random_uuid(), event_id uuid not null, user_id uuid not null, name text not null, email text not null, party_size integer not null, referral_source text not null, referral_group text not null default '', created_at timestamptz not null default now(), unique(event_id,user_id));`);
  sweepSql = pgliteSql(sweepDb);
  globalThis.__sweepSql = sweepSql;
  // The daily backup no-ops when today's backup row already exists.
  const utcDay = new Date().toISOString().slice(0, 10);
  await sweepSql`insert into market.audit(actor,action,detail,created_at) values('system','automatic system backup created',${sweepSql.json({ seeded: true })},${utcDay + 'T12:00:00Z'})`;
  await sweepSql`insert into market.locations(id,name,address) values(${S_LOC},'Hampton Inn Odessa Trinity','11780 State Rd 54, Odessa, FL 33556')`;
  const ev = async (id, date) => { await sweepSql`insert into market.events(id,location_id,date,start_time,end_time) values(${id},${S_LOC},${date},'10:00','15:00')`; };
  await ev('e1111111-1111-4111-8111-111111111111', TOMORROW);
  await ev('e2222222-2222-4222-8222-222222222222', TODAY);
  await ev('e3333333-3333-4333-8333-333333333333', YESTERDAY);
  const rsvp = async (id, eventId, email, name, size) => {
    await sweepSql`insert into market.shopper_rsvps(id,event_id,user_id,name,email,party_size,referral_source) values(${id},${eventId},${USER_ID},${name},${email},${size},'Google')`;
  };
  await rsvp('b1111111-1111-4111-8111-111111111111', 'e1111111-1111-4111-8111-111111111111', 'jamie@example.com', 'Jamie Shopper', 4);
  await rsvp('b2222222-2222-4222-8222-222222222222', 'e2222222-2222-4222-8222-222222222222', 'today@example.com', 'Today Shopper', 2);
  await rsvp('b3333333-3333-4333-8333-333333333333', 'e3333333-3333-4333-8333-333333333333', 'past@example.com', 'Past Shopper', 6);
});

test('§35 (behavioral): the sweep reminds only tomorrow\'s shoppers, once, and stamps the row', async () => {
  globalThis.__queued = []; globalThis.__audits = []; globalThis.__flushed = 0;
  await sweep();

  assert.equal(globalThis.__queued.length, 1, 'exactly one reminder queued across the whole sweep');
  const [, to, subject, body] = globalThis.__queued[0];
  assert.equal(to, 'jamie@example.com', 'the reminder goes to tomorrow\'s shopper');
  assert.equal(subject, 'See you tomorrow at Trinity Crafters Market!');
  assert.ok(body.includes('Jamie Shopper'), 'body greets the shopper');
  assert.ok(body.includes('Hampton Inn Odessa Trinity'), 'body names the location');
  assert.ok(body.includes('11780 State Rd 54'), 'body carries the address');
  assert.ok(body.includes('10:00 AM–3:00 PM'), 'body carries the market hours');
  assert.ok(body.includes('Party size: 4'), 'body carries the party size');
  assert.ok(body.includes('reply to this email if your plans change'), 'body invites a reply on plan changes');

  const rows = await sweepSql`select email, reminder_sent_at from market.shopper_rsvps order by email`;
  const byEmail = Object.fromEntries(rows.map(r => [r.email, r.reminder_sent_at]));
  assert.ok(byEmail['jamie@example.com'], 'tomorrow\'s row is stamped');
  assert.equal(byEmail['today@example.com'], null, 'a same-day market gets no day-before reminder');
  assert.equal(byEmail['past@example.com'], null, 'a past market gets no reminder');
  assert.ok(globalThis.__audits.some(a => a[2] === 'day-before shopper reminder sent'), 'the send is audited');
  assert.ok(globalThis.__flushed >= 1, 'the sweep flushes queued mail');

  // Second run in the same hour: the stamp guard sends nothing again.
  await sweep();
  assert.equal(globalThis.__queued.length, 1, 'a re-run queues nothing — the stamp is the guard');
});
