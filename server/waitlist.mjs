// Waitlist auto-offer engine (AUDIT.md §12, owner decision §13.6).
//
// When a spot opens, the first eligible waitlisted vendor for that event +
// space type gets a 12-hour offer (bookings.waitlist_offered_at + a
// market.waitlist_offers history row). Category-full vendors are SKIPPED and
// keep their position (unless they hold a category exception). An offer that
// expires passes to the next vendor; the expired vendor keeps their position
// but is not re-offered the SAME opening — the waitlist_offers history since
// the current opening began (tracked by a market.settings watermark per
// event+space) is the exclusion list. All capacity/category math goes through
// server/counts.mjs — this module writes no count SQL of its own.
import {audit, queue} from './core.mjs';
import {assertCapacity, eventInventory, normalizeSpace, vendorIdentityKey} from './counts.mjs';
import {decisionEmail} from './notifications.mjs';

export const OFFER_WINDOW_HOURS = 12;

const dateOnly = d => d instanceof Date ? d.toISOString().slice(0, 10) : (String(d ?? '').match(/\d{4}-\d{2}-\d{2}/)?.[0] || '');
const fmtDate = d => { const ymd = dateOnly(d), x = ymd ? new Date(ymd + 'T12:00:00Z') : new Date(NaN); return Number.isNaN(x.getTime()) ? 'Market date' : x.toLocaleDateString('en-US', {weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: 'America/New_York'}); };
export const offerDeadlineText = expires => new Intl.DateTimeFormat('en-US', {weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York'}).format(new Date(expires));

export async function ensureWaitlistSchema(sql) {
  await sql`alter table market.bookings add column if not exists waitlisted_at timestamptz`;
  await sql`create table if not exists market.waitlist_offers(
    id uuid primary key default gen_random_uuid(),
    booking_id uuid not null references market.bookings(id),
    event_id uuid not null references market.events(id),
    offered_at timestamptz not null default now(),
    expires_at timestamptz not null,
    state text not null default 'offered' check (state in ('offered','accepted','declined','expired','superseded')),
    offered_by text not null default 'auto' check (offered_by in ('auto','organizer')),
    override boolean not null default false,
    created_at timestamptz not null default now())`;
}

async function eventRow(tx, eventId) {
  const [e] = await tx`select ev.*, l.name as location, l.address from market.events ev join market.locations l on l.id = ev.location_id where ev.id = ${eventId}`;
  return e || null;
}

async function effectiveLimits(tx, eventId) {
  const rows = await tx`select c.id, coalesce(l.vendor_limit, c.vendor_limit) as lim from market.categories c left join market.event_category_limits l on l.event_id = ${eventId} and l.category_id = c.id`;
  return new Map(rows.map(r => [r.id, r.lim]));
}

function offerEmail(booking, event, expires) {
  const day = fmtDate(event.date);
  const spaceLabel = booking.space === 'indoor' ? 'Indoor' : 'Outdoor';
  const deadline = offerDeadlineText(expires);
  return {
    subject: `A spot opened up — Trinity Crafters Market, ${day}`,
    body: `Hi ${booking.name},\n\nA ${spaceLabel} spot just opened for the Trinity Crafters Market on ${day} at ${event.location} (${event.address}). The space is $${(booking.price / 100).toFixed(2)}.\n\nYou have until ${deadline} Eastern to accept — 12 hours from this email. To accept, sign in, open My Bookings, and tap Accept. You'll be approved right away and sent your invoice to hold the spot.\n\nIf you decline (Decline button in My Bookings), you move to the back of the waitlist for this date. If the 12 hours run out, the spot goes to the next vendor in line — you keep your current place on the waitlist for any future opening on this date.\n\nTrinity Crafters Market\ntrinitycraftersmarket@gmail.com`
  };
}

async function makeOffer(tx, booking, event, {offeredBy = 'auto', override = false, actor = 'system'} = {}) {
  const expires = new Date(Date.now() + OFFER_WINDOW_HOURS * 3600 * 1000);
  await tx`update market.bookings set waitlist_offered_at = now() where id = ${booking.id}`;
  const [offer] = await tx`insert into market.waitlist_offers(booking_id, event_id, expires_at, offered_by, override) values(${booking.id}, ${event.id}, ${expires}, ${offeredBy}, ${override}) returning *`;
  const mail = offerEmail(booking, event, expires);
  await queue(tx, booking.email, mail.subject, mail.body);
  if (offeredBy === 'auto') await audit(tx, actor, 'waitlist offer sent', {booking_id: booking.id, vendor: booking.business || booking.name, email: booking.email, event_id: event.id, event: dateOnly(event.date), space: booking.space, expires_at: expires.toISOString()});
  return offer;
}

// Opening-episode watermark: when a spot's free count returns to zero the
// episode closes (watermark = now), so expired/declined offers from before
// that moment no longer exclude a vendor from a genuinely new opening.
const episodeKey = (eventId, space) => `waitlist_episode:${eventId}:${space}`;
async function getEpisode(tx, eventId, space) {
  const [r] = await tx`select value from market.settings where key = ${episodeKey(eventId, space)}`;
  return r ? new Date(r.value) : null;
}
async function setEpisode(tx, eventId, space, when) {
  await tx`insert into market.settings(key, value) values(${episodeKey(eventId, space)}, ${when.toISOString()}) on conflict(key) do update set value = excluded.value`;
}

// Scan one event (optionally one space type) and offer every open spot.
// Caller owns the transaction + advisory lock. Returns offers created.
export async function scanWaitlist(tx, eventId, {space = null, actor = 'system'} = {}) {
  await ensureWaitlistSchema(tx);
  const event = await eventRow(tx, eventId);
  if (!event || !event.open || event.sold_out) return [];
  const inv = await eventInventory(tx, eventId);
  const limits = await effectiveLimits(tx, eventId);
  const created = [];
  const spaces = space ? [normalizeSpace(space)] : ['indoor', 'outdoor'];
  for (const sp of spaces) {
    if (!sp) continue;
    if (sp === 'indoor' && !event.indoor_open) continue;
    if (sp === 'outdoor' && !event.outdoor_open) continue;
    const capacity = sp === 'indoor' ? event.indoor_capacity : event.outdoor_capacity;
    const free = capacity - (sp === 'indoor' ? inv.indoor : inv.outdoor);
    if (free <= 0) { await setEpisode(tx, eventId, sp, new Date()); continue; }
    const live = await tx`select o.id, o.booking_id, a.category_id from market.waitlist_offers o join market.bookings b on b.id = o.booking_id join market.applications a on a.id = b.application_id where o.event_id = ${eventId} and b.space = ${sp} and b.status = 'waitlist' and o.state = 'offered' and o.expires_at > now()`;
    let offeredCount = live.length;
    if (offeredCount >= free) continue;
    let episode = await getEpisode(tx, eventId, sp);
    if (!episode) { episode = new Date(); await setEpisode(tx, eventId, sp, episode); }
    const excludedRows = await tx`select distinct booking_id from market.waitlist_offers where event_id = ${eventId} and state in ('expired','declined') and created_at >= ${episode.toISOString()}`;
    const excluded = new Set(excludedRows.map(r => r.booking_id));
    const liveIds = new Set(live.map(r => r.booking_id));
    // Live offers reserve category headroom so two spots in a nearly-full
    // category are not both offered past the limit.
    const catUsed = new Map(inv.categories);
    for (const r of live) if (r.category_id) catUsed.set(r.category_id, (catUsed.get(r.category_id) || 0) + 1);
    const queueRows = await tx`select b.id, b.space, b.price, b.category_exception, a.name, a.email, a.business, a.category_id, a.vendor_id, a.phone from market.bookings b join market.applications a on a.id = b.application_id where b.event_id = ${eventId} and b.space = ${sp} and b.status = 'waitlist' and not exists(select 1 from market.bans bn where bn.active and (bn.user_id = a.user_id or lower(bn.email) = lower(a.email))) order by b.waitlisted_at asc nulls last, b.id asc`;
    for (const b of queueRows) {
      if (offeredCount >= free) break;
      if (liveIds.has(b.id) || excluded.has(b.id)) continue;
      const key = vendorIdentityKey({vendor_id: b.vendor_id, email: b.email, phone: b.phone, business: b.business, name: b.name});
      if (inv.vendors.some(v => v.key === key)) continue; // already attending this date via another record
      if (b.category_id && !b.category_exception) {
        const lim = limits.get(b.category_id);
        if (lim != null && (catUsed.get(b.category_id) || 0) >= lim) continue; // category full — SKIPPED, keeps position
      }
      const offer = await makeOffer(tx, {...b, space: sp}, event, {actor});
      created.push(offer);
      offeredCount++;
      if (b.category_id) catUsed.set(b.category_id, (catUsed.get(b.category_id) || 0) + 1);
    }
  }
  return created;
}

// Expire stale offers and immediately re-scan each affected spot so the offer
// passes to the next vendor. Caller owns the transaction + advisory lock.
export async function sweepWaitlist(tx, actor = 'system') {
  await ensureWaitlistSchema(tx);
  const stale = await tx`select o.id, o.booking_id, o.event_id, b.space from market.waitlist_offers o join market.bookings b on b.id = o.booking_id where o.state = 'offered' and o.expires_at <= now()`;
  for (const o of stale) {
    await tx`update market.waitlist_offers set state = 'expired' where id = ${o.id}`;
    await tx`update market.bookings set waitlist_offered_at = null where id = ${o.booking_id} and status = 'waitlist'`;
    await audit(tx, actor, 'waitlist offer expired', {booking_id: o.booking_id, event_id: o.event_id, space: o.space});
  }
  const spots = [...new Map(stale.map(o => [o.event_id + ':' + o.space, o])).values()];
  let created = [];
  for (const s of spots) created = created.concat(await scanWaitlist(tx, s.event_id, {space: s.space, actor}));
  return {expired: stale.length, created: created.length};
}

// Backstop: scan every future open event that has anyone waitlisted.
export async function scanAllFutureWaitlists(tx, actor = 'system') {
  await ensureWaitlistSchema(tx);
  const events = await tx`select distinct ev.id from market.events ev join market.bookings b on b.event_id = ev.id and b.status = 'waitlist' where ev.open and (ev.date + coalesce(ev.end_time, time '15:00') + interval '1 minute') > (now() at time zone 'America/New_York')`;
  let created = 0;
  for (const e of events) created += (await scanWaitlist(tx, e.id, {actor})).length;
  return created;
}

// Resolve any live offer rows when a booking leaves the waitlist through an
// organizer-driven transition (api.mjs booking action).
export async function resolveOffers(tx, bookingId, outcome) {
  await ensureWaitlistSchema(tx);
  await tx`update market.waitlist_offers set state = ${outcome} where booking_id = ${bookingId} and state = 'offered'`;
}

async function loadWaitlistBooking(tx, bookingId) {
  const [b] = await tx`select b.*, a.name, a.email, a.business, a.phone, a.category_id, a.user_id, a.vendor_id, c.name as category from market.bookings b join market.applications a on a.id = b.application_id left join market.categories c on c.id = a.category_id where b.id = ${bookingId}`;
  return b || null;
}

function assertOwner(b, user) {
  if (!b) throw Error('That booking could not be found.');
  const email = String(user.email || '').trim().toLowerCase();
  if (b.user_id !== user.id && String(b.email || '').trim().toLowerCase() !== email) throw Error('That booking is not yours.');
}

async function liveOffer(tx, bookingId) {
  const [o] = await tx`select * from market.waitlist_offers where booking_id = ${bookingId} and state = 'offered' order by created_at desc limit 1`;
  return o || null;
}

// Vendor accepts an offer: waitlist -> approved, re-running the capacity /
// category checks (counts.mjs). Returns {booking, event} so the caller can
// run the normal invoice flow after commit.
export async function acceptOffer(tx, bookingId, user) {
  await ensureWaitlistSchema(tx);
  const b = await loadWaitlistBooking(tx, bookingId);
  assertOwner(b, user);
  if (b.status !== 'waitlist') throw Error('This booking is no longer on the waitlist.');
  const offer = await liveOffer(tx, bookingId);
  if (!offer || !b.waitlist_offered_at) throw Error('You do not have an open waitlist offer for this date.');
  if (new Date(offer.expires_at) <= new Date()) throw Error('This offer has expired. You keep your place on the waitlist for the next opening.');
  const event = await eventRow(tx, b.event_id);
  const limits = await effectiveLimits(tx, b.event_id);
  await assertCapacity(tx, event, {space: b.space, categoryId: b.category_id, limit: b.category_id ? limits.get(b.category_id) : null, exception: b.category_exception});
  await tx`update market.bookings set status = 'approved', waitlist_offered_at = null, decision_reason = '' where id = ${b.id}`;
  await tx`update market.waitlist_offers set state = 'accepted' where id = ${offer.id}`;
  const approved = {...b, status: 'approved'};
  const mail = decisionEmail(approved, event);
  await queue(tx, b.email, mail.subject, mail.body);
  await queue(tx, b.email, `Online Check-in for ${fmtDate(event.date)} — Trinity Crafters Market`, `Hi ${b.name},\n\nYour market date is coming up. Please complete online check-in before the market so we have your planned setup arrival time.\n\nUse the Vendor Setup / Check-In button in My Bookings for ${fmtDate(event.date)} at ${event.location}.\n\nThank you,\nTrinity Crafters Market\ntrinitycraftersmarket@gmail.com`);
  await audit(tx, user, 'waitlist offer accepted', {booking_id: b.id, vendor: b.business || b.name, email: b.email, event_id: b.event_id, event: dateOnly(event.date), space: b.space});
  return {booking: approved, event};
}

// Vendor declines an offer: back of the queue for that date, then the spot is
// re-scanned for the next vendor.
export async function declineOffer(tx, bookingId, user) {
  await ensureWaitlistSchema(tx);
  const b = await loadWaitlistBooking(tx, bookingId);
  assertOwner(b, user);
  if (b.status !== 'waitlist') throw Error('This booking is no longer on the waitlist.');
  const offer = await liveOffer(tx, bookingId);
  if (!offer || !b.waitlist_offered_at) throw Error('You do not have an open waitlist offer for this date.');
  await tx`update market.waitlist_offers set state = 'declined' where id = ${offer.id}`;
  await tx`update market.bookings set waitlist_offered_at = null, waitlisted_at = now() where id = ${b.id}`;
  const event = await eventRow(tx, b.event_id);
  await audit(tx, user, 'waitlist offer declined', {booking_id: b.id, vendor: b.business || b.name, email: b.email, event_id: b.event_id, event: dateOnly(event?.date), space: b.space});
  await scanWaitlist(tx, b.event_id, {space: b.space, actor: user});
  return {booking: b};
}

// Organizer override (§12.5): offer a spot to a specific waitlisted vendor,
// bypassing the category skip and queue order. Still requires a real free
// spot of that space type; supersedes a live offer when the spot's offers are
// spoken for. Writes the 'waitlist offer override' audit entry.
export async function offerAnyway(tx, bookingId, actor) {
  await ensureWaitlistSchema(tx);
  const b = await loadWaitlistBooking(tx, bookingId);
  if (!b) throw Error('That booking could not be found.');
  if (b.status !== 'waitlist') throw Error('That vendor is not on the waitlist for this date.');
  const event = await eventRow(tx, b.event_id);
  const inv = await eventInventory(tx, b.event_id);
  const used = b.space === 'indoor' ? inv.indoor : inv.outdoor;
  const capacity = b.space === 'indoor' ? event.indoor_capacity : event.outdoor_capacity;
  const free = capacity - used;
  if (free <= 0) throw Error(`There is no open ${b.space} spot for that date.`);
  const live = await tx`select o.id, o.booking_id from market.waitlist_offers o join market.bookings bk on bk.id = o.booking_id where o.event_id = ${b.event_id} and bk.space = ${b.space} and bk.status = 'waitlist' and o.state = 'offered' and o.expires_at > now() order by o.created_at desc`;
  if (live.length >= free) {
    const victim = live[0];
    await tx`update market.waitlist_offers set state = 'superseded' where id = ${victim.id}`;
    await tx`update market.bookings set waitlist_offered_at = null where id = ${victim.booking_id}`;
  }
  if (b.waitlist_offered_at) { // re-offering to the same vendor: retire the old row first
    await tx`update market.waitlist_offers set state = 'superseded' where booking_id = ${b.id} and state = 'offered'`;
  }
  const limits = await effectiveLimits(tx, b.event_id);
  const catUsedNow = b.category_id ? (inv.categories.get(String(b.category_id)) || 0) : 0;
  const catLimit = b.category_id ? limits.get(b.category_id) : null;
  const offer = await makeOffer(tx, b, event, {offeredBy: 'organizer', override: true, actor});
  await audit(tx, actor, 'waitlist offer override', {booking_id: b.id, vendor: b.business || b.name, email: b.email, event_id: b.event_id, event: dateOnly(event.date), category: b.category || null, category_used: catUsedNow, category_limit: catLimit ?? null, space: b.space});
  return offer;
}
