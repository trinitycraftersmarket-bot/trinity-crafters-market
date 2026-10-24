// Event Day screen: the attendee list for one market date, with inspection
// and check-in — the daily driver, and the flow whose stale labels started
// the rebuild. The rule that fixes it (audit §5): a mutation is a server
// call, then a FULL re-fetch of the admin payload, then a re-render from
// that fresh data. This screen never edits a local copy of a row, so what
// it shows is always what the server has — and it survives a reload,
// because a reload does the same fetch.
import { api, esc, money, nice, clock, marketName, isToday } from './api.js?v=20261024-23';
import { attendeeRows, eventStats } from './data.js?v=20261024-23';
import { renderSavedFloorPlan } from './floorplan.js?v=20261024-23';

const INSP_LABEL = { not_inspected: 'Inspection: Pending', approved: 'Inspection: Approved', needs_correction: 'Needs correction', refused: 'Inspection: Refused' };
const INSP_CLASS = { not_inspected: 'warn', approved: 'ok', needs_correction: 'bad', refused: 'bad' };

let view = { eventId: '', q: '', filter: 'all' };

function payChip(r) {
  if (r.payStatus === 'paid') return `<span class="status ok">Paid${r.amount ? ' · ' + money(r.amount) : ''}</span>`;
  return `<span class="status warn">Unpaid${r.amount ? ' · ' + money(r.amount) + ' due' : ''}</span>`;
}
function attendanceChip(r) {
  if (r.attendance === 'checked_in') return '<span class="status ok">Checked in</span>';
  if (r.attendance === 'no_show') return '<span class="status bad">No show</span>';
  return '<span class="status neutral">Not checked in</span>';
}
function rowMatches(r) {
  if (view.filter === 'pending' && r.inspection_status === 'approved') return false;
  if (view.filter === 'unpaid' && r.payStatus !== 'unpaid') return false;
  if (view.filter === 'inside' && r.spaceNorm !== 'indoor') return false;
  if (view.filter === 'outside' && r.spaceNorm !== 'outdoor') return false;
  if (view.q) {
    const hay = [r.business, r.name, r.email, r.phone, r.category].map(x => String(x || '').toLowerCase()).join(' ');
    if (!hay.includes(view.q)) return false;
  }
  return true;
}

function cardHtml(r) {
  const insp = r.inspection_status;
  const approved = insp === 'approved';
  return `<article class="card vendor" data-row="${esc(r.id)}">
    <div class="vendor-top">
      <div><h3>${esc(r.business || r.name || 'Vendor')}</h3>
      <div class="contact">${esc(r.name || '')}${r.category ? ' · ' + esc(r.category) : ''}</div></div>
      <span class="badge ${r.spaceNorm === 'outdoor' ? 'outside' : 'inside'}">${r.spaceNorm === 'outdoor' ? 'OUTSIDE' : 'INSIDE'}</span>
    </div>
    <div class="chips">
      <span class="status ${INSP_CLASS[insp]}">${INSP_LABEL[insp]}</span>
      ${payChip(r)}
      ${attendanceChip(r)}
      ${r.setup_checkin_at ? `<span class="status neutral">Online check-in ✓${r.setup_arrival_time ? ' · arrives ' + esc(clock(r.setup_arrival_time)) : ''}</span>` : ''}
    </div>
    ${r.disclosed ? `<p class="note"><strong>Sells:</strong> ${esc(r.disclosed)}</p>` : ''}
    ${r.inspection_notes ? `<p class="note"><strong>Inspection notes:</strong> ${esc(r.inspection_notes)}${r.inspected_by ? ` <span class="muted">— ${esc(r.inspected_by)}</span>` : ''}</p>` : ''}
    <div class="vendor-actions">
      ${approved
        ? (r.attendance === 'checked_in'
          ? `<button class="btn small" data-act="attendance" data-state="clear" data-id="${esc(r.id)}" data-imported="${r.imported ? '1' : '0'}">Undo check-in</button>`
          : `<button class="btn primary small" data-act="attendance" data-state="checked_in" data-id="${esc(r.id)}" data-imported="${r.imported ? '1' : '0'}">Check in</button>`)
        : `<button class="btn primary small" data-act="inspect" data-status="approved" data-id="${esc(r.id)}" data-imported="${r.imported ? '1' : '0'}">Approve inspection</button>`}
      <button class="btn small ghost" data-act="more" data-id="${esc(r.id)}" data-imported="${r.imported ? '1' : '0'}">More ⋯</button>
    </div>
  </article>`;
}

