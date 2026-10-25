// §42 — Silent ban + vendor "Find out why" (Oct 24, 2026).
// Scott: "If I ban a vendor, does it email them? If so, take it out and
// a button to find out why." It DID: the api 'ban' action set send=true
// on create AND on re-activation and queued notifications.mjs banEmail()
// ("you have been banned…") — the vendor learned about the ban from an
// email Scott never wanted sent.
//
// Fixes pinned here:
//  (1) The ban action queues NO email on either path. banEmail is
//      retired from server/notifications.mjs and from the api import.
//      Enforcement, ban records and audits are untouched.
//  (2) A signed-in banned vendor learns their state from a new
//      ban-status bootstrap probe (identity() itself still refuses
//      them everywhere — the probe resolves identity through
//      identityWithBan, which REPORTS the ban instead of throwing).
//      The v2 shell keeps their session and renders a neutral
//      restriction notice (vendor Home + Apply) with a Find out why
//      button; the organizer's ban reason is a PRIVATE note and is
//      never in the probe response, the notice, or the inquiry email.
//  (3) ban-inquiry queues ONE email to the organizer
//      (trinitycraftersmarket@gmail.com): "Vendor <name> (<email>)
//      asked why they were banned." Throttle: one per vendor per 7
//      days, stamped inquiry_sent_at on the ban rows (lazy
//      add-column-if-not-exists in identityWithBan + codified in
//      database/codify-live-schema.sql §13). A repeat inside the
//      window queues nothing and reports throttled honestly. The
//      inquiry is audited.
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
const CORE = read('server/core.mjs');
const NOTIFICATIONS = read('server/notifications.mjs');
const CODIFY = read('database/codify-live-schema.sql');
const VENDOR_JS = read('public/v2/js/vendor.js');
const APP_JS = read('public/v2/js/app.js');
const API_JS = read('public/v2/js/api.js');
const BANNED_JS = read('public/v2/js/banned.js');
const section = (src, from, to) => src.slice(src.indexOf(from), src.indexOf(to));

// ---------------------------------------------------------------- static pins
const banActionOf = src => section(src, "if(action==='ban'){", "if(action==='location')");
const banActionPins = src => {
  const a = banActionOf(src);
  assert.ok(!a.includes('queue('), 'the ban action must not queue any email');
  assert.ok(!a.includes('banEmail'), 'the ban action must not reference the retired ban email');
  assert.ok(!a.includes('notification unavailable'), 'the no-email-on-file audit path goes away with the send');
  assert.ok(!a.includes('send='), 'the send flag itself is retired');
};
test('§42: the ban action never emails — no queue, no template, no send flag (create + re-activate share the block)', () => {
  banActionPins(API);
  const a = banActionOf(API);
  assert.ok(a.includes('insert into market.bans'), 'ban creation stays');
  assert.ok(a.includes('update market.bans set active'), 'the active toggle (unban / re-apply) stays');
  assert.ok(a.includes("audit(tx,u,'ban',p)"), 'the create audit stays');
  assert.ok(a.includes("audit(tx,u,'ban status'"), 'the toggle audit stays');
  assert.ok(!API.slice(0, API.indexOf('const json=')).includes('banEmail'), 'api.mjs must not import banEmail');
});

test('§42: banEmail is retired from notifications.mjs', () => {
  assert.ok(!NOTIFICATIONS.includes('banEmail'), 'the ban notification template is gone');
  assert.ok(!NOTIFICATIONS.includes('you have been banned'), 'the ban notice copy is gone with it');
  assert.ok(NOTIFICATIONS.includes('decisionEmail'), 'the other templates are untouched');
});

