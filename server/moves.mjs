// Vendor date-move requests (AUDIT.md §9; owner decisions §13.3 managers may
// approve via the `moves:approve` permission, §13.4 48-hour cutoff locked).
//
// A vendor requests a move off a confirmed booking; nothing changes until an
// organizer approves. Approval re-runs EVERY pre-check inside the caller's
// advisory-locked transaction before touching the booking: if the target
// filled meanwhile, approval refuses with the specific reason and the request
// stays pending. All capacity / category / duplicate math goes through
// server/counts.mjs — this module writes no count SQL of its own.
import {audit, queue} from './core.mjs';
import {eventInventory, normalizeSpace, vendorIdentityKey} from './counts.mjs';
import {scanWaitlist} from './waitlist.mjs';

export const MOVE_CUTOFF_HOURS = 48;
const ORGANIZER_EMAIL = 'trinitycraftersmarket@gmail.com';

const dateOnly = d => d instanceof Date ? d.toISOString().slice(0, 10) : (String(d ?? '').match(/\d{4}-\d{2}-\d{2}/)?.[0] || '');
const fmtDate = d => { const ymd = dateOnly(d), x = ymd ? new Date(ymd + 'T12:00:00Z') : new Date(NaN); return Number.isNaN(x.getTime()) ? 'Market date' : x.toLocaleDateString('en-US', {weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: 'America/New_York'}); };
const money = cents => '$' + (Number(cents || 0) / 100).toFixed(2);
const emailKey = e => String(e || '').trim().toLowerCase().replace(/,+$/, '');
const spaceLabel = s => s === 'indoor' ? 'Indoor' : 'Outdoor';

export async function ensureMoveSchema(sql) {
  await sql`create table if not exists market.move_requests(
    id uuid primary key default gen_random_uuid(),
    source_type text not null check (source_type in ('booking','imported')),
    source_id uuid not null,
    vendor_email text not null,
    from_event_id uuid not null references market.events(id),
    to_event_id uuid not null references market.events(id),
    space text not null check (space in ('indoor','outdoor')),
    reason text not null default '',
    status text not null default 'pending' check (status in ('pending','approved','declined','cancelled')),
    requested_at timestamptz not null default now(),
    decided_at timestamptz,
    decided_by text,
    decision_note text not null default '')`;
  await sql`create unique index if not exists move_requests_one_pending_idx on market.move_requests(source_type, source_id) where status = 'pending'`;
  await sql`create index if not exists move_requests_status_idx on market.move_requests(status, requested_at)`;
}

async function eventRow(tx, eventId) {
  const [e] = await tx`select ev.*, l.name as location, l.address,
    ((ev.date + coalesce(ev.end_time, time '15:00') + interval '1 minute') <= (now() at time zone 'America/New_York')) as ended,
    ((ev.date + coalesce(ev.start_time, time '10:00')) <= ((now() at time zone 'America/New_York') + interval '48 hours')) as within_cutoff
    from market.events ev join market.locations l on l.id = ev.location_id where ev.id = ${eventId}`;
  return e || null;
}

// Normalized source record for a booking or an imported attendee.
export async function loadMoveSource(tx, sourceType, sourceId) {
  if (sourceType === 'booking') {
    const [r] = await tx`select b.id as source_id, b.event_id, b.space, b.status, b.price,
      a.id as application_id, a.user_id, a.name, a.email, a.business, a.phone, a.category_id, a.vendor_id, a.monthly_billing_active,
      c.name as category,
      coalesce((select sum(p.amount) from market.vendor_payments p where p.booking_id = b.id), 0) as amount_paid
      from market.bookings b join market.applications a on a.id = b.application_id
      left join market.categories c on c.id = a.category_id where b.id = ${sourceId}`;
    if (!r) return null;
    return {...r, source_type: 'booking', space: normalizeSpace(r.space), amount_due: r.price, monthly: !!r.monthly_billing_active, confirmed: ['approved', 'paid'].includes(r.status)};
  }
  const [r] = await tx`select i.*, c.name as category from market.imported_attendees i left join market.categories c on c.id = i.category_id where i.id = ${sourceId}`;
  if (!r) return null;
  const status = r.cancelled ? 'cancelled' : (r.payment_status || 'paid');
  return {source_id: r.id, source_type: 'imported', event_id: r.event_id, space: normalizeSpace(r.space), status,
    application_id: null, user_id: null, name: r.name, email: r.email, business: r.business, phone: r.phone,
    category_id: r.category_id, category: r.category, vendor_id: null,
    amount_due: r.invoice_amount || 0, amount_paid: ['paid', 'monthly'].includes(r.payment_status) ? (r.invoice_amount || 0) : 0,
    monthly: r.payment_status === 'monthly' || r.payment_method === 'monthly billing', confirmed: !r.cancelled};
}

