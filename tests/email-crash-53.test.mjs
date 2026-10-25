// §53 — Email actions crash around sending (Oct 24, 2026, live fault).
// Scott tapped Email invoice on his own imported invoices (3 market
// dates): every tap showed "The request could not be saved." (the api
// function's generic 500).
//
// THE ACTUAL FAULT (found by reproduction against the real schema, not
// the audit's lead hypothesis): the imported-invoice-email action calls
// nice() (5 sites) and money() (3 sites), which are defined NOWHERE in
// api.mjs and never were (git: the action arrived in 1552aea, Sep 18,
// copied from code that had them in scope; monthly-invoices.mjs and
// server/moves.mjs define their own). The action throws
// ReferenceError: nice is not defined on its first line — before queue()
// is even reached — and the api catch-all (name !== 'Error') maps it to
// the generic 500. The action has never successfully run.
//
// SECOND FAULT (proven in the same reproduction): flushMail drains the
// whole pending outbox in batch transactions. Any SQL-level error inside
// a batch (a poisoned row whose stamp update fails, a deadlock) aborts
// the transaction; the per-row catch's own error-stamp update then
// throws 25P02, which escapes db().begin and propagates out of
// flushMail — 500ing the calling action AFTER the provider already sent
// rows in that batch, whose sent stamps roll back, so the next flush
// re-sends them (duplicates). flushMail also does unbounded work inside
// the request with the caller's own row last (timeout hazard).
//
// Fixes pinned here:
//  (1) api.mjs defines nice/money (nice via the file's own
//      marketDateOnly, so Date and string inputs both work).
//  (2) imported-invoice-email, vendor-receipt, vendor-statement-email
//      and payment-reminder-now confirm only their OWN send (§40
//      pattern: capture the queued row → flush → read it back → report
//      email_delivery; failure returns the provider's reason, never a
//      false success and never the generic 500). vendor-receipt stamps
//      receipt_sent_at only after a confirmed send (it was stamped
//      inside the queue transaction, before any flush).
//  (3) flushMail never throws: a failed batch is logged and left
//      pending for the hourly sweep; earlier committed batches stand.
//  (4) vendor-reengage (bulk) reads back sent/failed counts for the
//      rows it queued, like the setup-instructions email already did.
// The Invoice Center client already gates its success toast on the api()
// promise resolving (api.js throws the server's error text), so honest
// server errors surface with no client redesign — pinned below.
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
const INVOICES_JS = read('public/v2/js/invoices.js');
const API_JS = read('public/v2/js/api.js');
const section = (src, from, to) => src.slice(src.indexOf(from), src.indexOf(to));

// ---------------------------------------------------------------- static pins
test('§53: api.mjs defines the nice/money helpers the invoice email always called', () => {
  assert.ok(API.includes('const money='), 'api.mjs must define money()');
  assert.ok(API.includes('const nice='), 'api.mjs must define nice()');
  const niceDef = API.slice(API.indexOf('const nice='), API.indexOf('const nice=') + 400);
  assert.ok(niceDef.includes('marketDateOnly'), 'nice() must go through marketDateOnly so Date and string dates both format');
});

test('§53: imported-invoice-email verifies its own outbox row before claiming success (§40 pattern)', () => {
  const action = section(API, "if(action==='imported-invoice-email')", "if(action==='import-attendees')");
  assert.ok(action.includes('const queued=await queue(sql,i.email,invoiceSubject,invoiceText,invoiceHtml)'), 'the queued row must be captured');
  assert.ok(action.includes('select sent_at,error from market.outbox where id=${queued.id}'), 'the action must read back its own outbox row');
  assert.ok(action.includes('Invoice email was not sent: '), 'a failed delivery must surface the provider reason');
  assert.ok(action.includes('email_delivery'), 'the response must report email_delivery');
  assert.ok(!action.includes('await flushMail();return json({ok:true})'), 'the old unconditional-success tail must be gone');
});

test('§53: flushMail can never throw into its caller — a failed batch is left pending for the sweep', () => {
  const flush = section(CORE, 'export async function flushMail', 'export async function publicData');
  assert.ok(flush.includes('try{'), 'the batch transaction must be guarded');
  assert.ok(flush.includes('flushMail batch failed'), 'a failed batch must be logged, not propagated');
  assert.ok(flush.includes('return {sent,failed}'), 'flushMail still resolves with its counts');
});

test('§53: vendor-receipt stamps receipt_sent_at only after a confirmed send', () => {
  const action = section(API, "if(action==='vendor-receipt')", "if(action==='vendor-statement-email')");
  assert.ok(!action.includes('receipt_sent_at=now()'), 'the pre-flush receipt stamp must be gone');
  assert.ok(action.includes('Receipt email was not sent: '), 'a failed receipt must surface the provider reason');
  assert.ok(action.includes('receipt_sent_at=${delivery.sent_at}'), 'the stamp must use the confirmed delivery time');
});

