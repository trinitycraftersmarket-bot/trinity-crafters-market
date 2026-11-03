// §56 — Email a Flyer (Nov 3, 2026). Scott: "Make a section of the
// market app to email vendors an attached flyer" — approved shape:
// audience = a market date's booked vendors / all vendors / regulars
// only, count previewed before sending ("This will go to N vendors"),
// banned vendors excluded everywhere; subject + message + ONE flyer
// uploaded fresh per send (PDF / PNG / JPG, 10 MB cap); the send
// rides the existing outbox/Resend plumbing and reads back every
// queued row, reporting delivered / failed (with the reason) / still
// queued per vendor — a queued or failed email is never "sent"; and
// every send writes an audit entry (actor, mode, date, count,
// subject, attachment filename). These tests pin the attachment
// validation, all three audience modes incl. dedupe + ban exclusion,
// the audit entry, and the honest result list.
import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FLYER_MAX_BYTES, parseFlyerAttachment, dedupeFlyerRecipients, resolveFlyerRecipients, sendFlyer, flyerHistory } from '../server/flyer.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = p => readFileSync(join(root, p), 'utf8');
const SETUP = read('database/setup.sql');
const CODIFY = read('database/codify-live-schema.sql');
const FLYER = read('server/flyer.mjs');
const COMMS_FN = read('netlify/functions/communications.mjs');
const APP = read('public/v2/js/app.js');
const FLYER_JS = read('public/v2/js/flyer.js');

// ---------------------------------------------------------------- static pins
test('§56: the flyer seams live in server/flyer.mjs and ride the existing outbox plumbing', () => {
  assert.ok(FLYER.includes("from './core.mjs'"), 'flyer sends ride core queue/flushMail/audit');
  assert.ok(FLYER.includes('queue(tx, v.email'), 'one outbox row per recipient — no CC/BCC blast');
  assert.ok(FLYER.includes("select sent_at, error from market.outbox where id = ${q.id}"), 'every queued row is read back before any delivery is reported');
  assert.ok(FLYER.includes("audit(sql, actor, 'vendor flyer email'"), 'every send writes the audit entry');
  assert.ok(FLYER.includes('attachment: attachment.filename'), 'the audit detail carries the attachment filename');
});

test('§56: communications gains flyer actions behind the same organizer gate; the v2 section is wired into Messages', () => {
  assert.ok(COMMS_FN.includes("action==='flyer-preview'"), 'flyer-preview action exists');
  assert.ok(COMMS_FN.includes("action==='flyer-send'"), 'flyer-send action exists');
  assert.ok(COMMS_FN.includes('parseFlyerAttachment(p.attachment)'), 'the send validates the uploaded flyer server-side');
  assert.ok(COMMS_FN.indexOf("u.admin||u.manager") < COMMS_FN.indexOf("action==='flyer-preview'"), 'the organizer gate still precedes the flyer actions');
  assert.ok(APP.includes("label: 'Email a Flyer'") && APP.includes("live: 'flyer'"), 'the section is registered in the Messages group');
  assert.ok(APP.includes('renderFlyer(ctx, root)'), 'the router dispatches to renderFlyer');
  assert.ok(FLYER_JS.includes("fnq('communications', 'flyer-preview'"), 'the composer previews through flyer-preview');
  assert.ok(FLYER_JS.includes("fnq('communications', 'flyer-send'"), 'the composer sends through flyer-send');
  assert.ok(FLYER_JS.includes('This will go to'), 'the resolved count is shown before sending');
  assert.ok(FLYER_JS.includes('Still queued — not delivered yet'), 'the results list never calls a queued email sent');
});

// ------------------------------------------------------- attachment validation
const pdfB64 = Buffer.from('%PDF-1.4 fake flyer body').toString('base64');
const pngB64 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]).toString('base64');
const jpgB64 = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]).toString('base64');

