// Email a Flyer (AUDIT.md §56) — the organizer emails vendors with ONE
// flyer attached (PDF / PNG / JPG, uploaded fresh for each send; there
// is no flyer library). This module owns the three testable seams:
//
//   1. parseFlyerAttachment — the upload validation. The client sends
//      the file as a data URL (or bare base64); the attachment is
//      accepted only when the filename extension, the declared MIME
//      type (when present), and the file's own magic bytes all agree,
//      and the decoded file is at most FLYER_MAX_BYTES. The result is
//      the {filename, content} shape the outbox / Resend plumbing
//      already carries (server/core.mjs queue + flushMail).
//
//   2. resolveFlyerRecipients — the audience. Three modes: a market
//      date's booked vendors (bookings in an attending status —
//      approved / held / paid — plus that date's imported attendees;
//      cancelled and waitlisted never included), every vendor (the
//      directory: applications + imported attendees), and regulars
//      only (the §47 regular flag in EITHER canonical store —
//      market.applications.regular_vendor, or market.vendor_profiles.
//      regular_vendor for imported vendors). Every mode dedupes by
//      email (a vendor with two booths gets ONE email) and excludes
//      silently banned vendors — the same user_id / email / phone
//      match core.banned() and the waitlist scan enforce.
//
//   3. sendFlyer — queue one email per recipient through the existing
//      outbox, flush, then READ BACK each queued row and report what
//      actually happened per recipient: delivered (sent_at stamped),
//      failed (the provider's error), or still queued (never reported
//      as sent). The §40/§53 honesty pattern, applied to a bulk send.
//      Every send writes one audit entry — actor, audience mode, the
//      date for date mode, recipient count, subject, attachment
//      filename, and the delivered/failed/queued outcome counts.
import {audit, flushMail, queue} from './core.mjs';
import {ensureProfileSchema} from './profiles.mjs';
import {normalizePhone} from './rules.mjs';

export const FLYER_MAX_BYTES = 10 * 1024 * 1024;
export const FLYER_MODES = ['event', 'all', 'regulars'];

// Type table: extension aliases -> declared MIME types -> magic bytes.
const FLYER_TYPES = [
  {key: 'pdf', exts: ['pdf'], mimes: ['application/pdf'], magic: [0x25, 0x50, 0x44, 0x46, 0x2d]}, // %PDF-
  {key: 'png', exts: ['png'], mimes: ['image/png'], magic: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]},
  {key: 'jpg', exts: ['jpg', 'jpeg'], mimes: ['image/jpeg'], magic: [0xff, 0xd8, 0xff]},
];
const typeByExt = ext => FLYER_TYPES.find(t => t.exts.includes(ext)) || null;
const typeByMime = mime => FLYER_TYPES.find(t => t.mimes.includes(mime)) || null;
function sniffType(buf) {
  for (const t of FLYER_TYPES) if (buf.length >= t.magic.length && t.magic.every((b, i) => buf[i] === b)) return t;
  return null;
}

