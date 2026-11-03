// §57 — Optional flyer on the Vendor Communications send (Nov 3,
// 2026). §56 built Email a Flyer as its own section; Scott then opened
// the Vendor Communications composer he already uses and reported
// "No way to attach anything." So the familiar send gains an OPTIONAL
// flyer: same §56 validation (parseFlyerAttachment), the same outbox
// attachment shape, no second send path — and no file means the send
// behaves exactly as it did before. These tests pin the wiring, the
// unchanged audience, attach → queued-with-attachment, invalid file →
// refused with nothing queued, and the audit filename.
import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FLYER_MAX_BYTES, parseFlyerAttachment } from '../server/flyer.mjs';
import { recipients, sendVendorEmail } from '../netlify/functions/communications.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = p => readFileSync(join(root, p), 'utf8');
const SETUP = read('database/setup.sql');
const CODIFY = read('database/codify-live-schema.sql');
const COMMS_FN = read('netlify/functions/communications.mjs');
const COMMS_JS = read('public/v2/js/comms.js');
const FLYER_JS = read('public/v2/js/flyer.js');

// ---------------------------------------------------------------- static pins
test('§57: the Vendor Communications send reuses §56 validation + the outbox attachment shape — no second path', () => {
  assert.ok(COMMS_FN.includes('const attachment=p.attachment?parseFlyerAttachment(p.attachment):null;'),
    'the send validates an attached file with §56 parseFlyerAttachment before anything is queued');
  assert.equal(COMMS_FN.split('parseFlyerAttachment(').length - 1, 2,
    'parseFlyerAttachment is called exactly twice: flyer-send (§56) and the comms send (§57)');
  assert.ok(COMMS_FN.includes('export async function sendVendorEmail'), 'the comms send is an exported seam');
  assert.ok(COMMS_FN.includes('await sendVendorEmail(sql,{actor:u,list,mode,eventId'), 'the handler sends through the seam');
  assert.ok(COMMS_FN.includes('attachments=attachment?[{filename:attachment.filename,content:attachment.content}]:null'),
    'the attachment threads into queue() in the same {filename, content} shape flyer sends use');
  assert.ok(COMMS_FN.includes('queue(tx,v.email,subject,body.replaceAll'), 'seam queues one outbox row per recipient');
  assert.ok(COMMS_FN.includes("{attachment:attachment.filename}"), 'the audit detail names the attachment when one is attached');
  assert.ok(COMMS_FN.includes("audit(tx,actor,'vendor mass email'"), 'the existing vendor mass email audit entry is kept');
});