function assertOwnership(source, user) {
  if (!source) throw Error('That booking could not be found.');
  if (source.source_type === 'booking') { if (source.user_id !== user.id) throw Error('That booking is not yours.'); }
  else if (emailKey(source.email) !== emailKey(user.email)) throw Error('That booking is not yours.');
}

// Every reason `target` cannot accept `source` right now (§9.3 pre-checks).
// Empty array = eligible. Used by the date picker, create, and approval.
export async function targetProblems(tx, source, target) {
  const problems = [];
  if (!target) return ['That market date could not be found.'];
  if (target.id === source.event_id) problems.push('That is the date this booking is already on.');
  if (target.ended) problems.push('That date has already ended.');
  if (!target.open) problems.push('That date is not open for booking.');
  if (target.sold_out) problems.push('That date is marked sold out.');
  if (source.space === 'indoor' && !target.indoor_open) problems.push('Indoor booths are closed for that date.');
  if (source.space === 'outdoor' && !target.outdoor_open) problems.push('Outdoor booths are closed for that date.');
  if (problems.length) return problems;
  const inv = await eventInventory(tx, target.id);
  const key = vendorIdentityKey({vendor_id: source.vendor_id, email: source.email, phone: source.phone, business: source.business, name: source.name});
  if (inv.vendors.some(v => v.key === key)) problems.push('You already have a spot on that date.');
  const email = emailKey(source.email);
  if (!problems.length && email) {
    const [pend] = await tx`select b.id from market.bookings b join market.applications a on a.id = b.application_id where b.event_id = ${target.id} and lower(a.email) = ${email} and b.status in ('pending','waitlist') limit 1`;
    if (pend) problems.push('You already have an application or waitlist spot for that date.');
    const [imp] = await tx`select id from market.imported_attendees where event_id = ${target.id} and lower(trim(both ' ,' from email)) = ${email} and not cancelled limit 1`;
    if (imp) problems.push('You already have a spot on that date.');
  }
  if (source.application_id) {
    const [sameApp] = await tx`select id from market.bookings where application_id = ${source.application_id} and event_id = ${target.id} limit 1`;
    if (sameApp && !problems.length) problems.push('You already have a booking record for that date.');
  }
  if (problems.length) return problems;
  const used = source.space === 'indoor' ? inv.indoor : inv.outdoor;
  const capacity = source.space === 'indoor' ? target.indoor_capacity : target.outdoor_capacity;
  if (used >= capacity) problems.push(`${spaceLabel(source.space)} is full for that date.`);
  if (source.category_id) {
    const [lim] = await tx`select coalesce(l.vendor_limit, c.vendor_limit) as lim from market.categories c left join market.event_category_limits l on l.event_id = ${target.id} and l.category_id = c.id where c.id = ${source.category_id}`;
    if (lim && lim.lim != null && Number(lim.lim) > 0 && (inv.categories.get(String(source.category_id)) || 0) >= Number(lim.lim)) problems.push('Your category is full for that date.');
  }
  return problems;
}

// Dates the vendor could pick, plus the dates that fail pre-checks (with
// reasons) so the dialog can say why a date is missing.
export async function eligibleTargets(tx, source) {
  const rows = await tx`select ev.id from market.events ev where ev.open and ev.id <> ${source.event_id}
    and (ev.date + coalesce(ev.end_time, time '15:00') + interval '1 minute') > (now() at time zone 'America/New_York') order by ev.date`;
  const eligible = [], excluded = [];
  for (const r of rows) {
    const target = await eventRow(tx, r.id);
    const problems = await targetProblems(tx, source, target);
    (problems.length ? excluded : eligible).push(problems.length ? {event: target, problems} : target);
  }
  return {eligible, excluded};
}