// One uploaded flyer -> one outbox/Resend attachment {filename, content}
// (content is base64), or a thrown user Error naming the exact problem.
// Accepts {filename, data_url} (what the v2 composer sends — a
// FileReader data URL) or {filename, content} with bare base64.
export function parseFlyerAttachment(input) {
  const rawName = String(input?.filename || input?.name || '').split(/[\\/]/).pop().trim();
  if (!rawName) throw Error('Choose a flyer file to attach.');
  const ext = (rawName.match(/\.([a-z0-9]+)$/i)?.[1] || '').toLowerCase();
  const byExt = typeByExt(ext);
  if (!byExt) throw Error('Attach the flyer as a PDF, PNG, or JPG file.');
  let mime = '', b64 = '';
  const dataUrl = String(input?.data_url || input?.dataUrl || '');
  if (dataUrl) {
    const m = dataUrl.match(/^data:([^;,]*)(;base64)?,([\s\S]*)$/);
    if (!m || !m[2]) throw Error('That flyer file could not be read. Try attaching it again.');
    mime = m[1].toLowerCase(); b64 = m[3];
  } else {
    b64 = String(input?.content || '');
  }
  b64 = b64.replace(/\s+/g, '');
  if (!b64) throw Error('Choose a flyer file to attach.');
  if (!/^[a-z0-9+/=]+$/i.test(b64)) throw Error('That flyer file could not be read. Try attaching it again.');
  if (mime && typeByMime(mime) !== byExt) throw Error('The flyer file type does not match its name. Attach the original PDF, PNG, or JPG.');
  const buf = Buffer.from(b64, 'base64');
  if (!buf.length) throw Error('That flyer file is empty.');
  if (buf.length > FLYER_MAX_BYTES) throw Error('The flyer is too large — attach a file up to 10 MB.');
  if (sniffType(buf) !== byExt) throw Error('The flyer file contents do not match its type. Attach the original PDF, PNG, or JPG.');
  const filename = (rawName.replace(/[^a-z0-9._-]+/gi, '-').replace(/^-+|-+$/g, '') || 'flyer.' + byExt.exts[0]).slice(0, 120);
  return {filename, content: buf.toString('base64'), bytes: buf.length, type: byExt.key};
}

const cleanEmail = x => String(x || '').trim().toLowerCase();

// Dedupe raw audience rows by email (first row wins), drop rows with
// no usable email, and shape the recipient list the composer previews.
export function dedupeFlyerRecipients(rows) {
  const seen = new Set(), out = [];
  for (const r of rows || []) {
    const email = cleanEmail(r.email);
    if (!email || seen.has(email)) continue;
    seen.add(email);
    out.push({name: r.name || 'Vendor', business: r.business || r.name || 'Vendor', email, user_id: r.user_id || null, phone: r.phone || ''});
  }
  return out.sort((a, b) => a.business.localeCompare(b.business));
}

// Drop anyone under an active silent ban — matched by user_id, email,
// or normalized phone, the same three keys core.banned() checks.
async function withoutBanned(sql, list) {
  if (!list.length) return list;
  const bans = await sql`select user_id, email, phone from market.bans where active`;
  if (!bans.length) return list;
  const ids = new Set(bans.map(b => b.user_id).filter(Boolean).map(String));
  const emails = new Set(bans.map(b => cleanEmail(b.email)).filter(Boolean));
  const phones = new Set(bans.map(b => normalizePhone(b.phone)).filter(Boolean));
  return list.filter(v => !(v.user_id && ids.has(String(v.user_id))) && !emails.has(v.email) && !(v.phone && phones.has(normalizePhone(v.phone))));
}

// The audience for one send. Throws the composer's own wording for a
// missing date / unknown mode. Returns the deduped, ban-free list.
export async function resolveFlyerRecipients(sql, mode, eventId) {
  let rows = [];
  if (mode === 'event') {
    if (!eventId) throw Error('Choose a market date.');
    rows = await sql`
      select a.user_id, a.name, a.business, a.email, a.phone from market.bookings b join market.applications a on a.id = b.application_id
      where b.event_id = ${eventId} and b.status in ('approved','held','paid')
      union all
      select null, i.name, coalesce(nullif(i.business,''), i.name), i.email, i.phone from market.imported_attendees i
      where i.event_id = ${eventId} and coalesce(i.cancelled, false) = false`;
  } else if (mode === 'all') {
    rows = await sql`
      select a.user_id, a.name, a.business, a.email, a.phone from market.applications a where nullif(trim(a.email),'') is not null
      union all
      select null, i.name, coalesce(nullif(i.business,''), i.name), i.email, i.phone from market.imported_attendees i where nullif(trim(i.email),'') is not null`;
  } else if (mode === 'regulars') {
    await ensureProfileSchema(sql);
    rows = await sql`
      select a.user_id, a.name, a.business, a.email, a.phone from market.applications a
      where nullif(trim(a.email),'') is not null
        and (a.regular_vendor or exists(select 1 from market.vendor_profiles p where p.email = lower(trim(a.email)) and p.regular_vendor))
      union all
      select null, i.name, coalesce(nullif(i.business,''), i.name), i.email, i.phone from market.imported_attendees i
      where nullif(trim(i.email),'') is not null
        and exists(select 1 from market.vendor_profiles p where p.email = lower(trim(i.email)) and p.regular_vendor)`;
  } else throw Error('Choose Market Date, All Vendors, or Regulars Only.');
  return withoutBanned(sql, dedupeFlyerRecipients(rows));
}

