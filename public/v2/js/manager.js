// Manager-scoped views (Stage 3b): staff sign in to the same v2 shell
// the organizer uses, limited to the sections their permissions open —
// staffActionAllowed semantics from the server: a section the manager
// cannot use is simply not in their navigation, and fields the
// `manager` payload does not carry (prices, payment internals,
// inspection on booking rows) are not rendered at all. Everything
// renders from the manager payload; every mutation re-fetches it.
import { api, esc, nice } from './api.js?v=20261024-29';
import { managerAttendeeRows } from './data.js?v=20261024-29';
import { renderSavedFloorPlan } from './floorplan.js?v=20261024-29';

const todayStr = () => new Date().toLocaleDateString('en-CA');
export const MANAGER_SECTIONS = [
  { id: 'meventday', label: 'Event Day', sub: 'Attendance and check-in for a market', perm: 'attendees' },
  { id: 'mapplications', label: 'Applications', sub: 'Review pending and waitlisted applications', perm: 'applications' },
  { id: 'mwaitlist', label: 'Wait List', sub: 'Waitlisted vendors and spot offers', perm: 'waitlist' },
  { id: 'mattendees', label: 'Attendees', sub: 'The vendor list for a market date', perm: 'attendees' },
  { id: 'mrsvps', label: 'Shopper RSVPs', sub: 'Shopper headcount', perm: 'shopper_rsvps' },
  { id: 'mmoves', label: 'Move Requests', sub: 'Approve or decline date changes', perm: 'moves:approve' },
  { id: 'mthreads', label: 'Vendor Messages', sub: 'Application message threads', perm: 'vendor_messages' },
  { id: 'mchat', label: 'Live Chat', sub: 'Website chat conversations', perm: 'live_chat' },
  { id: 'mfloor', label: 'Floor Plans', sub: 'View the saved plans (editing is organizer-only)', perm: 'floor_plans' }
];
export const managerCan = (ctx, perm) => (ctx.state.permissions || []).includes(perm);
export const managerSections = ctx => MANAGER_SECTIONS.filter(s => managerCan(ctx, s.perm));

function nextEvent(ctx) {
  const events = (ctx.state.manager?.events || []).filter(e => String(e.date) >= todayStr());
  return events.sort((a, b) => String(a.date).localeCompare(String(b.date)))[0] || null;
}
function eventLabel(ctx, eventId) {
  const e = (ctx.state.manager?.events || []).find(x => String(x.id) === String(eventId));
  return e ? `${nice(e.date)} — ${e.location || ''}` : 'Market date';
}

export function renderManagerHome(ctx, root) {
  const m = ctx.state.manager || { events: [], applications: [], imported: [] };
  const next = nextEvent(ctx);
  const pending = m.applications.filter(a => a.status === 'pending').length;
  const waitlist = m.applications.filter(a => a.status === 'waitlist').length;
  const sections = managerSections(ctx);
  root.innerHTML = `
    <p class="eyebrow">Staff home</p>
    <h2 class="display">Market day, handled</h2>
    <p class="lede">You're signed in as staff. You see the sections your permissions open — the organizer sees everything.</p>
    ${next ? `<section class="card next-card">
      <p class="note">Next market</p>
      <h3>${esc(nice(next.date))}</h3>
      <p class="note">${esc(next.location || '')}${next.market_name ? ' · ' + esc(next.market_name) : ''}</p>
      <p class="note">${pending} application(s) awaiting review · ${waitlist} on the waitlist</p>
    </section>` : '<section class="card empty-card">No upcoming market dates.</section>'}
    <section class="card">
      <h3 class="section-title">Your sections</h3>
      <div class="sheet-menu">
        ${sections.map(s => `<button class="menu-item" data-go="${s.id}"><span><b>${esc(s.label)}</b><span>${esc(s.sub)}</span></span><span class="chev">›</span></button>`).join('') || '<p class="note">No sections are open for your account yet — ask the organizer to add permissions.</p>'}
      </div>
    </section>`;
  ctx.bindGo(root);
}