export async function createMoveRequest(tx, {source, targetEventId, reason = '', user}) {
  await ensureMoveSchema(tx);
  assertOwnership(source, user);
  if (!source.confirmed) throw Error('Only confirmed bookings can request a date move. Held, pending, waitlist, and cancelled bookings are not eligible.');
  const from = await eventRow(tx, source.event_id);
  if (!from || from.ended) throw Error('That market has already ended.');
  if (from.within_cutoff) throw Error(`This market starts within ${MOVE_CUTOFF_HOURS} hours, so date moves are closed for it. Please contact the organizer if this is urgent.`);
  const [pending] = await tx`select id from market.move_requests where source_type = ${source.source_type} and source_id = ${source.source_id} and status = 'pending' limit 1`;
  if (pending) throw Error('You already have a pending move request for this booking.');
  const target = await eventRow(tx, targetEventId);
  const problems = await targetProblems(tx, source, target);
  if (problems.length) throw Error(problems[0]);
  let request;
  try {
    [request] = await tx`insert into market.move_requests(source_type, source_id, vendor_email, from_event_id, to_event_id, space, reason)
      values(${source.source_type}, ${source.source_id}, ${source.email}, ${source.event_id}, ${target.id}, ${source.space}, ${String(reason || '').slice(0, 500)}) returning *`;
  } catch (e) {
    if (e && e.code === '23505') throw Error('You already have a pending move request for this booking.');
    throw e;
  }
  await queue(tx, source.email, `We received your date-move request — Trinity Crafters Market`,
    `Hi ${source.name},\n\nWe received your request to move your ${spaceLabel(source.space)} booking from ${fmtDate(from.date)} to ${fmtDate(target.date)}.\n\nNothing has changed yet: your booking stays on ${fmtDate(from.date)} unless the move is approved. We'll email you the decision.\n\nTrinity Crafters Market\n${ORGANIZER_EMAIL}`);
  await queue(tx, ORGANIZER_EMAIL, `New date-move request — ${source.business || source.name}`,
    `A vendor requested a date move.\n\nVendor: ${source.name} (${source.email})\nBusiness: ${source.business || ''}\nCategory: ${source.category || ''}\nSpace: ${spaceLabel(source.space)}\nFrom: ${fmtDate(from.date)} — ${from.location}\nTo: ${fmtDate(target.date)} — ${target.location}\nReason: ${request.reason || '(none given)'}\n\nReview it in Organizer → Move Requests. The booking does not change unless you approve.`);
  await audit(tx, user, 'move requested', {request_id: request.id, source_type: source.source_type, source_id: source.source_id, vendor: source.business || source.name, email: source.email, from_event: source.event_id, to_event: target.id, from: dateOnly(from.date), to: dateOnly(target.date)});
  return {request, from, to: target};
}

async function clearFloorAssignments(tx, eventId, recordId) {
  const areas = await tx`select event_id, area_key, assignments from market.floor_plan_areas where event_id = ${eventId}`;
  for (const area of areas) {
    const entries = Object.entries(area.assignments || {});
    const kept = entries.filter(([, v]) => String(v?.vendor_id || '') !== String(recordId));
    if (kept.length !== entries.length) {
      const next = Object.fromEntries(kept);
      await tx`update market.floor_plan_areas set assignments = ${JSON.stringify(next)}::jsonb, updated_at = now() where event_id = ${area.event_id} and area_key = ${area.area_key}`;
    }
  }
}