test('§42 (negative control): the no-email pins fail if a send branch is reintroduced', () => {
  const mutated = API.replace("await audit(tx,u,'ban',p);", "await audit(tx,u,'ban',p);await queue(tx,'x@example.com','s','b');");
  assert.notEqual(mutated, API, 'the mutation must actually change the source');
  assert.throws(() => banActionPins(mutated), /must not queue any email/);
  const mutatedTpl = NOTIFICATIONS + '\nexport function banEmail(name){return {subject:\'x\',body:\'you have been banned\'};}';
  assert.ok(mutatedTpl.includes('banEmail'), 'sanity: the mutation re-adds the template');
});

test('§42: identity() still refuses banned vendors; identityWithBan reports the ban instead', () => {
  assert.ok(CORE.includes("throw Error('Your vendor access is restricted. Contact the market organizer.')"),
    'enforcement wording/behavior in identity() is unchanged');
  const tolerant = section(CORE, 'export async function identityWithBan', 'export async function banned');
  assert.ok(tolerant.includes('banned'), 'identityWithBan exposes the banned flag');
  assert.ok(!tolerant.includes('access is restricted. Contact'), 'identityWithBan must not throw the refusal');
  assert.ok(tolerant.includes('add column if not exists inquiry_sent_at'), 'identityWithBan lazily ensures the throttle column');
  assert.ok(CODIFY.includes('alter table market.bans add column if not exists inquiry_sent_at timestamptz'),
    'the column is codified in codify-live-schema.sql');
});

test('§42: ban-status + ban-inquiry live ahead of the identity wall and carry the §42 contract', () => {
  const wall = API.indexOf('const u=await identity(req)');
  assert.ok(wall > 0, 'the identity wall exists');
  assert.ok(API.indexOf("action==='ban-status'") > -1 && API.indexOf("action==='ban-status'") < wall, 'ban-status is pre-wall');
  assert.ok(API.indexOf("action==='ban-inquiry'") > -1 && API.indexOf("action==='ban-inquiry'") < wall, 'ban-inquiry is pre-wall');
  const inq = section(API, "if(action==='ban-inquiry'", "const u=await identity(req)");
  assert.ok(inq.includes('identityWithBan'), 'the inquiry verifies the caller through the ban-tolerant identity');
  assert.ok(inq.includes("'trinitycraftersmarket@gmail.com'"), 'the inquiry goes to the organizer inbox');
  assert.ok(inq.includes('asked why they were banned'), 'the email carries the §42 wording');
  assert.ok(inq.includes('inquiry_sent_at'), 'the inquiry stamps the throttle');
  assert.ok(inq.includes('throttled'), 'a throttled repeat reports itself honestly');
  assert.ok(inq.includes("audit(tx,who,'ban inquiry'"), 'the inquiry is audited');
  assert.ok(!inq.includes('.reason'), 'the inquiry never reads the private ban reason into the email');
});

test('§42: the v2 shell keeps a banned vendor signed in and renders the neutral notice + Find out why', () => {
  assert.ok(APP_JS.includes("api('ban-status')"), 'boot probes ban-status when me() refuses');
  assert.ok(APP_JS.includes('banned: true'), 'boot keeps the session with the banned flag on state.user');
  assert.ok(APP_JS.includes('state.user?.banned'), 'the vendor data refresh short-circuits for a banned vendor');
  assert.ok(API_JS.includes("includes('vendor access is restricted')"), 'a refused me() after OTP verify reads as restricted, not as a failed sign-in');
  assert.ok(VENDOR_JS.includes('Your vendor access is restricted.'), 'the notice uses the neutral wording');
  assert.ok(VENDOR_JS.includes('Find out why'), 'the notice carries the Find out why button');
  assert.ok(VENDOR_JS.includes("api('ban-inquiry'"), 'the button calls the ban-inquiry action');
  const notice = section(VENDOR_JS, 'function banNoticeCard', 'function wireBanNotice');
  assert.ok(!notice.includes('.reason'), 'the notice never renders any reason field');
  assert.ok(!notice.includes('banned from participating'), 'the retired email copy never leaks into the notice');
});