// Event Day + Attendees share one attendee list (the manager payload's
// rows): attendance for every row; the inspection editor only where the
// payload carries inspection fields (imported rows) — booking rows
// arrive without them and render without the editor, by design.
export function renderManagerEventDay(ctx, root, { attendeesMode = false } = {}) {
  const m = ctx.state.manager || { events: [] };
  const events = [...(m.events || [])].sort((a, b) => String(b.date).localeCompare(String(a.date)));
  const upcoming = events.filter(e => String(e.date) >= todayStr()).sort((a, b) => String(a.date).localeCompare(String(b.date)));
  let eventId = String((upcoming[0] || events[0])?.id || '');
  let query = '';
  root.innerHTML = `
    <p class="eyebrow">${attendeesMode ? 'Attendees' : 'Event Day'}</p>
    <h2 class="display">${attendeesMode ? 'Attendees' : 'Event Day'}</h2>
    <div class="filters" role="group" aria-label="Choose a market date">
      ${events.slice(0, 8).map(e => `<button type="button" class="chip-btn ${String(e.id) === eventId ? 'active' : ''}" data-mev="${esc(e.id)}">${esc(nice(e.date))}</button>`).join('')}
    </div>
    ${attendeesMode ? '<div class="search"><input id="v2-m-search" type="search" placeholder="Search business, name, email, or what they sell…" autocomplete="off"></div>' : ''}
    <div class="vendor-actions"><button class="btn small" id="v2-m-reminder">Send check-in reminder</button></div>
    <div id="v2-m-rows"><div class="card empty-card">Loading vendors…</div></div>
    <section class="card"><h3 class="section-title">Floor plan</h3><div id="v2-m-floor"></div></section>`;
  const rowsEl = root.querySelector('#v2-m-rows');

  function draw() {
    let rows = managerAttendeeRows(ctx.state.manager, eventId);
    if (query) {
      const q = query.toLowerCase();
      rows = rows.filter(r => [r.business, r.name, r.email, r.category, r.disclosed].some(v => String(v || '').toLowerCase().includes(q)));
    }
    const checked = rows.filter(r => r.attendance === 'checked_in').length;
    rowsEl.innerHTML = `
      <p class="note"><strong>${rows.length} vendor(s) · ${checked} checked in</strong> — ${esc(eventLabel(ctx, eventId))}</p>
      <div class="vendor-list">${rows.map(r => `
        <article class="card vendor">
          <div class="vendor-top"><div><h3>${esc(r.business || r.name || 'Vendor')}</h3>
          <div class="contact">${esc(r.name || '')} · ${esc(r.category || '')} · ${esc(r.space === 'outdoor' ? 'Outdoor' : 'Indoor')}</div></div>
          <span class="status ${r.attendance === 'checked_in' ? 'ok' : r.attendance === 'no_show' ? 'bad' : 'neutral'}">${r.attendance === 'checked_in' ? 'Checked in' : r.attendance === 'no_show' ? 'No-show' : 'Not marked'}</span></div>
          ${r.setup_arrival_time ? `<p class="note">Setup arrival: <strong>${esc(r.setup_arrival_time)}</strong>${r.setup_checkin_at ? ' · checked in online' : ''}</p>` : ''}
          <div class="vendor-actions" role="group" aria-label="Attendance for ${esc(r.business || r.name || 'vendor')}">
            <button type="button" class="btn small ${r.attendance === 'checked_in' ? 'primary' : ''}" data-m-att="${esc(r.id)}|checked_in">Checked in</button>
            <button type="button" class="btn small ${r.attendance === 'no_show' ? 'danger' : ''}" data-m-att="${esc(r.id)}|no_show">No-show</button>
            <button type="button" class="btn small" data-m-att="${esc(r.id)}|not_marked">Clear</button>
          </div>
          ${r.inspection_status !== undefined ? `
          <form class="inspection-form" data-m-insp="${esc(r.id)}">
            <label class="sheet-field">Inspection
              <select name="status">${[['not_inspected', 'Not inspected'], ['approved', 'Approved'], ['needs_correction', 'Needs correction'], ['refused', 'Refused compliance']].map(([v, l]) => `<option value="${v}" ${r.inspection_status === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
            </label>
            <label class="sheet-field">Inspection notes<textarea name="notes" rows="2" maxlength="2000">${esc(r.inspection_notes || '')}</textarea></label>
            <div class="vendor-actions"><button class="btn small">Save inspection</button></div>
          </form>` : ''}
        </article>`).join('') || '<div class="card empty-card">No vendors for this date yet.</div>'}</div>`;
    rowsEl.querySelectorAll('[data-m-att]').forEach(b => b.onclick = async () => {
      const [id, stateName] = b.dataset.mAtt.split('|');
      const row = managerAttendeeRows(ctx.state.manager, eventId).find(r => String(r.id) === String(id));
      try {
        // Same call shapes as the organizer's Event Day.
        await api(row.imported ? 'imported-attendance' : 'attendance', { id, state: stateName });
        ctx.toast('Attendance saved.');
        await ctx.refreshData();
        draw();
      } catch (e) { ctx.toast(e.message, true); }
    });
    rowsEl.querySelectorAll('[data-m-insp]').forEach(f => f.onsubmit = async e => {
      e.preventDefault();
      const row = managerAttendeeRows(ctx.state.manager, eventId).find(r => String(r.id) === String(f.dataset.mInsp));
      const fd = new FormData(f);
      try {
        await api('inspection', { id: row.id, imported: row.imported, status: fd.get('status'), notes: fd.get('notes') });
        ctx.toast('Inspection saved.');
        await ctx.refreshData();
        draw();
      } catch (err) { ctx.toast(err.message, true); }
    });
  }

  root.querySelectorAll('[data-mev]').forEach(b => b.onclick = () => {
    eventId = b.dataset.mev;
    root.querySelectorAll('[data-mev]').forEach(x => x.classList.toggle('active', x === b));
    draw();
    renderSavedFloorPlan(root.querySelector('#v2-m-floor'), eventId);
  });
  const search = root.querySelector('#v2-m-search');
  if (search) search.oninput = () => { query = search.value.trim(); draw(); };
  root.querySelector('#v2-m-reminder').onclick = async e => {
    e.currentTarget.disabled = true;
    try {
      // The checkin-reminder contract is per-attendee ({id, imported} —
      // the classic contract); this button is the event-wide shortcut,
      // so it fans out over this date's rows that still need check-in
      // and have a usable email (§31 — there is no {event_id} variant).
      const rows = managerAttendeeRows(ctx.state.manager, eventId)
        .filter(r => !r.setup_checkin_at && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(r.email || '').replace(/,+\s*$/, '').trim()));
      let sent = 0, failed = 0;
      for (const r of rows) {
        try { await api('checkin-reminder', { id: r.id, imported: r.imported }); sent++; }
        catch { failed++; }
      }
      if (sent) ctx.toast(`Check-in reminder sent to ${sent} vendor(s).` + (failed ? ` ${failed} could not be sent.` : ''));
      else if (failed) ctx.toast('No check-in reminders could be sent.', true);
      else ctx.toast('Every vendor for this date has already checked in or has no email on file.');
    } catch (err) { ctx.toast(err.message, true); }
    e.currentTarget.disabled = false;
  };
  draw();
  renderSavedFloorPlan(root.querySelector('#v2-m-floor'), eventId);
}

// Applications review: managers approve or decline pending/waitlisted
// rows WITHOUT the exception option the organizer has (the server
// refuses it for staff), and a decline always needs a reason.
export function renderManagerApplications(ctx, root, { waitlistOnly = false } = {}) {
  let filter = waitlistOnly ? 'waitlist' : 'pending';
  root.innerHTML = `
    <p class="eyebrow">Vendors</p>
    <h2 class="display">${waitlistOnly ? 'Wait List' : 'Applications'}</h2>
    <div class="filters" role="group" aria-label="Filter applications">
      ${[['pending', 'Pending'], ['waitlist', 'Waitlist'], ['approved', 'Approved']].map(([v, l]) => `<button type="button" class="chip-btn ${filter === v ? 'active' : ''}" data-mf="${v}">${l}</button>`).join('')}
    </div>
    <div id="v2-m-apps"></div>`;
  const box = root.querySelector('#v2-m-apps');

  function draw() {
    const apps = (ctx.state.manager?.applications || []).filter(a => a.status === filter);
    box.innerHTML = `<div class="vendor-list">${apps.map(a => `
      <article class="card vendor">
        <div class="vendor-top"><div><h3>${esc(a.business || a.name || 'Vendor')}</h3>
        <div class="contact">${esc(eventLabel(ctx, a.event_id))} · ${esc(a.category || '')} · ${esc(a.space === 'outdoor' ? 'Outdoor' : 'Indoor')}</div></div>
        <span class="status ${a.status === 'pending' ? 'neutral' : a.status === 'waitlist' ? 'warn' : 'ok'}">${esc(a.status.toUpperCase())}</span></div>
        <p class="note">${esc(a.name || '')} · ${esc(a.email || '')}${a.phone ? ' · ' + esc(a.phone) : ''}</p>
        ${a.description ? `<p class="note">${esc(a.description)}</p>` : ''}
        <div class="vendor-actions">
          ${a.status === 'pending' || a.status === 'waitlist' ? `<button type="button" class="btn small primary" data-m-review="${esc(a.id)}">Review</button>` : ''}
          ${a.status === 'waitlist' && managerCan(ctx, 'waitlist') && !a.waitlist_offered_at ? `<button type="button" class="btn small" data-m-offer="${esc(a.id)}">Offer the open spot</button>` : ''}
          ${a.status === 'waitlist' && a.waitlist_offered_at ? `<span class="note">Spot offered — answer due within 12 hours of the offer.</span>` : ''}
        </div>
      </article>`).join('') || '<div class="card empty-card">Nothing here right now.</div>'}</div>`;
    box.querySelectorAll('[data-m-review]').forEach(b => b.onclick = () => review(b.dataset.mReview));
    box.querySelectorAll('[data-m-offer]').forEach(b => b.onclick = async () => {
      if (!confirm('Offer the open spot to this vendor? They get 12 hours to accept.')) return;
      try { await api('waitlist-offer', { id: b.dataset.mOffer }); ctx.toast('Spot offered.'); await ctx.refreshData(); draw(); }
      catch (e) { ctx.toast(e.message, true); }
    });
  }

  function review(id) {
    const a = (ctx.state.manager?.applications || []).find(x => String(x.id) === String(id));
    if (!a) return;
    ctx.openSheet(`
      <h3 class="sheet-title">Review application</h3>
      <p class="note"><strong>${esc(a.business || '')}</strong> — ${esc(a.name || '')}<br>${esc(eventLabel(ctx, a.event_id))} · ${esc(a.category || '')} · ${esc(a.space === 'outdoor' ? 'Outdoor' : 'Indoor')}<br>${esc(a.email || '')}${a.phone ? ' · ' + esc(a.phone) : ''}</p>
      ${a.description ? `<p class="note">${esc(a.description)}</p>` : ''}
      <label class="sheet-field">Reason (required to decline)<textarea id="v2-m-reason" rows="2" maxlength="1000" placeholder="The vendor sees this reason"></textarea></label>
      <div class="vendor-actions">
        <button class="btn primary small" id="v2-m-approve">Approve</button>
        <button class="btn small danger" id="v2-m-decline">Decline</button>
      </div>
      <p class="note">Staff approvals skip the category-exception option — if this application needs one, the organizer handles it.</p>`);
    const sheet = ctx.sheetEl;
    sheet.querySelector('#v2-m-approve').onclick = async () => {
      try {
        // The booking action keys off status; the server restricts
        // managers to approve/decline with no exception (403 otherwise).
        await api('booking', { id: a.id, status: 'approved' });
        ctx.toast('Application approved.');
        ctx.closeSheet();
        await ctx.refreshData();
        draw();
      } catch (e) { ctx.toast(e.message, true); }
    };
    sheet.querySelector('#v2-m-decline').onclick = async () => {
      const reason = sheet.querySelector('#v2-m-reason').value.trim();
      if (!reason) { ctx.toast('A reason is required to decline — the vendor sees it.', true); return; }
      try {
        await api('booking', { id: a.id, status: 'declined', reason });
        ctx.toast('Application declined.');
        ctx.closeSheet();
        await ctx.refreshData();
        draw();
      } catch (e) { ctx.toast(e.message, true); }
    };
  }

  root.querySelectorAll('[data-mf]').forEach(b => b.onclick = () => {
    filter = b.dataset.mf;
    root.querySelectorAll('[data-mf]').forEach(x => x.classList.toggle('active', x === b));
    draw();
  });
  draw();
}

// Floor plans for staff: every saved area of the event, read-only — the
// shared renderer already iterates all of the event's areas (multi-area
// events included). Editing stays organizer-only this stage.
export function renderManagerFloor(ctx, root) {
  const events = [...(ctx.state.manager?.events || [])].sort((a, b) => String(b.date).localeCompare(String(a.date)));
  let eventId = String(events[0]?.id || '');
  root.innerHTML = `
    <p class="eyebrow">Setup</p>
    <h2 class="display">Floor Plans</h2>
    <p class="lede">The saved plans for each date, read-only. The organizer edits them in the Floor Plan Editor.</p>
    <label class="picker-label">Market date
      <select id="v2-m-floor-date" class="picker">${events.map(e => `<option value="${esc(e.id)}" ${String(e.id) === eventId ? 'selected' : ''}>${esc(nice(e.date))} — ${esc(e.location || '')}</option>`).join('')}</select>
    </label>
    <div id="v2-m-floor-view"></div>`;
  const view = root.querySelector('#v2-m-floor-view');
  const draw = () => renderSavedFloorPlan(view, eventId);
  root.querySelector('#v2-m-floor-date').onchange = e => { eventId = e.target.value; draw(); };
  draw();
}