// The transfer itself, shared by approval and organizer-initiated moves:
// point the record at the target event, clear the old date's check-in /
// attendance state, re-seat the imported category reservation, and drop the
// old date's floor-plan pin (the vendor gets a fresh assignment). Payment
// fields are never touched. `space` is the (normalized) space the vendor
// will occupy on the target date; the stored space is only rewritten when
// it actually changes (bookings store 'indoor'/'outdoor'; imported rows
// store 'Inside'/'Outside', matching server/twins.mjs).
async function performTransfer(tx, {source, target, space}) {
  if (source.source_type === 'booking') {
    await tx`update market.bookings set event_id = ${target.id}, setup_checkin_at = null, setup_arrival_time = null, checked_in = false, no_show = false where id = ${source.source_id}`;
    if (space !== source.space) await tx`update market.bookings set space = ${space} where id = ${source.source_id}`;
  } else {
    await tx`update market.imported_attendees set event_id = ${target.id}, setup_checkin_at = null, setup_arrival_time = null, attendance_state = 'not_marked' where id = ${source.source_id}`;
    if (space !== source.space) await tx`update market.imported_attendees set space = ${space === 'indoor' ? 'Inside' : 'Outside'} where id = ${source.source_id}`;
    await tx`delete from market.imported_category_reservations where imported_attendee_id = ${source.source_id}`;
    if (source.category_id) await tx`insert into market.imported_category_reservations(imported_attendee_id, event_id, category_id, space) values(${source.source_id}, ${target.id}, ${source.category_id}, ${space}) on conflict(imported_attendee_id, category_id) do nothing`;
  }
  await clearFloorAssignments(tx, source.event_id, source.source_id);
}

// Approve: re-run ALL checks; on any failure throw (the caller's transaction
// rolls back, the request stays pending, and the organizer sees the reason).
export async function approveMoveRequest(tx, {requestId, actor, overrideCutoff = false}) {
  await ensureMoveSchema(tx);
  const [req] = await tx`select * from market.move_requests where id = ${requestId} for update`;
  if (!req) throw Error('That move request could not be found.');
  if (req.status !== 'pending') throw Error('That request has already been decided.');
  const source = await loadMoveSource(tx, req.source_type, req.source_id);
  if (!source) throw Error('The original booking no longer exists. You can decline this request to close it out.');
  if (source.event_id !== req.from_event_id) throw Error('The booking is no longer on the original date — it may already have been moved.');
  if (!source.confirmed) throw Error(`The booking is no longer confirmed (status: ${source.status}), so it cannot be moved.`);
  const from = await eventRow(tx, req.from_event_id);
  const target = await eventRow(tx, req.to_event_id);
  if (from && from.within_cutoff && !overrideCutoff) throw Error(`This market starts within ${MOVE_CUTOFF_HOURS} hours. Approving moves a vendor off a market that is about to run — retry with the cutoff override if you mean to do it.`);
  const problems = await targetProblems(tx, source, target);
  if (problems.length) throw Error(`Cannot approve: ${problems[0]} The request stays pending.`);
  // All checks passed — perform the move. Payment fields are never touched.
  await performTransfer(tx, {source, target, space: req.space});
  const [updated] = await tx`update market.move_requests set status = 'approved', decided_at = now(), decided_by = ${actor.email || String(actor)} where id = ${req.id} returning *`;
  await audit(tx, actor, 'booking date moved (requested)', {request_id: req.id, source_type: source.source_type, source_id: source.source_id, vendor: source.business || source.name, email: source.email, from_event: req.from_event_id, to_event: target.id, from: dateOnly(from?.date), to: dateOnly(target.date)});
  await queue(tx, source.email, `Date changed — you're now booked for ${fmtDate(target.date)}`,
    `Hi ${source.name},\n\nGood news — your date-move request was approved.\n\nYour booking moved from ${fmtDate(from?.date)} to:\n\n${fmtDate(target.date)}\n10 AM–3 PM Eastern\n${target.location}\n${target.address}\n${spaceLabel(source.space)} space — ${money(source.amount_due)}\n\nYour payment stays on the booking — there is nothing more to pay for the date change. Your old date's check-in and booth assignment were cleared; you'll get a fresh booth assignment for the new date.\n\nWe operate rain or shine. Please don't pack up before 3 PM, and please advertise the market on Facebook.\n\nTrinity Crafters Market\n${ORGANIZER_EMAIL}`);
  // The vacated old-date spot may open a waitlist offer.
  await scanWaitlist(tx, req.from_event_id, {space: source.space, actor});
  return {request: updated, source, from, to: target};
}