test('§56: a valid PDF / PNG / JPG upload becomes one outbox-ready attachment', () => {
  const pdf = parseFlyerAttachment({filename: 'Nov Flyer.pdf', data_url: 'data:application/pdf;base64,' + pdfB64});
  assert.equal(pdf.filename, 'Nov-Flyer.pdf'); assert.equal(pdf.type, 'pdf');
  assert.equal(Buffer.from(pdf.content, 'base64').toString(), '%PDF-1.4 fake flyer body');
  const png = parseFlyerAttachment({filename: 'flyer.PNG', content: pngB64});
  assert.equal(png.type, 'png'); assert.equal(png.filename, 'flyer.PNG');
  const jpg = parseFlyerAttachment({filename: 'flyer.jpeg', data_url: 'data:image/jpeg;base64,' + jpgB64});
  assert.equal(jpg.type, 'jpg');
});

test('§56: bad type, mismatched contents, empty and oversize uploads are refused with clear errors', () => {
  assert.throws(() => parseFlyerAttachment({filename: 'flyer.docx', content: pdfB64}), /PDF, PNG, or JPG/, 'a .docx name is refused');
  assert.throws(() => parseFlyerAttachment({filename: 'flyer.pdf', content: pngB64}), /contents do not match/, 'PNG bytes in a .pdf are refused');
  assert.throws(() => parseFlyerAttachment({filename: 'flyer.png', data_url: 'data:application/pdf;base64,' + pngB64}), /does not match its name/, 'a MIME/extension disagreement is refused');
  assert.throws(() => parseFlyerAttachment({filename: 'flyer.pdf', content: ''}), /Choose a flyer file/, 'an empty upload is refused');
  assert.throws(() => parseFlyerAttachment({}), /Choose a flyer file/, 'a missing upload is refused');
  assert.throws(() => parseFlyerAttachment({filename: 'flyer.pdf', content: 'not base64!!'}), /could not be read/, 'garbage base64 is refused');
  const big = Buffer.alloc(FLYER_MAX_BYTES + 1); Buffer.from('%PDF-').copy(big);
  assert.throws(() => parseFlyerAttachment({filename: 'big.pdf', content: big.toString('base64')}), /too large — attach a file up to 10 MB/, 'over 10 MB is refused with the cap named');
});

test('§56: dedupe is by email — a vendor with two booths gets ONE email', () => {
  const out = dedupeFlyerRecipients([
    {name: 'A', business: 'Dup Biz', email: 'Dup@Example.com'},
    {name: 'A', business: 'Dup Biz', email: 'dup@example.com'},
    {name: 'B', business: 'No Mail Biz', email: ''},
    {name: 'C', business: 'Solo Biz', email: 'solo@example.com'},
  ]);
  assert.deepEqual(out.map(v => v.email), ['dup@example.com', 'solo@example.com']);
});

// ---------------------------------------------------------------- PGlite rig
function pgliteSql(db) {
  const sql = async (strings, ...values) => {
    let text = '', params = [];
    strings.forEach((s, i) => { text += s; if (i < values.length) { params.push(values[i]); text += '$' + params.length; } });
    return (await db.query(text, params)).rows;
  };
  sql.json = v => JSON.stringify(v);
  sql.begin = async fn => {
    await db.exec('begin');
    try { const r = await fn(sql); await db.exec('commit'); return r; }
    catch (e) { await db.exec('rollback'); throw e; }
  };
  return sql;
}

async function seededDb() {
  const db = new PGlite();
  await db.exec('create role anon; create role authenticated; create schema storage; create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);');
  await db.exec(SETUP);
  await db.exec(CODIFY);
  await db.exec(await readFile(join(root, 'database/vendor-profiles.sql'), 'utf8'));
  const sql = pgliteSql(db);
  const [cat] = await sql`select id from market.categories limit 1`;
  const [loc] = await sql`insert into market.locations(name,address) values('Hampton Inn Odessa Trinity','1 Test Way') returning id`;
  const [ev] = await sql`insert into market.events(location_id,date) values(${loc.id},'2027-06-05') returning id`;
  const [ev2] = await sql`insert into market.events(location_id,date) values(${loc.id},'2027-06-12') returning id`;
  return { db, sql, catId: cat.id, locId: loc.id, evId: ev.id, ev2Id: ev2.id };
}