test('§57: the composer gains the optional attach field; the §56 section is untouched', () => {
  assert.ok(COMMS_JS.includes('Attach a flyer (optional)'), 'the composer labels the field as optional');
  assert.ok(COMMS_JS.includes('id="comm-flyer"'), 'the file input exists under the Message box');
  assert.ok(COMMS_JS.indexOf('id="comm-body"') < COMMS_JS.indexOf('id="comm-flyer"'), 'the attach field sits below the Message box');
  assert.ok(COMMS_JS.includes('attachment: flyer'), 'the send payload carries the optional upload');
  assert.ok(COMMS_JS.includes('readAsDataURL'), 'the file is read the same way the flyer composer reads it');
  assert.ok(COMMS_JS.includes('FLYER_MAX_BYTES'), 'the client pre-check uses the same 10 MB cap');
  assert.ok(FLYER_JS.includes("fnq('communications', 'flyer-send'"), 'the §56 Email a Flyer section still stands on its own');
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
  return { db, sql, catId: cat.id, locId: loc.id, evId: ev.id };
}

async function application(sql, catId, {email, business}) {
  const [a] = await sql`insert into market.applications(user_id,name,email,phone,business,description,category_id,photos,agreements)
    values(${crypto.randomUUID()},'Vendor',${email},'7275550100',${business},'Goods',${catId},'{}','{}') returning *`;
  return a;
}
async function booking(sql, appId, evId, status) {
  const [b] = await sql`insert into market.bookings(application_id,event_id,space,price,status,hold_until)
    values(${appId},${evId},'indoor',4500,${status},${status === 'held' ? new Date(Date.now() + 3600e3).toISOString() : null}) returning *`;
  return b;
}
async function imported(sql, evId, {email, business, cancelled = false}) {
  const [i] = await sql`insert into market.imported_attendees(event_id,name,business,email,cancelled) values(${evId},'Vendor',${business},${email},${cancelled}) returning *`;
  return i;
}

const pdfB64 = Buffer.from('%PDF-1.4 saturday flyer body').toString('base64');
const actor = {email: 'organizer@example.com'};
const noFlush = async () => {}; // delivery is core flushMail's job; §57 asserts what gets QUEUED

async function seedAudience(sql, catId, evId) {
  const a1 = await application(sql, catId, {email: 'dup@example.com', business: 'Dup Biz'});
  await booking(sql, a1.id, evId, 'approved');
  const a2 = await application(sql, catId, {email: 'dup@example.com', business: 'Dup Biz'});
  await booking(sql, a2.id, evId, 'paid'); // same vendor, second booth
  const wl = await application(sql, catId, {email: 'wait@example.com', business: 'Wait Biz'});
  await booking(sql, wl.id, evId, 'waitlist');
  const cx = await application(sql, catId, {email: 'cancelled@example.com', business: 'Gone Biz'});
  await booking(sql, cx.id, evId, 'cancelled');
  await imported(sql, evId, {email: 'imported@example.com', business: 'Imported Biz'});
  await imported(sql, evId, {email: 'imported-gone@example.com', business: 'Imported Gone', cancelled: true});
}

// ------------------------------------------------------------- the send itself
test('§57 (behavioral): the comms audience is unchanged — booked + imported, deduped, waitlist/cancelled out', async () => {
  const { sql, catId, evId } = await seededDb();
  await seedAudience(sql, catId, evId);
  const list = await recipients(sql, 'event', evId);
  assert.deepEqual(list.map(v => v.email), ['dup@example.com', 'imported@example.com']);
  await assert.rejects(() => recipients(sql, 'event', null), /Choose a market date\./);
  await assert.rejects(() => recipients(sql, 'bogus', null), /Choose Market Date or All Vendors\./);
});

test('§57 (behavioral): a valid flyer rides every queued email; the record + audit name the file', async () => {
  const { sql, catId, evId } = await seededDb();
  await seedAudience(sql, catId, evId);
  const list = await recipients(sql, 'event', evId);
  const attachment = parseFlyerAttachment({filename: 'Saturday Flyer.pdf', data_url: 'data:application/pdf;base64,' + pdfB64});
  const r = await sendVendorEmail(sql, {actor, list, mode: 'event', eventId: evId, subject: 'Setup change Saturday', body: 'Hi {{name}} of {{business}} — flyer attached.', attachment, flush: noFlush});
  assert.equal(r.count, 2);
  const outbox = await sql`select recipient, body, attachments from market.outbox order by recipient`;
  assert.equal(outbox.length, 2, 'one outbox row per recipient');
  for (const row of outbox) {
    assert.equal(row.attachments[0].filename, 'Saturday-Flyer.pdf', 'every queued email carries the flyer');
    assert.equal(Buffer.from(row.attachments[0].content, 'base64').toString(), '%PDF-1.4 saturday flyer body');
  }
  assert.ok(outbox.find(x => x.recipient === 'dup@example.com').body.includes('Dup Biz'), '{{business}} personalization is unchanged');
  const comms = await sql`select * from market.vendor_communications`;
  assert.equal(comms.length, 1, 'the send is recorded as before');
  assert.equal(comms[0].recipient_count, 2);
  assert.equal(comms[0].subject, 'Setup change Saturday');
  const audits = await sql`select * from market.audit where action = 'vendor mass email'`;
  assert.equal(audits.length, 1);
  assert.equal(audits[0].actor, 'organizer@example.com');
  assert.equal(audits[0].detail.attachment, 'Saturday-Flyer.pdf', 'the existing audit entry records the attachment filename');
  assert.equal(audits[0].detail.count, 2);
});

test('§57 (behavioral): no file — the send is byte-for-byte the old behavior (no attachments, no audit filename)', async () => {
  const { sql, catId, evId } = await seededDb();
  await seedAudience(sql, catId, evId);
  const list = await recipients(sql, 'event', evId);
  const r = await sendVendorEmail(sql, {actor, list, mode: 'event', eventId: evId, subject: 'Weather update', body: 'Rain plan in effect.', attachment: null, flush: noFlush});
  assert.equal(r.count, 2);
  const outbox = await sql`select attachments from market.outbox`;
  assert.equal(outbox.length, 2);
  for (const row of outbox) assert.equal(row.attachments, null, 'no attachment column value, exactly as before §57');
  const audits = await sql`select * from market.audit where action = 'vendor mass email'`;
  assert.equal(audits.length, 1);
  assert.ok(!('attachment' in audits[0].detail), 'the audit detail gains no attachment key when nothing was attached');
});

test('§57 (behavioral): a bad or oversize flyer refuses the send — nothing queued, nothing recorded', async () => {
  const { sql, catId, evId } = await seededDb();
  await seedAudience(sql, catId, evId);
  const list = await recipients(sql, 'event', evId);
  // The handler's exact order (communications.mjs): parse first, then send.
  const attempt = p => {
    const attachment = p.attachment ? parseFlyerAttachment(p.attachment) : null;
    return sendVendorEmail(sql, {actor, list, mode: 'event', eventId: evId, subject: 'S', body: 'B', attachment, flush: noFlush});
  };
  await assert.rejects(async () => attempt({attachment: {filename: 'flyer.docx', content: pdfB64}}), /PDF, PNG, or JPG/, 'a .docx is refused with §56 wording');
  const big = Buffer.alloc(FLYER_MAX_BYTES + 1); Buffer.from('%PDF-').copy(big);
  await assert.rejects(async () => attempt({attachment: {filename: 'big.pdf', content: big.toString('base64')}}), /too large — attach a file up to 10 MB/, 'over 10 MB is refused with §56 wording');
  assert.equal((await sql`select count(*)::int n from market.outbox`)[0].n, 0, 'nothing was queued');
  assert.equal((await sql`select count(*)::int n from market.vendor_communications`)[0].n, 0, 'no send was recorded');
  assert.equal((await sql`select count(*)::int n from market.audit where action = 'vendor mass email'`)[0].n, 0, 'no audit claims a send that never happened');
});