export async function declineMoveRequest(tx, {requestId, actor, note = ''}) {
  await ensureMoveSchema(tx);
  const [req] = await tx`select * from market.move_requests where id = ${requestId} for update`;
  if (!req) throw Error('That move request could not be found.');
  if (req.status !== 'pending') throw Error('That request has already been decided.');
  const source = await loadMoveSource(tx, req.source_type, req.source_id);
  const from = await eventRow(tx, req.from_event_id);
  const target = await eventRow(tx, req.to_event_id);
  const cleanNote = String(note || '').slice(0, 500);
  const [updated] = await tx`update market.move_requests set status = 'declined', decided_at = now(), decided_by = ${actor.email || String(actor)}, decision_note = ${cleanNote} where id = ${req.id} returning *`;
  await audit(tx, actor, 'move request declined', {request_id: req.id, source_type: source.source_type, source_id: source.source_id, vendor: source?.business || source?.name || req.vendor_email, email: req.vendor_email, from: dateOnly(from?.date), to: dateOnly(target?.date), note: cleanNote});
  if (source) await queue(tx, source.email, `About your date-move request — Trinity Crafters Market`,
    `Hi ${source.name},\n\nWe couldn't approve your request to move from ${fmtDate(from?.date)} to ${fmtDate(target?.date)}.\n\nYour booking is unchanged — you are still booked for ${fmtDate(from?.date)}.${cleanNote ? `\n\nOrganizer note: ${cleanNote}` : ''}\n\nIf you still need a different date, reply to this email and we'll help.\n\nTrinity Crafters Market\n${ORGANIZER_EMAIL}`);
  return {request: updated, source, from, to: target};
}

export async function cancelMoveRequest(tx, {requestId, user}) {
  await ensureMoveSchema(tx);
  const [req] = await tx`select * from market.move_requests where id = ${requestId} for update`;
  if (!req) throw Error('That move request could not be found.');
  const source = await loadMoveSource(tx, req.source_type, req.source_id);
  assertOwnership(source, user);
  if (req.status !== 'pending') throw Error('That request has already been decided.');
  const [updated] = await tx`update market.move_requests set status = 'cancelled', decided_at = now() where id = ${req.id} returning *`;
  await audit(tx, user, 'move request cancelled', {request_id: req.id, source_type: source.source_type, source_id: source.source_id, email: req.vendor_email});
  return {request: updated};
}

// ---- Organizer-initiated moves -------------------------------------------
// The organizer moves a booking directly (no vendor request needed): the
// organizer IS the approver, so there is no 48-hour cutoff, but every other
// approval pre-check still runs — capacity/category truth is not overridden,
// and a target that genuinely cannot take the booking refuses with the
// specific reason (the same strings targetProblems produces for approvals).

// Sources on `eventId` the organizer could move right now — confirmed
// records only, mirroring loadMoveSource's `confirmed` (bookings:
// approved/paid; imported: not cancelled) and the vendor-side rule that the
// current date must be upcoming. Drives the attendee-card button: booking
// status is not rendered anywhere on the card, so visibility comes from
// this server set, matched by id on the client.
export async function movableSources(sql, eventId) {
  const [e] = await sql`select ((date + coalesce(end_time, time '15:00') + interval '1 minute') <= (now() at time zone 'America/New_York')) as ended from market.events where id = ${eventId}`;
  if (!e || e.ended) return [];
  const bookings = await sql`select id from market.bookings where event_id = ${eventId} and status in ('approved', 'paid')`;
  const imported = await sql`select id from market.imported_attendees where event_id = ${eventId} and not cancelled`;
  return [...bookings.map(b => ({source_type: 'booking', source_id: b.id})), ...imported.map(i => ({source_type: 'imported', source_id: i.id}))];
}