async function application(sql, catId, {email, business, regular = false, phone = '7275550100', userId = crypto.randomUUID()}) {
  const [a] = await sql`insert into market.applications(user_id,name,email,phone,business,description,category_id,photos,agreements,regular_vendor)
    values(${userId},'Vendor',${email},${phone},${business},'Goods',${catId},'{}','{}',${regular}) returning *`;
  return a;
}
async function booking(sql, appId, evId, status) {
  const [b] = await sql`insert into market.bookings(application_id,event_id,space,price,status,hold_until)
    values(${appId},${evId},'indoor',4500,${status},${status === 'held' ? new Date(Date.now() + 3600e3).toISOString() : null}) returning *`;
  return b;
}
async function imported(sql, evId, {email, business, cancelled = false, phone = null}) {
  const [i] = await sql`insert into market.imported_attendees(event_id,name,business,email,phone,cancelled) values(${evId},'Vendor',${business},${email},${phone},${cancelled}) returning *`;
  return i;
}

// ------------------------------------------------------------- audience modes
test('§56 (behavioral): date mode = booked vendors only — deduped, waitlist/cancelled/pending out', async () => {
  const { sql, catId, evId, ev2Id } = await seededDb();
  const a1 = await application(sql, catId, {email: 'dup@example.com', business: 'Dup Biz'});
  await booking(sql, a1.id, evId, 'approved');
  const a2 = await application(sql, catId, {email: 'dup@example.com', business: 'Dup Biz'});
  await booking(sql, a2.id, evId, 'paid'); // same vendor, second booth under a second application
  const held = await application(sql, catId, {email: 'held@example.com', business: 'Held Biz'});
  await booking(sql, held.id, evId, 'held');
  const wl = await application(sql, catId, {email: 'wait@example.com', business: 'Wait Biz'});
  await booking(sql, wl.id, evId, 'waitlist');
  const cx = await application(sql, catId, {email: 'cancelled@example.com', business: 'Gone Biz'});
  await booking(sql, cx.id, evId, 'cancelled');
  const pd = await application(sql, catId, {email: 'pending@example.com', business: 'Pending Biz'});
  await booking(sql, pd.id, evId, 'pending');
  const other = await application(sql, catId, {email: 'otherdate@example.com', business: 'Other Date Biz'});
  await booking(sql, other.id, ev2Id, 'approved');
  await imported(sql, evId, {email: 'imported@example.com', business: 'Imported Biz'});
  await imported(sql, evId, {email: 'imported-gone@example.com', business: 'Imported Gone', cancelled: true});
  await imported(sql, evId, {email: 'dup@example.com', business: 'Dup Biz'}); // imported twin of the same vendor
  const list = await resolveFlyerRecipients(sql, 'event', evId);
  assert.deepEqual(list.map(v => v.email), ['dup@example.com', 'held@example.com', 'imported@example.com'],
    'date audience = approved/paid/held bookings + live imported attendees, each email once');
});

test('§56 (behavioral): banned vendors are excluded in every mode — by user_id, email, or phone', async () => {
  const { sql, catId, evId } = await seededDb();
  const bannedById = await application(sql, catId, {email: 'byid@example.com', business: 'By Id Biz', regular: true});
  await booking(sql, bannedById.id, evId, 'approved');
  const bannedByMail = await application(sql, catId, {email: 'bymail@example.com', business: 'By Mail Biz'});
  await booking(sql, bannedByMail.id, evId, 'approved');
  const bannedByPhone = await application(sql, catId, {email: 'byphone@example.com', business: 'By Phone Biz', phone: '7275550199'});
  await booking(sql, bannedByPhone.id, evId, 'approved');
  const clean = await application(sql, catId, {email: 'clean@example.com', business: 'Clean Biz'});
  await booking(sql, clean.id, evId, 'approved');
  await imported(sql, evId, {email: 'imp-banned@example.com', business: 'Imported Banned'});
  await imported(sql, evId, {email: 'imp-clean@example.com', business: 'Imported Clean'});
  await sql`insert into market.bans(user_id,name,email,phone,reason) values(${bannedById.user_id},'By Id',null,null,'test')`;
  await sql`insert into market.bans(user_id,name,email,phone,reason) values(null,'By Mail','BYMAIL@example.com',null,'test')`;
  await sql`insert into market.bans(user_id,name,email,phone,reason) values(null,'By Phone',null,'(727) 555-0199','test')`;
  await sql`insert into market.bans(user_id,name,email,phone,reason) values(null,'Imported Banned','imp-banned@example.com',null,'test')`;
  for (const mode of ['event', 'all', 'regulars']) {
    const list = await resolveFlyerRecipients(sql, mode, mode === 'event' ? evId : null);
    const emails = list.map(v => v.email);
    for (const banned of ['byid@example.com', 'bymail@example.com', 'byphone@example.com', 'imp-banned@example.com'])
      assert.ok(!emails.includes(banned), `${mode} mode must exclude banned ${banned}`);
    assert.ok(emails.includes('clean@example.com') || mode === 'regulars', `${mode} mode keeps unbanned vendors`);
  }
});