test('§53: vendor-statement-email and payment-reminder-now verify their own sends', () => {
  const stmt = section(API, "if(action==='vendor-statement-email')", "if(action==='floor-area-plans-save')");
  assert.ok(stmt.includes('Statement email was not sent: '), 'the statement action must surface delivery failure');
  assert.ok(stmt.includes('email_delivery'), 'the statement response must report email_delivery');
  const rem = section(API, "if(action==='payment-reminder-now')", "if(action==='application-attempt-dismiss')");
  assert.ok(rem.includes('Payment reminder email was not sent: '), 'the reminder action must surface delivery failure');
  assert.ok(rem.includes('email_delivery'), 'the reminder response must report email_delivery');
});

test('§53: vendor-reengage reads back delivery counts for the rows it queued', () => {
  const action = section(API, "if(action==='vendor-reengage')", "if(action==='vendor-payment')");
  assert.ok(action.includes('queuedIds'), 'the bulk send must collect the rows it queued');
  assert.ok(action.includes('sent_count'), 'the response must report how many actually sent');
  assert.ok(action.includes('failed_count'), 'the response must report how many failed');
});

test('§53: the Invoice Center already shows the success toast only on a confirmed ok response', () => {
  assert.ok(INVOICES_JS.includes("mutate(() => api('imported-invoice-email', { id: x.id }), 'Invoice emailed.')"),
    'imp-email must stay wired through mutate() so the toast fires only when api() resolves');
  assert.ok(API_JS.includes("throw Error(v.error || 'Please try again.')"),
    'api() must keep throwing the server error text so honest failures reach the toast');
});

// ---------------------------------------------------------------- behavioral harness
// Real server/core.mjs (queue/audit/flushMail/isUserError byte-identical)
// + the real api.mjs handler, over one PGlite with the full live schema.
// Resend is a global fetch mock with per-recipient behavior.
process.env.RESEND_API_KEY = 'test-key';
process.env.MAIL_FROM = 'Trinity Crafters Market <market@example.com>';

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
let mailBehavior = () => 'ok';
globalThis.fetch = async (url, opts) => {
  const payload = JSON.parse(opts.body);
  const to = payload.to[0];
  sends.push(to);
  if (mailBehavior(to) === 'fail') return { ok: false, status: 500, json: async () => ({ message: 'stub provider failure for ' + to }) };
  return { ok: true, status: 200, json: async () => ({ id: 'stub' }) };
};

const POISON_ON = `create or replace function market.poison_update() returns trigger language plpgsql as $$ begin raise exception 'deadlock detected (simulated batch poison)'; end $$;
  create trigger outbox_poison before update on market.outbox for each row when (old.recipient = 'poison@example.com') execute function market.poison_update();`;

let db, sql, core, handler;
const ADMIN = { id: '00000000-0000-4000-8000-0000000000ad', email: 'organizer@example.com', admin: true, manager: false, permissions: [] };

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
const createClient = () => ({});
const normalizePhone = s => String(s || '').replace(/[^0-9]/g, '');
const publicCounts = async () => ({ spaces: new Map() });
const categoryCountRows = async () => [];
`;
  core = await import('data:text/javascript;base64,' + Buffer.from(corePrelude + coreSrc).toString('base64'));
  globalThis.__core = core;

  let apiSrc = await readFile(join(root, 'netlify/functions/api.mjs'), 'utf8');
  apiSrc = apiSrc.replace(/^import .*$/gm, '');
  const noop = async () => {};
  const prelude = `
const {queue, audit, flushMail, isUserError} = globalThis.__core;
const ready = () => true;
const db = () => globalThis.__sql;
const supa = () => ({});
const identity = async () => globalThis.__who;
const banned = async () => false;
const expire = ${noop.toString()};
const publicData = async () => ({});
const staffActionAllowed = () => true;
const hasStaffPermission = () => false;
const normalizePhone = s => String(s || '').replace(/[^0-9]/g, '');
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
const banEmail = () => ({ subject: '', body: '' });
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
  globalThis.__who = ADMIN;
});

test.after(async () => { await db.close(); });

