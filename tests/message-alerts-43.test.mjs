// §43 — New-message email alerts for the organizer (Oct 24, 2026).
// Scott chose email over push: when a VENDOR sends a message in the
// per-application Messages thread, queue ONE alert to
// trinitycraftersmarket@gmail.com naming the vendor, carrying a
// truncated preview, thread/market context, and the Messages link.
// Throttle: at most one alert per application thread per hour. The
// clock resets when the organizer opens that thread in v2 (the GET
// carries read_application_id and only an admin GET resets it) and
// when the organizer side replies in the thread. Organizer/staff
// sends never alert.
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
const CODIFY = read('database/codify-live-schema.sql');
const SETUP = read('database/setup.sql');
const THREADS_JS = read('public/v2/js/threads.js');
const ORGANIZER = 'trinitycraftersmarket@gmail.com';
const LINK = 'https://trinitylutzmarkets.com/v2/#messages';
const section = (src, from, to) => src.slice(src.indexOf(from), src.indexOf(to));

// ---------------------------------------------------------------- static pins
const messageAlertPins = src => {
  const action = section(src, "if(action==='messages')", "if(action==='staff-login'");
  assert.ok(action.includes("add column if not exists message_alert_sent_at timestamptz"), 'the messages action must lazily ensure the throttle column');
  assert.ok(action.includes("const staffAuthored=u.admin||hasStaffPermission(u,'vendor_messages')"), 'organizer-side authorship must be classified from the authenticated user');
  assert.ok(action.includes("const vendorAuthored=!staffAuthored&&String(a.user_id)===String(u.id)"), 'only the application-owning vendor may alert');
  assert.ok(action.includes('60*60*1000'), 'the throttle window must be one hour');
  assert.ok(action.includes(`queue(tx,'${ORGANIZER}'`), 'the alert must queue to the organizer inbox inside the transaction');
  assert.ok(action.includes('`New message from ${vendorLabel}`'), 'the subject must name the vendor');
  assert.ok(action.includes('Thread: '), 'the body must carry thread context');
  assert.ok(action.includes('Market: '), 'the body must carry market context');
  assert.ok(action.includes(LINK), 'the body must link to Messages');
  assert.ok(action.includes("url.searchParams.get('read_application_id')"), 'an organizer thread-open must be able to reset the clock');
  assert.ok(action.includes('message_alert_sent_at=null'), 'read/reply paths must reset the throttle stamp');
  assert.ok(action.includes('await flushMail();'), 'queued alerts must be flushed through the hardened mail path');
  return action;
};

test('§43: the messages action carries the organizer alert contract', () => {
  const action = messageAlertPins(API);
  assert.ok(action.includes('messageAlertPreview(body)'), 'the alert body must use the truncating preview, never the raw full message');
  assert.ok(API.includes('const MESSAGE_ALERT_PREVIEW_CHARS=500'), 'the preview length must be a named, sane limit');
  assert.ok(action.includes('for update'), 'the thread row must be locked so rapid sends cannot race two alerts');
  assert.ok(THREADS_JS.includes("api('messages', undefined, { read_application_id: selected })"),
    'the v2 thread view must tell the api which thread the organizer opened');
});

test('§43: the throttle column is codified and present in fresh setup', () => {
  assert.ok(CODIFY.includes('alter table market.applications add column if not exists message_alert_sent_at timestamptz;'),
    'codify-live-schema.sql must carry the throttle stamp');
  assert.ok(SETUP.includes('alter table market.applications add column if not exists message_alert_sent_at timestamptz;'),
    'setup.sql must carry the throttle stamp for a fresh database');
});

test('§43 (negative control): the alert pins fail if the recipient or vendor-only guard is broken', () => {
  const wrongRecipient = API.replace(`queue(tx,'${ORGANIZER}',\`New message from \${vendorLabel}\``, "queue(tx,'vendor@example.com',`New message from ${vendorLabel}`");
  assert.notEqual(wrongRecipient, API, 'the recipient mutation must change the source');
  assert.throws(() => messageAlertPins(wrongRecipient), /alert must queue to the organizer inbox/);
  const anyAuthor = API.replace("const vendorAuthored=!staffAuthored&&String(a.user_id)===String(u.id)", 'const vendorAuthored=true');
  assert.notEqual(anyAuthor, API, 'the guard mutation must change the source');
  assert.throws(() => messageAlertPins(anyAuthor), /only the application-owning vendor may alert/);
});

// ---------------------------------------------------------------- behavioral harness
// Real server/core.mjs (identity / queue / audit / flushMail
// byte-identical) + the real api.mjs handler over one PGlite.
// Supabase auth is a token→user map; Resend is a fetch mock.
process.env.ADMIN_EMAIL = 'organizer@example.com';
process.env.RESEND_API_KEY = 'stub-resend-key';
process.env.MAIL_FROM = 'Trinity Crafters Market <market@example.com>';