test('§42: the organizer banned screen no longer claims an email is sent', () => {
  assert.ok(!BANNED_JS.includes('will be emailed'), 'the add-ban sheet must not promise a notification email');
  assert.ok(!BANNED_JS.includes('re-sends the notification'), 'the header comment must not claim re-activation emails');
  assert.ok(BANNED_JS.includes('does not email the vendor'), 'the sheet states the silent-ban truth');
});

// ---------------------------------------------------------------- behavioral harness
// Real server/core.mjs (identity / identityWithBan / queue / audit /
// flushMail byte-identical) + the real api.mjs handler over one PGlite.
// Supabase auth is a token→user map; Resend is a fetch mock.
process.env.ADMIN_EMAIL = 'organizer@example.com';
process.env.RESEND_API_KEY = 'stub-resend-key';
process.env.MAIL_FROM = 'Trinity Crafters Market <market@example.com>';

const SECRET_REASON = 'PRIVATE REASON — no-showed twice, argued with staff';
const TOKENS = {
  'tok-admin': { id: '00000000-0000-4000-8000-0000000000ad', email: 'organizer@example.com', email_confirmed_at: '2026-01-01T00:00:00Z' },
  'tok-banned': { id: '00000000-0000-4000-8000-0000000000b1', email: 'banned@example.com', email_confirmed_at: '2026-01-01T00:00:00Z' },
  'tok-vendor': { id: '00000000-0000-4000-8000-0000000000c1', email: 'vendor@example.com', email_confirmed_at: '2026-01-01T00:00:00Z' }
};
globalThis.__users = TOKENS;

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

const sends = [];
globalThis.fetch = async url => {
  if (String(url).includes('api.resend.com')) { sends.push(url); return { ok: true, status: 200, json: async () => ({ id: 'stub' }) }; }
  return { ok: true, status: 200, json: async () => ({}) };
};

let db, sql, handler;
test.before(async () => {
  db = new PGlite();
  await db.exec('create role anon; create role authenticated; create schema storage; create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);');
  await db.exec(await readFile(join(root, 'database/setup.sql'), 'utf8'));
  await db.exec(await readFile(join(root, 'database/codify-live-schema.sql'), 'utf8'));
  await db.exec(await readFile(join(root, 'database/vendor-credits.sql'), 'utf8'));
  await db.exec(await readFile(join(root, 'database/waitlist-offers.sql'), 'utf8'));
  await db.exec(await readFile(join(root, 'database/vendor-profiles.sql'), 'utf8'));
  sql = pgliteSql(db);
  globalThis.__sql = sql;

  let coreSrc = await readFile(join(root, 'server/core.mjs'), 'utf8');
  coreSrc = coreSrc.replace(/^import .*$/gm, '');
  const corePrelude = `
const postgres = () => globalThis.__sql;
const createClient = () => ({ auth: { getUser: async token => { const u = globalThis.__users[token]; return u ? { data: { user: u }, error: null } : { data: { user: null }, error: { message: 'invalid token' } }; } } });
const normalizePhone = value => { const n = String(value || '').replace(/\\D/g, ''); return n.length === 11 && n[0] === '1' ? n.slice(1) : n; };
const publicCounts = async () => ({ spaces: new Map() });
const categoryCountRows = async () => [];
`;
  const core = await import('data:text/javascript;base64,' + Buffer.from(corePrelude + coreSrc).toString('base64'));
  globalThis.__core = core;

  let apiSrc = await readFile(join(root, 'netlify/functions/api.mjs'), 'utf8');
  apiSrc = apiSrc.replace(/^import .*$/gm, '');
  const noop = async () => {};
  const prelude = `
const {queue, audit, flushMail, isUserError, identity, identityWithBan, banned} = globalThis.__core;
const ready = () => true;
const db = () => globalThis.__sql;
const supa = () => globalThis.__core.supa();
const expire = ${noop.toString()};
const publicData = async () => ({});
const staffActionAllowed = () => true;
const hasStaffPermission = () => false;
const normalizePhone = value => { const n = String(value || '').replace(/\\D/g, ''); return n.length === 11 && n[0] === '1' ? n.slice(1) : n; };
const eventInventory = async () => ({ categories: new Map(), indoor: 0, outdoor: 0 });
const categoryUsed = async () => 0;
const assertCapacity = ${noop.toString()};
const vendorIdentityKey = () => '';
const syncInspection = ${noop.toString()};
const acceptOffer = ${noop.toString()};
const declineOffer = ${noop.toString()};
const ensureWaitlistSchema = ${noop.toString()};
const offerAnyway = ${noop.toString()};
const resolveOffers = ${noop.toString()};
const scanWaitlist = ${noop.toString()};
const decisionEmail = () => ({ subject: '', body: '' });
const syncCalendar = ${noop.toString()};
const claimImported = async () => ({ matched: false });
const ensureProfileSchema = ${noop.toString()};
const ensureImportedProfiles = ${noop.toString()};
const saveVendorFlags = ${noop.toString()};
const upsertProfileFromApplication = ${noop.toString()};
const vendorPaymentHistory = async () => [];
const recordManualPayment = ${noop.toString()};
const ensureVendorPaymentColumns = ${noop.toString()};
const pickAreaAttachment = async () => null;
const allAreaAttachments = async () => [];
const blockedRecipients = async () => [];
`;
  ({ default: handler } = await import('data:text/javascript;base64,' + Buffer.from(prelude + apiSrc).toString('base64')));
});
test.after(async () => { await db.close(); });