const post = (action, body) => handler(new Request('https://market.test/.netlify/functions/api?action=' + action, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
}));
const cleanMail = async () => {
  await sql`delete from market.outbox`;
  await sql`delete from market.audit`;
  await db.exec('drop trigger if exists outbox_poison on market.outbox;');
  sends.length = 0; mailBehavior = () => 'ok';
};
const seedOutbox = async rows => {
  for (const r of rows) await sql`insert into market.outbox(recipient,subject,body,created_at) values(${r.to},'Seeded mail','Body',${r.at})`;
};
let fixtureSeq = 0;
async function importedInvoice(email) {
  const n = ++fixtureSeq;
  const [loc] = await sql`insert into market.locations(name,address) values(${'Hall ' + n},'1 Main St') returning id`;
  const [ev] = await sql`insert into market.events(location_id,date) values(${loc.id},'2026-11-07') returning id`;
  const [att] = await sql`insert into market.imported_attendees(event_id,name,business,email,invoice_amount,payment_status,space) values(${ev.id},${'Vendor ' + n},${'Biz ' + n},${email},4500,'paid','indoor') returning id`;
  return att;
}

test('§53 (behavioral): imported invoice email queues, delivers, and reports its own delivery', async () => {
  await cleanMail();
  const att = await importedInvoice('vendor-one@example.com');
  const res = await post('imported-invoice-email', { id: att.id });
  assert.equal(res.status, 200, 'the email action must succeed (was: ReferenceError → generic 500)');
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.email_delivery.sent, true, 'the response must confirm the delivery it checked');
  assert.ok(sends.includes('vendor-one@example.com'), 'the provider must have sent the invoice');
  const [row] = await sql`select sent_at, subject from market.outbox where recipient='vendor-one@example.com'`;
  assert.ok(row.sent_at, 'the outbox row must be stamped sent');
  assert.ok(row.subject.startsWith('Trinity Crafters Market invoice — '), 'the subject must be built with the restored helpers');
  const audits = await sql`select * from market.audit where action='imported invoice emailed'`;
  assert.equal(audits.length, 1, 'the emailed audit must be recorded after the confirmed send');
});

test('§53 (behavioral): a poisoned later batch cannot fail the invoice email after it sent', async () => {
  await cleanMail();
  const att = await importedInvoice('vendor-two@example.com');
  await seedOutbox(Array.from({ length: 9 }, (_, i) => ({ to: 'old' + i + '@example.com', at: new Date(Date.now() - (30 - i) * 60000).toISOString() })));
  await seedOutbox([
    { to: 'poison@example.com', at: new Date(Date.now() + 3600000).toISOString() },
    { to: 'later1@example.com', at: new Date(Date.now() + 3700000).toISOString() },
  ]);
  await db.exec(POISON_ON);
  const res = await post('imported-invoice-email', { id: att.id });
  assert.equal(res.status, 200, 'a failure elsewhere in the queue must not fail this request');
  const body = await res.json();
  assert.equal(body.email_delivery.sent, true);
  const [own] = await sql`select sent_at from market.outbox where recipient='vendor-two@example.com'`;
  assert.ok(own.sent_at, 'the invoice row (batch 1) must stay stamped');
  const [poison] = await sql`select sent_at from market.outbox where recipient='poison@example.com'`;
  assert.equal(poison.sent_at, null, 'the poisoned batch stays pending for the sweep');
  await db.exec('drop trigger if exists outbox_poison on market.outbox;');
});

test('§53 (behavioral): when the invoice email itself fails, the error is the provider reason — not the generic 500, not false success', async () => {
  await cleanMail();
  const att = await importedInvoice('vendor-three@example.com');
  mailBehavior = to => to === 'vendor-three@example.com' ? 'fail' : 'ok';
  const res = await post('imported-invoice-email', { id: att.id });
  const body = await res.json();
  assert.equal(res.status, 400, 'a delivery failure is a reportable error, not a server crash');
  assert.ok(body.error.includes('Invoice email was not sent: '), 'the error must name the failed send');
  assert.ok(body.error.includes('stub provider failure'), 'the error must carry the provider reason');
  assert.notEqual(body.error, 'The request could not be saved.');
  const audits = await sql`select * from market.audit where action='imported invoice emailed'`;
  assert.equal(audits.length, 0, 'no audit may claim an email that did not send');
});

test('§53 (behavioral): flushMail resolves through a poisoned batch; earlier batches keep their stamps', async () => {
  await cleanMail();
  await seedOutbox(Array.from({ length: 10 }, (_, i) => ({ to: 'batch1-' + i + '@example.com', at: new Date(Date.now() - (30 - i) * 60000).toISOString() })));
  await seedOutbox([
    { to: 'poison@example.com', at: new Date(Date.now() - 5000).toISOString() },
    { to: 'batch2@example.com', at: new Date(Date.now() - 4000).toISOString() },
  ]);
  await db.exec(POISON_ON);
  const r = await core.flushMail(); // must resolve, not throw
  assert.equal(typeof r.sent, 'number');
  assert.equal((await sql`select count(*)::int n from market.outbox where recipient like 'batch1-%' and sent_at is not null`)[0].n, 10,
    'the committed first batch keeps its sent stamps');
  assert.equal((await sql`select count(*)::int n from market.outbox where recipient in ('poison@example.com','batch2@example.com') and sent_at is null`)[0].n, 2,
    'the poisoned batch is left pending for the sweep');
  const r2 = await core.flushMail(); // and again — the caller is never thrown into
  assert.equal(typeof r2.failed, 'number');
  await db.exec('drop trigger if exists outbox_poison on market.outbox;');
});