test('§56 (behavioral): all mode reaches the whole directory; regulars mode only the flagged — from either flag store', async () => {
  const { sql, catId, evId } = await seededDb();
  await application(sql, catId, {email: 'reg-app@example.com', business: 'Regular App Biz', regular: true});
  await application(sql, catId, {email: 'plain@example.com', business: 'Plain Biz'});
  await application(sql, catId, {email: 'reg-profile@example.com', business: 'Regular Profile Biz'}); // flag lives on the profile
  await sql`insert into market.vendor_profiles(email,name,business,regular_vendor) values('reg-profile@example.com','Vendor','Regular Profile Biz',true)`;
  await imported(sql, evId, {email: 'reg-imported@example.com', business: 'Regular Imported Biz'});
  await sql`insert into market.vendor_profiles(email,name,business,regular_vendor) values('reg-imported@example.com','Vendor','Regular Imported Biz',true)`;
  await imported(sql, evId, {email: 'plain-imported@example.com', business: 'Plain Imported Biz'});
  const all = await resolveFlyerRecipients(sql, 'all', null);
  assert.deepEqual(all.map(v => v.email), ['plain@example.com', 'plain-imported@example.com', 'reg-app@example.com', 'reg-imported@example.com', 'reg-profile@example.com']);
  const regulars = await resolveFlyerRecipients(sql, 'regulars', null);
  assert.deepEqual(regulars.map(v => v.email), ['reg-app@example.com', 'reg-imported@example.com', 'reg-profile@example.com'],
    'regulars = application flag OR profile flag, nothing else');
  await assert.rejects(() => resolveFlyerRecipients(sql, 'event', null), /Choose a market date\./, 'date mode without a date is refused');
  await assert.rejects(() => resolveFlyerRecipients(sql, 'bogus', null), /Choose Market Date, All Vendors, or Regulars Only\./, 'an unknown mode is refused');
});

// ------------------------------------------------------------- the send itself
// A flush with flushMail's semantics: every pending row is attempted;
// fail@ bounces with a provider reason; leave@ is never attempted (the
// mail-not-configured / poisoned-batch case) and stays queued.
function stubFlush(sql) {
  return async () => {
    const rows = await sql`select id, recipient from market.outbox where sent_at is null and error is null order by created_at`;
    for (const r of rows) {
      if (r.recipient.endsWith('@leave.example.com')) continue;
      if (r.recipient.endsWith('@fail.example.com')) await sql`update market.outbox set error = ${'Email delivery failed: 422 — stub provider failure'} where id = ${r.id}`;
      else await sql`update market.outbox set sent_at = now() where id = ${r.id}`;
    }
  };
}