// Target dates for the organizer dialog: every other open, unended date,
// evaluated for BOTH spaces via targetProblems, so the organizer can also
// switch the vendor's space when the target has room the other way.
// Returns targets (dates with at least one workable space, each listing the
// spaces that fit) and excluded dates (with the first blocking reason).
export async function organizerMoveTargets(tx, source) {
  const ordered = await tx`select ev.id from market.events ev where ev.open and ev.id <> ${source.event_id}
    and (ev.date + coalesce(ev.end_time, time '15:00') + interval '1 minute') > (now() at time zone 'America/New_York') order by ev.date`;
  const orderOf = new Map(ordered.map((r, i) => [String(r.id), i]));
  const perSpace = {};
  for (const space of ['indoor', 'outdoor']) perSpace[space] = await eligibleTargets(tx, {...source, space});
  const byId = new Map();
  for (const space of ['indoor', 'outdoor']) {
    for (const e of perSpace[space].eligible) {
      if (!byId.has(e.id)) byId.set(e.id, {event: e, spaces: []});
      byId.get(e.id).spaces.push({space, price: e[space + '_price']});
    }
    for (const x of perSpace[space].excluded) {
      if (!byId.has(x.event.id)) byId.set(x.event.id, {event: x.event, spaces: [], problems: x.problems});
      else if (!byId.get(x.event.id).problems) byId.get(x.event.id).problems = x.problems;
    }
  }
  const targets = [], excluded = [];
  for (const entry of byId.values()) (entry.spaces.length ? targets : excluded).push(entry.spaces.length ? {event: entry.event, spaces: entry.spaces} : {event: entry.event, problems: entry.problems || ['Not available.']});
  const byDate = (a, b) => (orderOf.get(String(a.event.id)) ?? 0) - (orderOf.get(String(b.event.id)) ?? 0);
  return {targets: targets.sort(byDate), excluded: excluded.sort(byDate)};
}

// Perform an organizer-initiated move immediately. Refusals reuse the
// approval path's checks and wording; on success the transfer is the shared
// performTransfer, the vendor is emailed the new date, the vacated spot is
// offered to the waitlist, and a pending vendor request for the same
// booking (if any) is resolved as approved — the booking did move.
export async function organizerMove(tx, {sourceType, sourceId, targetEventId, space = null, actor}) {
  await ensureMoveSchema(tx);
  const source = await loadMoveSource(tx, sourceType, sourceId);
  if (!source) throw Error('That booking could not be found.');
  if (!source.confirmed) throw Error(`The booking is not confirmed (status: ${source.status}), so it cannot be moved.`);
  const from = await eventRow(tx, source.event_id);
  if (!from) throw Error('The current market date could not be found.');
  if (from.ended) throw Error('That market has already ended.');
  const target = await eventRow(tx, targetEventId);
  const effSpace = space == null || space === '' ? source.space : normalizeSpace(space);
  if (!effSpace) throw Error('Choose an indoor or outdoor space.');
  const problems = await targetProblems(tx, effSpace === source.space ? source : {...source, space: effSpace}, target);
  if (problems.length) throw Error(`Cannot move: ${problems[0]}`);
  const [pending] = await tx`select * from market.move_requests where source_type = ${source.source_type} and source_id = ${source.source_id} and status = 'pending' for update`;
  await performTransfer(tx, {source, target, space: effSpace});
  let resolvedRequest = null;
  if (pending) {
    const note = pending.to_event_id === target.id
      ? 'Approved — organizer moved this booking directly.'
      : `Superseded — organizer moved this booking to ${fmtDate(target.date)} directly.`;
    [resolvedRequest] = await tx`update market.move_requests set status = 'approved', decided_at = now(), decided_by = ${actor.email || String(actor)}, decision_note = ${note} where id = ${pending.id} returning *`;
  }
  await audit(tx, actor, 'booking date moved (organizer)', {organizer_initiated: true, request_id: pending?.id || null, source_type: source.source_type, source_id: source.source_id, vendor: source.business || source.name, email: source.email, from_event: source.event_id, to_event: target.id, from: dateOnly(from.date), to: dateOnly(target.date), space: effSpace});
  await queue(tx, source.email, `Date changed — you're now booked for ${fmtDate(target.date)}`,
    `Hi ${source.name},\n\nWe moved your booking to a new date.\n\nYour booking moved from ${fmtDate(from.date)} to:\n\n${fmtDate(target.date)}\n10 AM–3 PM Eastern\n${target.location}\n${target.address}\n${spaceLabel(effSpace)} space — ${money(source.amount_due)}\n\nYour payment stays on the booking — there is nothing more to pay for the date change. Your old date's check-in and booth assignment were cleared; you'll get a fresh booth assignment for the new date.\n\nWe operate rain or shine. Please don't pack up before 3 PM, and please advertise the market on Facebook.\n\nTrinity Crafters Market\n${ORGANIZER_EMAIL}`);
  // The vacated old-date spot may open a waitlist offer.
  await scanWaitlist(tx, source.event_id, {space: source.space, actor});
  return {source, from, to: target, space: effSpace, request: resolvedRequest};
}