const call = (action, token, body) => handler(new Request('https://market.test/.netlify/functions/api?action=' + action, {
  method: body === undefined ? 'GET' : 'POST',
  headers: { ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
  body: body === undefined ? undefined : JSON.stringify(body)
}));
const outbox = () => sql`select * from market.outbox order by created_at`;
let banId;

test('§42 (behavioral): creating a ban queues NO email — and enforcement still refuses the vendor', async () => {
  const res = await call('ban', 'tok-admin', { name: 'Banned Vendor', email: 'banned@example.com', phone: '5551234567', reason: SECRET_REASON });
  assert.equal(res.status, 200);
  const [ban] = await sql`select * from market.bans where email='banned@example.com'`;
  assert.ok(ban && ban.active, 'the ban record exists and is active');
  banId = ban.id;
  assert.equal((await outbox()).length, 0, 'creating a ban must queue no email at all');
  const audits = await sql`select action from market.audit where action in ('ban','ban notification unavailable')`;
  assert.deepEqual(audits.map(a => a.action), ['ban'], 'the ban audit stays; the notification audit is gone');
  // Enforcement: the same identity wall as always refuses the vendor.
  const mine = await call('mine', 'tok-banned');
  assert.equal(mine.status, 400, 'a banned vendor is still refused by data actions');
  assert.ok((await mine.json()).error.includes('vendor access is restricted'), 'the refusal is the standing enforcement message');
});

test('§42 (behavioral): ban-status exposes banned only to the banned vendor, with no reason leak', async () => {
  const asBanned = await (await call('ban-status', 'tok-banned')).json();
  assert.equal(asBanned.banned, true);
  assert.equal(asBanned.email, 'banned@example.com');
  assert.equal(asBanned.can_inquire, true, 'no inquiry yet — the button is available');
  assert.ok(!JSON.stringify(asBanned).includes(SECRET_REASON), 'the probe response must never carry the private reason');
  assert.ok(!('reason' in asBanned), 'the probe has no reason field at all');
  const asVendor = await (await call('ban-status', 'tok-vendor')).json();
  assert.deepEqual(asVendor, { banned: false }, 'a non-banned vendor sees banned:false and nothing else');
  const asAdmin = await (await call('ban-status', 'tok-admin')).json();
  assert.deepEqual(asAdmin, { banned: false }, 'the organizer is never banned');
  const anon = await call('ban-status', null);
  assert.equal(anon.status, 400, 'an anonymous probe is refused');
});

test('§42 (behavioral): Find out why queues exactly one organizer email — no reason in it — and stamps the throttle', async () => {
  const res = await call('ban-inquiry', 'tok-banned', {});
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.sent, true);
  const rows = await outbox();
  assert.equal(rows.length, 1, 'exactly one email is queued');
  const mail = rows[0];
  assert.equal(mail.recipient, 'trinitycraftersmarket@gmail.com', 'the inquiry goes to the organizer');
  assert.ok(mail.subject.includes('Banned Vendor'), 'the subject names the vendor');
  assert.ok(mail.body.includes('Banned Vendor'), 'the body names the vendor');
  assert.ok(mail.body.includes('banned@example.com'), 'the body carries the vendor email');
  assert.ok(mail.body.includes('asked why they were banned'), 'the body carries the §42 wording');
  assert.ok(!mail.subject.includes(SECRET_REASON) && !mail.body.includes(SECRET_REASON), 'the private reason is NOT in the inquiry email');
  assert.ok(mail.sent_at, 'the queued inquiry is actually flushed/sent');
  const [ban] = await sql`select inquiry_sent_at from market.bans where id=${banId}`;
  assert.ok(ban.inquiry_sent_at, 'the throttle stamp lands on the ban row');
  const audits = await sql`select * from market.audit where action='ban inquiry'`;
  assert.equal(audits.length, 1, 'the inquiry is audited once');
  const status = await (await call('ban-status', 'tok-banned')).json();
  assert.equal(status.can_inquire, false, 'the probe now reports the button spent');
  assert.ok(status.inquiry_sent_at, 'the probe reports when the inquiry was sent');
});