const TOKENS = {
  'tok-admin': { id: '00000000-0000-4000-8000-0000000000ad', email: 'organizer@example.com', email_confirmed_at: '2026-01-01T00:00:00Z' },
  'tok-vendor-one': { id: '00000000-0000-4000-8000-0000000000a1', email: 'vendor-one@example.com', email_confirmed_at: '2026-01-01T00:00:00Z' },
  'tok-vendor-two': { id: '00000000-0000-4000-8000-0000000000a2', email: 'vendor-two@example.com', email_confirmed_at: '2026-01-01T00:00:00Z' },
  'tok-manager': { id: '00000000-0000-4000-8000-0000000000a3', email: 'manager@example.com', email_confirmed_at: '2026-01-01T00:00:00Z' },
  'tok-outsider': { id: '00000000-0000-4000-8000-0000000000a4', email: 'outsider@example.com', email_confirmed_at: '2026-01-01T00:00:00Z' }
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

const providerSends = [];
globalThis.fetch = async (url, opts) => {
  if (String(url).includes('api.resend.com')) {
    providerSends.push(JSON.parse(opts.body));
    return { ok: true, status: 200, json: async () => ({ id: 'stub' }) };
  }
  return { ok: true, status: 200, json: async () => ({}) };
};

let db, sql, handler, appOne, appTwo, eventOne, eventTwo;
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
const hasStaffPermission = (u, key) => Array.isArray(u?.permissions) && u.permissions.includes(key);
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

  const [cat] = await sql`select id from market.categories order by name limit 1`;
  const [loc] = await sql`select id from market.locations order by name limit 1`;
  [eventOne] = await sql`select id from market.events where location_id=${loc.id} and date='2026-11-07'`;
  [eventTwo] = await sql`select id from market.events where location_id=${loc.id} and date='2026-11-21'`;
  assert.ok(eventOne && eventTwo, 'the seeded market dates must exist');
  const mkApp = async (user, name, business, email) => {
    const [app] = await sql`insert into market.applications(user_id,name,email,phone,business,description,category_id,photos,agreements)
      values(${user.id},${name},${email},'5551234567',${business},'Handmade goods',${cat.id},'[]'::jsonb,'{}'::jsonb) returning id`;
    return app;
  };
  appOne = await mkApp(TOKENS['tok-vendor-one'], 'Alice Artisan', 'Alice Crafts', TOKENS['tok-vendor-one'].email);
  appTwo = await mkApp(TOKENS['tok-vendor-two'], 'Ben Baker', 'Ben Bakes', TOKENS['tok-vendor-two'].email);
  await sql`insert into market.bookings(application_id,event_id,space,price,status) values(${appOne.id},${eventOne.id},'indoor',4500,'approved')`;
  await sql`insert into market.bookings(application_id,event_id,space,price,status) values(${appOne.id},${eventTwo.id},'indoor',4500,'approved')`;
  await sql`insert into market.bookings(application_id,event_id,space,price,status) values(${appTwo.id},${eventOne.id},'outdoor',3000,'approved')`;
  await sql`insert into market.staff(email,name,permissions) values('manager@example.com','Market Manager','["vendor_messages"]'::jsonb)`;
});
test.after(async () => { await db.close(); });

const call = (token, body, params = {}) => {
  const qs = new URLSearchParams({ action: 'messages', ...params });
  return handler(new Request('https://market.test/.netlify/functions/api?' + qs, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body)
  }));
};
const alerts = async () => sql`select * from market.outbox where recipient=${ORGANIZER} order by created_at`;
const threadMessages = async appId => sql`select * from market.vendor_messages where application_id=${appId} order by created_at`;
const alertStamp = async appId => (await sql`select message_alert_sent_at from market.applications where id=${appId}`)[0].message_alert_sent_at;

test('§43 (behavioral): a vendor message queues exactly one truncated organizer alert with thread + market context', async () => {
  const longBody = 'A'.repeat(500) + 'TAIL-SECRET-BEYOND-THE-PREVIEW';
  const res = await call('tok-vendor-one', { application_id: appOne.id, body: longBody });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
  assert.equal((await threadMessages(appOne.id)).length, 1, 'the vendor message itself is stored');

  const rows = await alerts();
  assert.equal(rows.length, 1, 'exactly one organizer alert is queued');
  const mail = rows[0];
  assert.equal(mail.recipient, ORGANIZER);
  assert.equal(mail.subject, 'New message from Alice Crafts', 'the subject names the vendor business');
  assert.ok(mail.body.includes('Vendor: Alice Crafts (Alice Artisan)'), 'the body names the vendor');
  assert.ok(mail.body.includes('Email: vendor-one@example.com'), 'the body carries the vendor email');
  assert.ok(mail.body.includes('Thread: Alice Crafts application messages'), 'the body carries the thread context');
  assert.ok(mail.body.includes('Market: '), 'the body carries market context');
  assert.ok(mail.body.includes('November 7, 2026'), 'the market context names the first booked date');
  assert.ok(mail.body.includes('November 21, 2026'), 'the market context names the second booked date');
  assert.ok(mail.body.includes('Hampton Inn Odessa Trinity'), 'the market context names the location');
  assert.ok(mail.body.includes('A'.repeat(500)), 'the preview carries the first 500 characters');
  assert.ok(mail.body.includes('[Message truncated'), 'the preview is visibly marked truncated');
  assert.ok(!mail.body.includes('TAIL-SECRET-BEYOND-THE-PREVIEW'), 'the alert must not leak the message beyond the truncation rule');
  assert.ok(mail.body.includes(LINK), 'the body links to Messages');
  assert.ok(mail.sent_at, 'the queued alert is flushed/sent through the outbox');
  assert.ok(providerSends.some(s => s.to[0] === ORGANIZER && s.subject === 'New message from Alice Crafts'), 'the provider saw the alert');
  assert.ok(await alertStamp(appOne.id), 'the throttle stamp lands on the thread (application) row');
});