// Queue + flush + verify one flyer send. `flush` is injectable for
// tests; production uses core flushMail (which never throws — a failed
// batch stays pending for the hourly sweep and reads back as queued).
export async function sendFlyer(sql, {actor, mode, eventId = null, subject, body, attachment, flush = flushMail}) {
  subject = String(subject || '').trim();
  body = String(body || '');
  if (!subject || subject.length > 300) throw Error('Enter an email subject.');
  if (!body.trim() || body.length > 10000) throw Error('Enter the email message.');
  if (!attachment || !attachment.filename || !attachment.content) throw Error('Choose a flyer file to attach.');
  const list = await resolveFlyerRecipients(sql, mode, eventId);
  if (!list.length) throw Error('There are no vendor email addresses in this selection.');
  const queued = [];
  await sql.begin(async tx => {
    for (const v of list) {
      const row = await queue(tx, v.email, subject, body.replaceAll('{{name}}', v.name).replaceAll('{{business}}', v.business), null, [{filename: attachment.filename, content: attachment.content}]);
      queued.push({email: v.email, name: v.name, business: v.business, id: row.id});
    }
  });
  await flush();
  const results = [];
  for (const q of queued) {
    const [row] = await sql`select sent_at, error from market.outbox where id = ${q.id}`;
    if (row?.sent_at) results.push({email: q.email, name: q.name, business: q.business, status: 'delivered', error: null});
    else if (row?.error) results.push({email: q.email, name: q.name, business: q.business, status: 'failed', error: String(row.error)});
    else results.push({email: q.email, name: q.name, business: q.business, status: 'queued', error: null});
  }
  const delivered = results.filter(r => r.status === 'delivered').length;
  const failed = results.filter(r => r.status === 'failed').length;
  const stillQueued = results.length - delivered - failed;
  await audit(sql, actor, 'vendor flyer email', {mode, event_id: eventId || null, count: list.length, delivered, failed, queued: stillQueued, subject, attachment: attachment.filename});
  return {count: list.length, delivered, failed, queued: stillQueued, results};
}

// Recent flyer sends for the section's history list — read from the
// audit trail (the record every send writes), with the market date
// resolved for date-mode sends.
export async function flyerHistory(sql, limit = 50) {
  const rows = await sql`select actor, detail, created_at from market.audit where action = 'vendor flyer email' order by created_at desc limit ${limit}`;
  const eventIds = [...new Set(rows.map(r => r.detail?.event_id).filter(Boolean))];
  const events = new Map();
  for (const id of eventIds) {
    const [e] = await sql`select e.date, l.name as location, l.market_name from market.events e join market.locations l on l.id = e.location_id where e.id = ${id}`;
    if (e) events.set(String(id), e);
  }
  return rows.map(r => {
    const d = r.detail || {}, ev = d.event_id ? events.get(String(d.event_id)) : null;
    return {created_at: r.created_at, sender_email: r.actor, mode: d.mode || 'event', event_id: d.event_id || null,
      event_date: ev?.date || null, location: ev?.location || null, market_name: ev?.market_name || null,
      subject: d.subject || '', attachment: d.attachment || '', recipient_count: d.count ?? 0,
      delivered: d.delivered ?? null, failed: d.failed ?? null, queued: d.queued ?? null};
  });
}