test('§56 (behavioral): a flyer send queues one attached email per vendor, audits, and reports delivery honestly', async () => {
  const { sql, catId, evId } = await seededDb();
  for (const [email, business] of [['ok@ok.example.com', 'Ok Biz'], ['bad@fail.example.com', 'Fail Biz'], ['slow@leave.example.com', 'Leave Biz']]) {
    const a = await application(sql, catId, {email, business});
    await booking(sql, a.id, evId, 'approved');
  }
  const attachment = parseFlyerAttachment({filename: 'market-flyer.pdf', data_url: 'data:application/pdf;base64,' + pdfB64});
  const actor = {email: 'organizer@example.com'};
  const r = await sendFlyer(sql, {actor, mode: 'event', eventId: evId, subject: 'This Saturday!', body: 'Hi {{name}} of {{business}} — flyer attached.', attachment, flush: stubFlush(sql)});
  assert.equal(r.count, 3);
  assert.deepEqual([r.delivered, r.failed, r.queued], [1, 1, 1], 'one delivered, one failed, one still queued — and only the first is "delivered"');
  const byEmail = Object.fromEntries(r.results.map(x => [x.email, x]));
  assert.equal(byEmail['ok@ok.example.com'].status, 'delivered');
  assert.equal(byEmail['bad@fail.example.com'].status, 'failed');
  assert.ok(byEmail['bad@fail.example.com'].error.includes('stub provider failure'), 'the failed row carries the provider reason');
  assert.equal(byEmail['slow@leave.example.com'].status, 'queued', 'an unattempted row is queued, never sent');
  const outbox = await sql`select recipient, body, attachments from market.outbox order by recipient`;
  assert.equal(outbox.length, 3, 'one outbox row per recipient (no blast)');
  for (const row of outbox) {
    assert.equal(row.attachments[0].filename, 'market-flyer.pdf', 'every row carries the flyer');
    assert.equal(Buffer.from(row.attachments[0].content, 'base64').toString(), '%PDF-1.4 fake flyer body');
  }
  assert.ok(outbox.find(x => x.recipient === 'ok@ok.example.com').body.includes('Ok Biz'), '{{business}} personalization rides along');
  const audits = await sql`select * from market.audit where action = 'vendor flyer email'`;
  assert.equal(audits.length, 1, 'exactly one audit entry for the send');
  const d = audits[0].detail;
  assert.equal(audits[0].actor, 'organizer@example.com');
  assert.deepEqual([d.mode, d.event_id, d.count, d.delivered, d.failed, d.queued, d.subject, d.attachment],
    ['event', evId, 3, 1, 1, 1, 'This Saturday!', 'market-flyer.pdf'], 'the audit detail names actor-side facts: mode, date, count, outcome, subject, attachment');
  const history = await flyerHistory(sql);
  assert.equal(history.length, 1);
  assert.equal(history[0].attachment, 'market-flyer.pdf');
  // (PGlite hands date columns back as JS Dates; production returns
  // 'YYYY-MM-DD' strings — compare the calendar day either way.)
  assert.equal(new Date(history[0].event_date).toDateString(), new Date('2027-06-05T12:00:00').toDateString(), 'history resolves the market date for date-mode sends');
});

test('§56 (behavioral): a send with no recipients or no flyer refuses before anything is queued', async () => {
  const { sql, catId } = await seededDb();
  const a = await application(sql, catId, {email: 'someone@example.com', business: 'Some Biz'});
  const attachment = parseFlyerAttachment({filename: 'f.pdf', content: pdfB64});
  await assert.rejects(() => sendFlyer(sql, {actor: {email: 'o@x.co'}, mode: 'regulars', subject: 'S', body: 'B', attachment, flush: stubFlush(sql)}),
    /no vendor email addresses/, 'an empty audience refuses');
  const ev = await sql`select id from market.events limit 1`;
  await assert.rejects(() => sendFlyer(sql, {actor: {email: 'o@x.co'}, mode: 'event', eventId: ev[0].id, subject: 'S', body: 'B', attachment: null, flush: stubFlush(sql)}),
    /Choose a flyer file/, 'a missing attachment refuses');
  assert.equal((await sql`select count(*)::int n from market.outbox`)[0].n, 0, 'nothing was queued');
  assert.equal((await sql`select count(*)::int n from market.audit where action = 'vendor flyer email'`)[0].n, 0, 'no audit claims a send that never happened');
  void a;
});