export function renderEventDay(ctx, root, params = {}) {
  const admin = ctx.state.admin;
  const events = admin.events || [];
  if (!events.length) {
    root.innerHTML = '<p class="eyebrow">Market Day</p><h2 class="display">Event Day</h2><p class="lede">No upcoming markets on the calendar yet.</p>';
    return;
  }
  const wanted = params.event || view.eventId;
  const event = events.find(e => String(e.id) === String(wanted)) || events.find(isToday) || events[0];
  view.eventId = String(event.id);
  if (params.focus !== 'floorplan') { view.q = ''; view.filter = 'all'; }

  root.innerHTML = `
    <p class="eyebrow">${esc(nice(event.date))} · ${esc(event.location || '')}</p>
    <h2 class="display">Event Day</h2>
    <p class="lede" id="v2-day-summary"></p>
    <label class="picker-label">Market date
      <select id="v2-event-picker" class="picker">${events.map(e => `<option value="${esc(e.id)}" ${String(e.id) === String(event.id) ? 'selected' : ''}>${esc(nice(e.date))} — ${esc(marketName(e))}</option>`).join('')}</select>
    </label>
    <div class="search"><input id="v2-search" type="search" placeholder="Search business or name…" autocomplete="off" value="${esc(view.q)}"></div>
    <div class="filters" role="group" aria-label="Filter attendees">
      ${[['all', 'All'], ['pending', 'Inspection pending'], ['unpaid', 'Unpaid'], ['inside', 'Inside'], ['outside', 'Outside']].map(([k, t]) => `<button class="chip-btn ${view.filter === k ? 'active' : ''}" data-filter="${k}">${t}</button>`).join('')}
    </div>
    <div class="vendor-list" id="v2-vendor-list"></div>
    <h3 class="section-title" id="v2-floorplan-title">Floor plan</h3>
    <section class="card fp-card"><div id="v2-floorplan"></div></section>
    <div class="vendor-actions">
      <button class="btn small" id="v2-open-editor">Open the floor plan editor</button>
    </div>
    <p class="note">This is the saved plan, exactly as arranged in the editor — same data, same positions.</p>`;
  root.querySelector('#v2-open-editor').onclick = () => ctx.navigate('flooredit', { event: String(event.id) });

  const draw = () => {
    const fresh = ctx.state.admin;
    const stats = eventStats(fresh, event);
    const summary = root.querySelector('#v2-day-summary');
    if (summary) summary.textContent = `${stats.vendors} vendors · ${stats.checkedIn} checked in · ${stats.inspectionsPending} inspections pending${stats.unpaidCount ? ' · ' + stats.unpaidCount + ' unpaid (' + money(stats.unpaidDue) + ')' : ''}. Tap Approve and the chip updates from the server — no refresh needed.`;
    const rows = attendeeRows(fresh, event.id).filter(rowMatches);
    const list = root.querySelector('#v2-vendor-list');
    if (list) list.innerHTML = rows.map(cardHtml).join('') || `<div class="card empty-card">${stats.vendors ? 'No vendors match this search or filter.' : 'No attendees for this date yet.'}</div>`;
    bindCards();
  };

  // One mutation path for the whole screen: server call → re-fetch the
  // payload → re-render from it. Any failure is surfaced, never swallowed.
  const mutate = async (call, okMsg) => {
    try {
      await call();
      await ctx.refreshAdmin();
      draw();
      if (okMsg) ctx.toast(okMsg);
    } catch (e) {
      ctx.toast(e.message, true);
    }
  };
  const setInspection = (row, status, notes) => mutate(
    () => api('inspection', { id: row.id, imported: row.imported, status, notes: notes || '' }),
    status === 'approved' ? 'Inspection approved — check-in is open.' : status === 'not_inspected' ? 'Inspection reset.' : 'Inspection saved.'
  );
  const setAttendance = (row, state) => mutate(
    () => api(row.imported ? 'imported-attendance' : 'attendance', { id: row.id, state }),
    state === 'checked_in' ? 'Vendor checked in.' : state === 'no_show' ? 'Marked as no show.' : 'Attendance cleared.'
  );
  const findRow = (id, imported) => attendeeRows(ctx.state.admin, event.id).find(r => String(r.id) === String(id) && r.imported === imported);

  const notesSheet = (row, status) => {
    const title = status === 'refused' ? 'Refuse compliance' : 'Needs correction';
    ctx.openSheet(`
      <h3 class="sheet-title">${title}</h3>
      <p><strong>${esc(row.business || row.name || 'Vendor')}</strong></p>
      <p class="note"><strong>Disclosed:</strong> ${esc(row.disclosed || 'Not listed')}<br><strong>Approved to sell:</strong> ${esc(row.approved_products || 'Not specified')}<br><strong>Not approved:</strong> ${esc(row.declined_products || 'None listed')}</p>
      <label class="sheet-field">Inspection notes (required)<textarea id="v2-insp-notes" rows="4" placeholder="What needs fixing?">${esc(row.inspection_notes || '')}</textarea></label>
      <div class="sheet-actions">
        <button class="btn" data-sheet-close>Cancel</button>
        <button class="btn ${status === 'refused' ? 'danger' : 'primary'}" id="v2-insp-save">Save inspection</button>
      </div>`);
    ctx.sheetEl.querySelector('#v2-insp-save').onclick = () => {
      const notes = ctx.sheetEl.querySelector('#v2-insp-notes').value.trim();
      if (!notes) { ctx.toast('Enter inspection notes first.', true); return; }
      ctx.closeSheet();
      setInspection(row, status, notes);
    };
  };

  const moreSheet = row => {
    const insp = row.inspection_status;
    ctx.openSheet(`
      <h3 class="sheet-title">${esc(row.business || row.name || 'Vendor')}</h3>
      <p class="note">${esc(row.name || '')}${row.category ? ' · ' + esc(row.category) : ''} · ${row.spaceNorm === 'outdoor' ? 'Outside' : 'Inside'}</p>
      <div class="sheet-menu">
        ${insp !== 'approved' ? `<button class="menu-item" data-more-act="approve"><span><b>Approve inspection</b><span>Marks the booth compliant and opens check-in</span></span><span class="chev">›</span></button>` : ''}
        ${insp !== 'needs_correction' ? `<button class="menu-item" data-more-act="needs_correction"><span><b>Needs correction</b><span>Requires a note for the vendor</span></span><span class="chev">›</span></button>` : ''}
        ${insp !== 'refused' ? `<button class="menu-item" data-more-act="refused"><span><b>Refused compliance</b><span>Requires a note; vendor stays flagged</span></span><span class="chev">›</span></button>` : ''}
        ${insp !== 'not_inspected' ? `<button class="menu-item" data-more-act="reset"><span><b>Reset inspection</b><span>Back to pending</span></span><span class="chev">›</span></button>` : ''}
        ${row.attendance !== 'no_show' ? `<button class="menu-item" data-more-act="no_show"><span><b>Mark no show</b><span>Vendor did not arrive</span></span><span class="chev">›</span></button>` : ''}
        ${row.attendance !== 'not_marked' ? `<button class="menu-item" data-more-act="clear"><span><b>Clear attendance</b><span>Neither checked in nor no show</span></span><span class="chev">›</span></button>` : ''}
      </div>`);
    ctx.sheetEl.querySelectorAll('[data-more-act]').forEach(b => b.onclick = () => {
      const act = b.dataset.moreAct;
      ctx.closeSheet();
      if (act === 'approve') setInspection(row, 'approved', '');
      else if (act === 'reset') setInspection(row, 'not_inspected', '');
      else if (act === 'needs_correction' || act === 'refused') notesSheet(row, act);
      else if (act === 'no_show') setAttendance(row, 'no_show');
      else if (act === 'clear') setAttendance(row, 'clear');
    });
  };

  function bindCards() {
    root.querySelectorAll('[data-act]').forEach(btn => btn.onclick = () => {
      const row = findRow(btn.dataset.id, btn.dataset.imported === '1');
      if (!row) { ctx.toast('That vendor is no longer on the list — reloading.', true); ctx.refreshAdmin().then(draw); return; }
      if (btn.dataset.act === 'inspect') setInspection(row, btn.dataset.status, '');
      else if (btn.dataset.act === 'attendance') setAttendance(row, btn.dataset.state);
      else if (btn.dataset.act === 'more') moreSheet(row);
    });
  }

  root.querySelector('#v2-event-picker').onchange = e => ctx.navigate('event-day', { event: e.target.value });
  const search = root.querySelector('#v2-search');
  search.oninput = () => { view.q = search.value.trim().toLowerCase(); draw(); };
  root.querySelectorAll('[data-filter]').forEach(b => b.onclick = () => {
    view.filter = b.dataset.filter;
    root.querySelectorAll('[data-filter]').forEach(x => x.classList.toggle('active', x === b));
    draw();
  });

  draw();
  renderSavedFloorPlan(root.querySelector('#v2-floorplan'), event.id);
  if (params.focus === 'floorplan') {
    setTimeout(() => root.querySelector('#v2-floorplan-title')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 60);
  }
}