test('§42 (behavioral): a second inquiry inside 7 days queues nothing and reports the throttle', async () => {
  const res = await call('ban-inquiry', 'tok-banned', {});
  assert.equal(res.status, 200, 'a throttled repeat is an honest state, not an error');
  const body = await res.json();
  assert.equal(body.sent, false);
  assert.equal(body.throttled, true);
  assert.equal((await outbox()).length, 1, 'no second email is queued inside the window');
});

test('§42 (behavioral): a non-banned vendor cannot file an inquiry', async () => {
  const res = await call('ban-inquiry', 'tok-vendor', {});
  assert.equal(res.status, 400, 'the inquiry is refused for a non-banned account');
  assert.equal((await outbox()).length, 1, 'the refusal queues nothing');
  const anon = await call('ban-inquiry', null, {});
  assert.equal(anon.status, 400, 'an anonymous inquiry is refused');
  assert.equal((await outbox()).length, 1, 'the anonymous refusal queues nothing');
});

test('§42 (behavioral): after 7 days the vendor may ask again', async () => {
  await sql`update market.bans set inquiry_sent_at=now()-interval '8 days' where id=${banId}`;
  const res = await call('ban-inquiry', 'tok-banned', {});
  assert.equal(res.status, 200);
  assert.equal((await res.json()).sent, true);
  assert.equal((await outbox()).length, 2, 'a fresh inquiry queues a second email after the window');
});

test('§42 (behavioral): unban + re-apply queues NO email on either toggle', async () => {
  const before = (await outbox()).length;
  let res = await call('ban', 'tok-admin', { id: banId, active: false });
  assert.equal(res.status, 200);
  res = await call('ban', 'tok-admin', { id: banId, active: true });
  assert.equal(res.status, 200);
  assert.equal((await outbox()).length, before, 'neither lifting nor re-applying a ban emails anyone');
  const [ban] = await sql`select active from market.bans where id=${banId}`;
  assert.equal(ban.active, true, 'the re-applied ban is active again');
  const mine = await call('mine', 'tok-banned');
  assert.equal(mine.status, 400, 'enforcement bites again after re-activation');
});