test('§43 (behavioral): a rapid second vendor message in the same thread queues no second alert', async () => {
  const res = await call('tok-vendor-one', { application_id: appOne.id, body: 'One more thing — thanks!' });
  assert.equal(res.status, 200);
  assert.equal((await threadMessages(appOne.id)).length, 2, 'the message itself still posts');
  assert.equal((await alerts()).length, 1, 'the hourly throttle suppresses the second alert');
});

test('§43 (behavioral): a vendor message in a different thread alerts independently', async () => {
  const res = await call('tok-vendor-two', { application_id: appTwo.id, body: 'Can I arrive at 8?' });
  assert.equal(res.status, 200);
  const rows = await alerts();
  assert.equal(rows.length, 2, 'the second thread gets its own alert');
  assert.equal(rows[1].subject, 'New message from Ben Bakes');
  assert.ok(rows[1].body.includes('Can I arrive at 8?'), 'a short message is carried in full');
  assert.ok(await alertStamp(appTwo.id), 'the second thread is stamped independently');
});

test('§43 (behavioral): an organizer reply queues no alert and resets the thread clock', async () => {
  const res = await call('tok-admin', { application_id: appOne.id, body: 'Yes — see you there.' });
  assert.equal(res.status, 200);
  assert.equal((await alerts()).length, 2, 'an organizer send must never alert');
  assert.equal(await alertStamp(appOne.id), null, 'the organizer reply resets the throttle stamp');
  const follow = await call('tok-vendor-one', { application_id: appOne.id, body: 'Perfect, thank you!' });
  assert.equal(follow.status, 200);
  assert.equal((await alerts()).length, 3, 'a vendor message after the organizer reply alerts again');
});

test('§43 (behavioral): an organizer opening the thread in v2 resets the clock; a vendor opening it does not', async () => {
  // Vendor reads their own thread first: that must NOT spend the reset.
  const vendorRead = await call('tok-vendor-one', undefined, { read_application_id: appOne.id });
  assert.equal(vendorRead.status, 200);
  assert.ok(await alertStamp(appOne.id), 'a vendor GET must not reset the organizer alert clock');
  const adminRead = await call('tok-admin', undefined, { read_application_id: appOne.id });
  assert.equal(adminRead.status, 200);
  assert.equal(await alertStamp(appOne.id), null, 'the organizer thread-open resets the throttle stamp');
  const res = await call('tok-vendor-one', { application_id: appOne.id, body: 'Following up on my last note.' });
  assert.equal(res.status, 200);
  assert.equal((await alerts()).length, 4, 'a vendor message after the organizer read alerts again');
});

test('§43 (behavioral): a manager send queues no alert', async () => {
  const before = (await alerts()).length;
  const res = await call('tok-manager', { application_id: appTwo.id, body: 'Manager note for Ben.' });
  assert.equal(res.status, 200, 'a permissioned manager can post in the thread');
  assert.equal((await alerts()).length, before, 'a staff send must never alert the organizer');
});

test('§43 (behavioral): after the one-hour window the same thread alerts again', async () => {
  await sql`update market.applications set message_alert_sent_at=now()-interval '61 minutes' where id=${appTwo.id}`;
  const before = (await alerts()).length;
  const res = await call('tok-vendor-two', { application_id: appTwo.id, body: 'Checking in again.' });
  assert.equal(res.status, 200);
  assert.equal((await alerts()).length, before + 1, 'a message after the window queues a fresh alert');
});

test('§43 (behavioral): a non-owner cannot post into the thread and queues nothing', async () => {
  const beforeAlerts = (await alerts()).length;
  const beforeMsgs = (await threadMessages(appOne.id)).length;
  const res = await call('tok-outsider', { application_id: appOne.id, body: 'I should not be here.' });
  assert.equal(res.status, 403, 'a non-owner vendor is refused');
  assert.equal((await alerts()).length, beforeAlerts, 'the refusal queues no alert');
  assert.equal((await threadMessages(appOne.id)).length, beforeMsgs, 'the refusal stores no message');
});