test('§53 (behavioral): flushMail still isolates a provider-failing row from its batchmates', async () => {
  await cleanMail();
  mailBehavior = to => to === 'bad@example.com' ? 'fail' : 'ok';
  await seedOutbox([
    { to: 'ok1@example.com', at: new Date(Date.now() - 30000).toISOString() },
    { to: 'bad@example.com', at: new Date(Date.now() - 20000).toISOString() },
    { to: 'ok2@example.com', at: new Date(Date.now() - 10000).toISOString() },
  ]);
  const r = await core.flushMail();
  assert.deepEqual(r, { sent: 2, failed: 1 });
  const [bad] = await sql`select error from market.outbox where recipient='bad@example.com'`;
  assert.ok(bad.error.includes('stub provider failure'), 'the provider error lands on the failing row only');
});

test('§53 (behavioral): vendor-receipt verifies delivery and only then stamps receipt_sent_at', async () => {
  await cleanMail();
  const att = await importedInvoice('receipt-vendor@example.com');
  const [pay] = await sql`insert into market.vendor_payments(imported_attendee_id,amount,payment_method,paid_at,note) values(${att.id},4500,'Cash',now(),'door') returning id`;
  const res = await post('vendor-receipt', { payment_id: pay.id });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.email_delivery.sent, true);
  const [after] = await sql`select receipt_sent_at from market.vendor_payments where id=${pay.id}`;
  assert.ok(after.receipt_sent_at, 'receipt_sent_at must be stamped after the confirmed send');
});

test('§53 (behavioral): a failed receipt send reports the provider reason and leaves receipt_sent_at null', async () => {
  await cleanMail();
  const att = await importedInvoice('receipt-fail@example.com');
  const [pay] = await sql`insert into market.vendor_payments(imported_attendee_id,amount,payment_method,paid_at,note) values(${att.id},4500,'Cash',now(),'door') returning id`;
  mailBehavior = to => to === 'receipt-fail@example.com' ? 'fail' : 'ok';
  const res = await post('vendor-receipt', { payment_id: pay.id });
  const body = await res.json();
  assert.equal(res.status, 400);
  assert.ok(body.error.includes('Receipt email was not sent: '), 'the error must name the failed send');
  const [after] = await sql`select receipt_sent_at from market.vendor_payments where id=${pay.id}`;
  assert.equal(after.receipt_sent_at, null, 'an unsent receipt must never be stamped sent');
});

test('§53 (behavioral): vendor-statement-email confirms its own delivery', async () => {
  await cleanMail();
  const [cat] = await sql`select id from market.categories limit 1`;
  const [app] = await sql`insert into market.applications(user_id,name,email,phone,business,description,category_id,photos,agreements) values(gen_random_uuid(),'Stmt Vendor','stmt@example.com','555','Stmt Biz','desc',${cat.id},'[]','{}') returning id`;
  const res = await post('vendor-statement-email', { application_id: app.id, source: 'application', year: 2026 });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.email_delivery.sent, true);
  assert.ok(sends.includes('stmt@example.com'), 'the statement must reach the vendor');
});

test('§53 (behavioral): payment-reminder-now confirms its own delivery and audits after the send', async () => {
  await cleanMail();
  const [cat] = await sql`select id from market.categories limit 1`;
  const [loc] = await sql`select id from market.locations limit 1`;
  const [ev] = await sql`insert into market.events(location_id,date) values(${loc.id},'2027-02-20') returning id`;
  const [app] = await sql`insert into market.applications(user_id,name,email,phone,business,description,category_id,photos,agreements) values(gen_random_uuid(),'Rem Vendor','remind@example.com','555','Rem Biz','desc',${cat.id},'[]','{}') returning id`;
  const [bk] = await sql`insert into market.bookings(application_id,event_id,space,price,status,hold_until) values(${app.id},${ev.id},'indoor',4500,'held',now()+interval '2 hours') returning id`;
  const res = await post('payment-reminder-now', { id: bk.id });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.email_delivery.sent, true);
  assert.ok(sends.includes('remind@example.com'), 'the reminder must reach the vendor');
  const audits = await sql`select * from market.audit where action='manual payment reminder sent'`;
  assert.equal(audits.length, 1, 'the sent audit is recorded once, after the confirmed send');
});
