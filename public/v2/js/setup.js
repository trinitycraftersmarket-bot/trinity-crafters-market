// Setup group screens (audit §3.1): Dates & Locations, Categories,
// Managers, Connections & Status (with the bug-report inbox, §13.8),
// Surveys, Archived Events and Organizer Tools. Each is a port of the
// legacy Setup tool at parity — same api actions, same payloads, same
// server messages surfaced verbatim — rebuilt on the v2 rules: forms live
// in the shared sheet system, every mutation re-fetches, and a save only
// ever sends the fields it means to change (§5 R-7: the event-capacity
// floor now bites only when capacity is actually reduced, server-side).
import { api, esc, money, nice, niceShort, clock, getToken } from './api.js?v=20261024-32';

const stamp = v => v ? new Date(v).toLocaleString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '';
const intOr = (v, f) => { const n = parseInt(v, 10); return Number.isInteger(n) && n >= 0 ? n : f; };
const centsOf = v => Math.round((Number(v) || 0) * 100);

// The capacity/price field set shared by the date and location forms
// (dollars in the form, integer cents on the wire — §8.3).
const capacityFields = x => `
  <div class="sheet-grid">
    <label class="sheet-field">TOTAL indoor spaces (not spaces remaining)<input name="indoor_capacity" type="number" min="0" required value="${x?.indoor_capacity ?? 9}"></label>
    <label class="sheet-field">TOTAL outdoor spaces (not spaces remaining)<input name="outdoor_capacity" type="number" min="0" required value="${x?.outdoor_capacity ?? 3}"></label>
    <label class="sheet-field">Indoor price ($)<input name="indoor_price" type="number" min="0" step="0.01" required value="${(x?.indoor_price ?? 4500) / 100}"></label>
    <label class="sheet-field">Outdoor price ($)<input name="outdoor_price" type="number" min="0" step="0.01" required value="${(x?.outdoor_price ?? 3000) / 100}"></label>
  </div>
  <p class="note"><strong>Capacity means the venue's total booth count.</strong> Do not reduce this number as vendors book; available spaces are calculated automatically from active vendor records.</p>`;
const readCapacity = f => ({
  indoor_capacity: intOr(f.get('indoor_capacity'), 0),
  outdoor_capacity: intOr(f.get('outdoor_capacity'), 0),
  indoor_price: centsOf(f.get('indoor_price')),
  outdoor_price: centsOf(f.get('outdoor_price'))
});

// Sheet form error line: server validation messages (e.g. the capacity
// floor) are shown verbatim inside the form, never swallowed (§5 R-7).
const sheetError = (ctx, msg) => {
  const el = ctx.sheetEl?.querySelector('[data-form-msg]');
  if (el) { el.hidden = false; el.textContent = msg; }
  ctx.toast(msg, true);
};

// --- Dates & Locations ------------------------------------------------------
export function renderDates(ctx, root) {
  const admin = () => ctx.state.admin;
  root.innerHTML = `
    <p class="eyebrow">Setup</p>
    <h2 class="display">Dates &amp; Locations</h2>
    <p class="lede">Market calendar, venues, capacities and prices. Existing dates keep their own prices and capacity — location defaults only seed new dates.</p>
    <div class="vendor-actions">
      <button class="btn primary small" id="su-new-date">Add market date</button>
      <button class="btn small" id="su-new-location">Add location</button>
      <button class="btn small" id="su-sync">Sync calendar now</button>
    </div>
    <div id="su-dates"></div>`;

  function dateSheet(x = {}) {
    const a = admin();
    ctx.openSheet(`
      <h3 class="sheet-title">${x.id ? 'Edit' : 'Add'} market date</h3>
      <form id="su-date-form">
        <label class="sheet-field">Date<input name="date" type="date" required value="${esc(String(x.date || '').slice(0, 10))}"></label>
        <label class="sheet-field">Market / event name<input name="title" value="${esc(x.title || 'Trinity Crafters Market')}"></label>
        <label class="sheet-field">Location<select name="location_id">${(a.locations || []).map(l => `<option value="${esc(l.id)}" ${String(l.id) === String(x.location_id) ? 'selected' : ''}>${esc(l.name)}</option>`).join('')}</select></label>
        <div class="sheet-grid">
          <label class="sheet-field">Start time<input name="start_time" type="time" required value="${esc(String(x.start_time || '10:00').slice(0, 5))}"></label>
          <label class="sheet-field">End time<input name="end_time" type="time" required value="${esc(String(x.end_time || '15:00').slice(0, 5))}"></label>
        </div>
        ${capacityFields(x)}
        <label class="checkline"><input type="checkbox" name="open" ${x.open !== false ? 'checked' : ''}> Accept vendor applications</label>
        <label class="checkline"><input type="checkbox" name="sold_out" ${x.sold_out ? 'checked' : ''}> Sold out (leave applications open to collect wait-list requests)</label>
        <label class="checkline"><input type="checkbox" name="indoor_open" ${x.indoor_open !== false ? 'checked' : ''}> Indoor applications open</label>
        <label class="checkline"><input type="checkbox" name="outdoor_open" ${x.outdoor_open !== false ? 'checked' : ''}> Outdoor applications open</label>
        <p class="note flag-note" data-form-msg hidden></p>
        <div class="sheet-actions"><button type="button" class="btn" data-sheet-close>Cancel</button><button class="btn primary">Save date</button></div>
      </form>`);
    const form = ctx.sheetEl.querySelector('#su-date-form');
    if (!x.id) {
      // A brand-new date seeds its capacities and prices from the venue.
      form.elements.namedItem('location_id').onchange = e => {
        const l = (admin().locations || []).find(l => String(l.id) === String(e.target.value));
        if (!l) return;
        form.elements.namedItem('indoor_capacity').value = l.indoor_capacity;
        form.elements.namedItem('outdoor_capacity').value = l.outdoor_capacity;
        form.elements.namedItem('indoor_price').value = l.indoor_price / 100;
        form.elements.namedItem('outdoor_price').value = l.outdoor_price / 100;
      };
    }
    form.onsubmit = async e => {
      e.preventDefault();
      const f = new FormData(form);
      try {
        await api('event', {
          ...(x.id ? { id: x.id } : {}),
          date: f.get('date'), title: f.get('title'), location_id: f.get('location_id'),
          start_time: f.get('start_time'), end_time: f.get('end_time'),
          ...readCapacity(f),
          open: f.get('open') === 'on', sold_out: f.get('sold_out') === 'on',
          indoor_open: f.get('indoor_open') === 'on', outdoor_open: f.get('outdoor_open') === 'on'
        });
        ctx.closeSheet();
        ctx.toast('Market date saved.');
        await ctx.refreshAdmin();
        draw();
      } catch (err) { sheetError(ctx, err.message); }
    };
  }

  function locationSheet(x = {}) {
    ctx.openSheet(`
      <h3 class="sheet-title">${x.id ? 'Edit' : 'Add'} location</h3>
      <form id="su-location-form">
        <label class="sheet-field">Market name / brand<input name="market_name" value="${esc(x.market_name || '')}"></label>
        <label class="sheet-field">Venue name<input name="name" required value="${esc(x.name || '')}"></label>
        <label class="sheet-field">Full address<input name="address" required value="${esc(x.address || '')}"></label>
        ${capacityFields(x)}
        <p class="note">These defaults apply to new dates. Existing dates keep their own prices and capacity.</p>
        <p class="note flag-note" data-form-msg hidden></p>
        <div class="sheet-actions"><button type="button" class="btn" data-sheet-close>Cancel</button><button class="btn primary">Save location</button></div>
      </form>`);
    ctx.sheetEl.querySelector('#su-location-form').onsubmit = async e => {
      e.preventDefault();
      const f = new FormData(e.target);
      try {
        await api('location', {
          ...(x.id ? { id: x.id } : {}),
          market_name: f.get('market_name'), name: f.get('name'), address: f.get('address'),
          ...readCapacity(f)
        });
        ctx.closeSheet();
        ctx.toast('Location saved.');
        await ctx.refreshAdmin();
        draw();
      } catch (err) { sheetError(ctx, err.message); }
    };
  }

  function draw() {
    const a = admin();
    const locName = id => (a.locations || []).find(l => String(l.id) === String(id))?.name || '';
    const statusChip = e => e.sold_out
      ? `<span class="status warn">Sold out — wait list ${e.open ? 'open' : 'closed'}</span>`
      : e.open ? '<span class="status ok">Applications open</span>' : '<span class="status neutral">Applications closed</span>';
    const card = e => `
      <article class="card vendor">
        <div class="vendor-top"><div><h3>${esc(nice(e.date))}</h3>
        <div class="contact">${esc(locName(e.location_id))} · ${esc(clock(e.start_time))}–${esc(clock(e.end_time))}</div></div>
        ${statusChip(e)}</div>
        <p class="note">${e.indoor_capacity} indoor at ${money(e.indoor_price)} · ${e.outdoor_capacity} outdoor at ${money(e.outdoor_price)}<br>
        Booked so far: ${e.indoor_used ?? 0} indoor · ${e.outdoor_used ?? 0} outdoor${e.setup_sent_at ? '<br>Setup email sent ' + esc(stamp(e.setup_sent_at)) : ''}</p>
        ${e.sync_alert ? `<p class="note flag-note">${esc(e.sync_alert)}</p>` : ''}
        <div class="vendor-actions"><button class="btn small" data-edit-date="${esc(e.id)}">Edit date</button></div>
      </article>`;
    const upcomingIds = new Set((a.events || []).map(e => String(e.id)));
    const past = (a.allEvents || []).filter(e => !upcomingIds.has(String(e.id)));
    root.querySelector('#su-dates').innerHTML = `
      <div class="vendor-list">${(a.events || []).map(card).join('') || '<div class="card empty-card">No upcoming market dates.</div>'}</div>
      ${past.length ? `<h3 class="section-title">Past dates</h3><div class="vendor-list">${past.map(card).join('')}</div>` : ''}
      <h3 class="section-title">Locations</h3>
      <div class="vendor-list">${(a.locations || []).map(l => `
        <article class="card vendor">
          <div class="vendor-top"><div><h3>${esc(l.name)}</h3><div class="contact">${esc(l.market_name || '')}</div></div></div>
          <p class="note">${esc(l.address || '')}<br>Defaults: ${l.indoor_capacity} indoor at ${money(l.indoor_price)} · ${l.outdoor_capacity} outdoor at ${money(l.outdoor_price)}</p>
          <div class="vendor-actions"><button class="btn small" data-edit-location="${esc(l.id)}">Edit location defaults</button></div>
        </article>`).join('') || '<div class="card empty-card">No locations yet.</div>'}</div>`;
    root.querySelectorAll('[data-edit-date]').forEach(b => b.onclick = () => dateSheet((admin().allEvents || []).find(e => String(e.id) === String(b.dataset.editDate)) || {}));
    root.querySelectorAll('[data-edit-location]').forEach(b => b.onclick = () => locationSheet((admin().locations || []).find(l => String(l.id) === String(b.dataset.editLocation)) || {}));
  }

  root.querySelector('#su-new-date').onclick = () => dateSheet();
  root.querySelector('#su-new-location').onclick = () => locationSheet();
  root.querySelector('#su-sync').onclick = async () => {
    try {
      const r = await api('sync', {});
      ctx.toast(r.added + ' new dates added. ' + r.flagged + ' dates need review.');
      await ctx.refreshAdmin();
      draw();
    } catch (e) { ctx.toast(e.message, true); }
  };
  draw();
}

// --- Categories ---------------------------------------------------------------
let catView = { eventId: '' };
export function renderCategories(ctx, root) {
  const admin = () => ctx.state.admin;
  root.innerHTML = `
    <p class="eyebrow">Setup</p>
    <h2 class="display">Categories</h2>
    <p class="lede">How many vendors of each kind a date can hold. A date override beats the global default for that date only — and raising a limit runs the wait-list scan automatically.</p>
    <div id="su-cats"></div>`;

  const effective = (eventId, c) => {
    const row = (admin().counts || []).find(x => String(x.event_id) === String(eventId) && String(x.category_id) === String(c.id));
    const override = (admin().categoryLimits || []).find(x => String(x.event_id) === String(eventId) && String(x.category_id) === String(c.id));
    return {
      used: row ? Number(row.used || 0) : 0,
      limit: row?.vendor_limit ?? override?.vendor_limit ?? c.vendor_limit ?? 0,
      overridden: !!override
    };
  };

  // Same confirm-sheet pattern as flooredit.js / vendors.js.
  const confirmSheet = (title, text, confirmLabel) => new Promise(resolve => {
    ctx.openSheet(`
      <h3 class="sheet-title">${esc(title)}</h3>
      <p class="note">${esc(text)}</p>
      <div class="sheet-actions">
        <button class="btn" id="su-cf-no">Cancel</button>
        <button class="btn primary" id="su-cf-yes">${esc(confirmLabel)}</button>
      </div>`);
    ctx.sheetEl.querySelector('#su-cf-no').onclick = () => { ctx.closeSheet(); resolve(false); };
    ctx.sheetEl.querySelector('#su-cf-yes').onclick = () => { ctx.closeSheet(); resolve(true); };
  });

  function categorySheet(c = {}) {
    ctx.openSheet(`
      <h3 class="sheet-title">${c.id ? 'Edit' : 'Add'} category</h3>
      <form id="su-category-form">
        <label class="sheet-field">Category name<input name="name" required value="${esc(c.name || '')}"></label>
        <label class="sheet-field">Vendors allowed per date (0 = no cap)<input name="vendor_limit" type="number" min="0" required value="${c.vendor_limit ?? 1}"></label>
        <label class="checkline"><input type="checkbox" name="active" ${c.active !== false ? 'checked' : ''}> Active category</label>
        <p class="note flag-note" data-form-msg hidden></p>
        <div class="sheet-actions"><button type="button" class="btn" data-sheet-close>Cancel</button><button class="btn primary">Save category</button></div>
      </form>`);
    ctx.sheetEl.querySelector('#su-category-form').onsubmit = async e => {
      e.preventDefault();
      const f = new FormData(e.target);
      try {
        await api('category', { ...(c.id ? { id: c.id } : {}), name: f.get('name'), vendor_limit: intOr(f.get('vendor_limit'), 0), active: f.get('active') === 'on' });
        ctx.closeSheet();
        ctx.toast('Category saved.');
        await ctx.refreshAdmin();
        draw();
      } catch (err) { sheetError(ctx, err.message); }
    };
  }

  function draw() {
    const a = admin();
    const events = a.events || [];
    if (!events.length) {
      root.querySelector('#su-cats').innerHTML = '<div class="card empty-card">No upcoming market dates — add one under Dates &amp; Locations first.</div>';
      return;
    }
    if (!events.some(e => String(e.id) === catView.eventId)) catView.eventId = String(events[0]?.id || '');
    const active = (a.allCategories || []).filter(c => c.active).sort((x, y) => x.name.localeCompare(y.name));
    const eventId = catView.eventId;
    root.querySelector('#su-cats').innerHTML = `
      <div class="card filter-card">
        <label class="picker-label">Market date<select id="su-cat-event" class="picker">${events.map(e => `<option value="${esc(e.id)}" ${String(e.id) === eventId ? 'selected' : ''}>${esc(nice(e.date))} — ${esc((a.locations || []).find(l => String(l.id) === String(e.location_id))?.market_name || e.title || '')}</option>`).join('')}</select></label>
        <p class="note">What's actually allowed <strong>for the selected date</strong>, including date overrides:</p>
        <div>${active.map(c => {
          const eff = effective(eventId, c);
          // Limit 0 means NO cap (owner ruling): never "Closed", and the
          // count reads "N booked · no cap" instead of a misleading "of 0".
          const chip = eff.limit === 0 ? '<span class="status ok">No cap</span>' : eff.used >= eff.limit ? '<span class="status warn">Full</span>' : '<span class="status ok">Open</span>';
          return `<div class="mini-row"><span><strong>${esc(c.name)}</strong> · ${eff.limit === 0 ? eff.used + ' booked · no cap' : eff.used + ' of ' + eff.limit + ' booked'}${eff.overridden ? ' · <em>date override</em>' : ''}</span>${chip}</div>`;
        }).join('') || '<p class="note">No active categories.</p>'}</div>
        <h3 class="section-title">Change one category for this date</h3>
        <form id="su-limit-form">
          <div class="filter-row">
            <label class="picker-label">Category<select id="su-limit-category" class="picker">${active.map(c => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('')}</select></label>
            <label class="picker-label">Vendors allowed for this date<input id="su-limit-value" class="picker" type="number" min="0" value="1"></label>
          </div>
          <div class="vendor-actions"><button class="btn primary small">Save date override</button></div>
        </form>
      </div>
      <div class="vendor-actions"><button class="btn small" id="su-add-category">Add category</button></div>
      <div class="card">
        <h3 class="section-title">One vendor per category</h3>
        <p class="note">Owner rule: every open (active) category allows <strong>1 vendor per date</strong>. A category with a booking on a date then shows 0 left for that date; all others show 1 left. This sets the global defaults in one go — categories already at 1 are skipped, inactive categories are untouched, per-date overrides still apply on their dates, and existing bookings are never changed.</p>
        <div class="vendor-actions"><button class="btn primary small" id="su-cats-one">Set all open categories to 1 per date</button></div>
      </div>
      <h3 class="section-title">Global default category limits — all dates</h3>
      <p class="note">These are DEFAULT values, not the availability for the date selected above. Changing them can affect other events.</p>
      <div class="vendor-list">${(a.allCategories || []).map(c => `
        <article class="card vendor">
          <div class="vendor-top"><div><h3>${esc(c.name)}</h3></div><span class="status ${c.active ? 'ok' : 'neutral'}">${c.active ? 'Active' : 'Inactive'}</span></div>
          <p class="note">Global default: ${c.vendor_limit === 0 ? 'no cap — unlimited vendors per date' : c.vendor_limit + ' vendor(s) per date'}</p>
          <div class="vendor-actions"><button class="btn small" data-edit-category="${esc(c.id)}">Edit global default</button></div>
        </article>`).join('')}</div>`;
    const eventSel = root.querySelector('#su-cat-event');
    const catSel = root.querySelector('#su-limit-category');
    const valInput = root.querySelector('#su-limit-value');
    const syncValue = () => {
      const c = active.find(x => String(x.id) === String(catSel.value));
      if (c) valInput.value = effective(eventId, c).limit;
    };
    if (catSel) { syncValue(); catSel.onchange = syncValue; }
    eventSel.onchange = e => { catView.eventId = e.target.value; draw(); };
    root.querySelector('#su-limit-form').onsubmit = async e => {
      e.preventDefault();
      try {
        await api('event-category-limit', { event_id: eventId, category_id: catSel.value, vendor_limit: intOr(valInput.value, 0) });
        ctx.toast('Date override saved. The wait-list scan ran for any newly opened spots.');
        await ctx.refreshAdmin();
        draw();
      } catch (err) { ctx.toast(err.message, true); }
    };
    root.querySelector('#su-add-category').onclick = () => categorySheet();
    root.querySelector('#su-cats-one').onclick = async () => {
      const changing = (admin().allCategories || []).filter(c => c.active && Number(c.vendor_limit) !== 1).length;
      if (!changing) { ctx.toast('All open categories are already at 1 per date.'); return; }
      const ok = await confirmSheet(
        'Set all open categories to 1 per date?',
        'This sets the global default to 1 vendor per date for ' + changing + ' open categor' + (changing === 1 ? 'y' : 'ies') + ' that are not already at 1. Per-date overrides, where set, still apply on their dates. Existing bookings are never changed.',
        'Set to 1 per date');
      if (!ok) return;
      try {
        const r = await api('categories-set-limit-one', {});
        ctx.toast('Done — ' + r.count + ' open categor' + (r.count === 1 ? 'y' : 'ies') + ' set to 1 per date.');
        await ctx.refreshAdmin();
        draw();
      } catch (err) { ctx.toast(err.message, true); }
    };
    root.querySelectorAll('[data-edit-category]').forEach(b => b.onclick = () => categorySheet((admin().allCategories || []).find(c => String(c.id) === String(b.dataset.editCategory)) || {}));
  }
  draw();
}

// --- Managers -------------------------------------------------------------------
const PERMISSION_DEFS = [
  ['applications', 'Applications', 'View applications, vendor photos, and approve or decline requests.'],
  ['attendees', 'Vendor attendees & check-in', 'View attendee lists, check vendors in, mark no-shows, and use inspection tools.'],
  ['waitlist', 'Wait List', 'View and print vendor wait lists.'],
  ['shopper_rsvps', 'Shopper RSVPs', 'View and print shopper RSVP lists.'],
  ['vendor_messages', 'Vendor Messages', 'Read and reply to vendor messages.'],
  ['moves:approve', 'Move Requests', 'Approve or decline vendor date-move requests.'],
  ['live_chat', 'Live Chat', 'View and reply to website chats, receive chat alerts, and open or close Live Chat.'],
  ['floor_plans', 'Floor Plans', 'View and edit event floor plans and booth assignments.']
];
const DEFAULT_PERMS = ['applications', 'attendees', 'waitlist', 'shopper_rsvps', 'vendor_messages'];
const permName = k => PERMISSION_DEFS.find(x => x[0] === k)?.[1] || k;

export function renderManagers(ctx, root) {
  root.innerHTML = `
    <p class="eyebrow">Setup</p>
    <h2 class="display">Managers</h2>
    <p class="lede">Create manager accounts and choose exactly which parts of the market workspace each manager can use. Financial reports, billing records, configuration and owner-only settings stay organizer-only.</p>
    <div class="vendor-actions"><button class="btn primary small" id="su-add-manager">Add manager</button></div>
    <div id="su-managers"><div class="card empty-card">Loading managers…</div></div>`;

  const load = async () => {
    const host = root.querySelector('#su-managers');
    let rows;
    try { rows = await api('staff-list'); }
    catch (e) { host.innerHTML = `<div class="card empty-card"><p><strong>Managers couldn't load.</strong></p><p class="muted">${esc(e.message)}</p></div>`; return; }
    const card = r => `
      <article class="card vendor">
        <div class="vendor-top"><div><h3>${esc(r.name || 'Manager')}</h3><div class="contact">${esc(r.email)}</div></div>
        <span class="status ${r.active ? 'ok' : 'neutral'}">${r.active ? 'Active' : 'Disabled'}</span></div>
        <p class="note"><strong>Access:</strong> ${(Array.isArray(r.permissions) ? r.permissions : []).map(permName).map(esc).join(' · ') || 'No tools assigned'}<br>
        ${r.last_login ? 'Last login: ' + esc(stamp(r.last_login)) + ' · ' + Number(r.login_count || 0) + ' sign-in(s)' : 'No manager logins recorded yet.'}</p>
        ${Array.isArray(r.login_log) && r.login_log.length ? `<details class="vdetails"><summary>Recent sign-ins</summary><ol class="login-log">${r.login_log.map(x => `<li>${esc(stamp(x))}</li>`).join('')}</ol></details>` : ''}
        <div class="vendor-actions"><button class="btn small" data-edit-manager="${esc(r.email)}">Edit access</button></div>
      </article>`;
    const active = rows.filter(r => r.active), disabled = rows.filter(r => !r.active);
    host.innerHTML = `
      <h3 class="section-title first">Approved managers <span class="status neutral">${active.length}</span></h3>
      <div class="vendor-list">${active.map(card).join('') || '<div class="card empty-card">No approved managers yet.</div>'}</div>
      ${disabled.length ? `<h3 class="section-title">Disabled managers <span class="status neutral">${disabled.length}</span></h3><div class="vendor-list">${disabled.map(card).join('')}</div>` : ''}`;
    host.querySelectorAll('[data-edit-manager]').forEach(b => b.onclick = () => staffSheet(rows.find(r => r.email === b.dataset.editManager)));
  };

  function staffSheet(r = null) {
    const selected = new Set(r ? (Array.isArray(r.permissions) ? r.permissions : []) : DEFAULT_PERMS);
    ctx.openSheet(`
      <h3 class="sheet-title">${r ? 'Edit ' + esc(r.name || 'manager') : 'Add manager'}</h3>
      <form id="su-staff-form">
        <label class="sheet-field">Manager name<input name="name" required value="${esc(r?.name || '')}"></label>
        <label class="sheet-field">Sign-in email<input name="email" type="email" required value="${esc(r?.email || '')}" ${r ? 'readonly' : ''}></label>
        <p class="mini-title">Manager permissions</p>
        <p class="note">Choose the tools this manager can access.</p>
        ${PERMISSION_DEFS.map(([key, label, desc]) => `<label class="checkline"><input type="checkbox" name="perm" value="${esc(key)}" ${selected.has(key) ? 'checked' : ''}><span><strong>${esc(label)}</strong><br><span class="muted">${esc(desc)}</span></span></label>`).join('')}
        <label class="checkline"><input type="checkbox" name="active" ${!r || r.active ? 'checked' : ''}><span><strong>Enable Manager access</strong><br><span class="muted">Uncheck this to suspend the manager without deleting their record.</span></span></label>
        <p class="note flag-note" data-form-msg hidden></p>
        <div class="sheet-actions"><button type="button" class="btn" data-sheet-close>Cancel</button><button class="btn primary">${r ? 'Save changes' : 'Save Manager'}</button></div>
      </form>`);
    ctx.sheetEl.querySelector('#su-staff-form').onsubmit = async e => {
      e.preventDefault();
      const f = new FormData(e.target);
      try {
        await api('staff-save', {
          name: f.get('name'), email: f.get('email'),
          active: f.get('active') === 'on',
          permissions: f.getAll('perm').map(String)
        });
        ctx.closeSheet();
        ctx.toast('Manager access saved.');
        load();
      } catch (err) { sheetError(ctx, err.message); }
    };
  }

  root.querySelector('#su-add-manager').onclick = () => staffSheet();
  load();
}

// --- Connections & Status (+ bug-report inbox) ----------------------------------
export function renderConnections(ctx, root) {
  const admin = () => ctx.state.admin;
  root.innerHTML = `
    <p class="eyebrow">Setup</p>
    <h2 class="display">Connections &amp; Status</h2>
    <p class="lede">Integration status readouts — the useful signals, in one place. Connection credentials are stored privately in Netlify environment settings.</p>
    <div id="su-conn"></div>
    <h3 class="section-title">Problem reports</h3>
    <div id="su-bugs"><div class="card empty-card">Loading problem reports…</div></div>
    <h3 class="section-title">Recent vendor email notifications</h3>
    <div id="su-mail"></div>`;

  const row = (label, ok, extra = '') => `
    <div class="conn-row"><div><strong>${esc(label)}</strong><div class="contact">${ok ? 'Configured' : 'Setup required'}</div></div>
    <span class="status ${ok ? 'ok' : 'warn'}">${ok ? 'Connected' : 'Setup required'}</span>${extra}</div>`;

  function draw() {
    const a = admin();
    const i = a.integrations || {};
    const setting = k => (a.settings || []).find(x => x.key === k)?.value || '';
    root.querySelector('#su-conn').innerHTML = `
      <div class="card content-card">
        <div class="conn-row"><div><strong>Database &amp; verified-email accounts</strong><div class="contact">Connected</div></div><span class="status ok">Connected</span></div>
        ${row('Email notifications', !!i.mail, '<button class="btn small" id="su-test-email">Send test email</button>')}
        ${row('PayPal invoicing', !!i.paypal, '<button class="btn small" id="su-test-paypal">Test PayPal</button>')}
        ${row('Google Calendar', !!i.calendar, '<button class="btn small" id="su-sync-2">Sync calendar now</button>')}
        <p class="note">Last calendar sync: ${esc(setting('last_sync') || 'Not yet synced')}<br>Calendar notice: ${esc(setting('sync_error') || 'None')}</p>
        ${row('AI writing', !!i.ai)}
      </div>`;
    root.querySelector('#su-mail').innerHTML = `<div class="vendor-list">${(a.mail || []).map(m => `
      <article class="card vendor"><div class="vendor-top"><div><h3>${esc(m.subject || '(no subject)')}</h3>
      <div class="contact">${esc(m.recipient || '')}</div></div>
      <span class="status ${m.error ? 'bad' : m.sent_at ? 'ok' : 'warn'}">${m.error ? 'Failed' : m.sent_at ? 'Sent' : 'Pending'}</span></div>
      ${m.error ? `<p class="note flag-note">${esc(m.error)}</p>` : ''}</article>`).join('') || '<div class="card empty-card">No notifications yet.</div>'}</div>`;
    const test = root.querySelector('#su-test-email');
    if (test) test.onclick = async () => { try { await api('email-test', {}); ctx.toast('Test email sent. Check your inbox.'); await ctx.refreshAdmin(); draw(); } catch (e) { ctx.toast(e.message, true); } };
    const pay = root.querySelector('#su-test-paypal');
    if (pay) pay.onclick = async () => { try { const v = await api('paypal-test', {}); ctx.toast('PayPal connection successful (' + v.environment + ').'); } catch (e) { ctx.toast(e.message, true); } };
    const sync = root.querySelector('#su-sync-2');
    if (sync) sync.onclick = async () => { try { const r = await api('sync', {}); ctx.toast(r.added + ' new dates added. ' + r.flagged + ' dates need review.'); await ctx.refreshAdmin(); draw(); } catch (e) { ctx.toast(e.message, true); } };
  }

  const loadBugs = async () => {
    const host = root.querySelector('#su-bugs');
    try {
      const { reports } = await api('bug-report-list', {});
      host.innerHTML = reports.length ? `<div class="vendor-list">${reports.map(r => `
        <article class="card vendor">
          <div class="vendor-top"><div><h3>${esc(r.reporter || 'anonymous')}</h3>
          <div class="contact">${esc(stamp(r.created_at))}${r.page ? ' · ' + esc(r.page) : ''}${r.app_version ? ' · app ' + esc(r.app_version) : ''}</div></div></div>
          <p class="note">${esc(r.description)}</p>
          ${r.user_agent ? `<p class="note muted">${esc(r.user_agent)}</p>` : ''}
        </article>`).join('')}</div>`
        : '<div class="card empty-card">No problem reports yet. Reports from the “Report a problem” link land here (and in the organizer inbox email).</div>';
    } catch (e) {
      host.innerHTML = `<div class="card empty-card"><p><strong>Problem reports couldn't load.</strong></p><p class="muted">${esc(e.message)}</p></div>`;
    }
  };

  draw();
  loadBugs();
}

// --- Surveys ----------------------------------------------------------------------
export function renderSurveys(ctx, root) {
  root.innerHTML = `
    <p class="eyebrow">Setup</p>
    <h2 class="display">Surveys</h2>
    <p class="lede">What vendors told you after each market — ratings, what went well, and what to improve.</p>
    <div id="su-surveys"><div class="card empty-card">Loading survey results…</div></div>`;
  const host = root.querySelector('#su-surveys');
  (async () => {
    let rows;
    try { rows = await api('survey-report'); }
    catch (e) { host.innerHTML = `<div class="card empty-card"><p><strong>Surveys couldn't load.</strong></p><p class="muted">${esc(e.message)}</p></div>`; return; }
    const done = rows.filter(r => r.submitted_at);
    const avg = done.length ? (done.reduce((s, r) => s + Number(r.overall_rating || 0), 0) / done.length) : 0;
    const stars = n => n ? '★'.repeat(Math.round(Number(n))) + ' ' + Number(n) + '/5' : '—';
    host.innerHTML = `
      <p class="note"><strong>${done.length}</strong> response${done.length === 1 ? '' : 's'}${done.length ? ' · average overall ' + avg.toFixed(1) + '/5' : ''} · ${rows.length - done.length} awaiting a response.</p>
      <div class="vendor-list">${rows.map(r => `
        <article class="card vendor">
          <div class="vendor-top"><div><h3>${esc(r.business || r.vendor_name || 'Vendor')}</h3>
          <div class="contact">${esc(niceShort(r.date))} · ${esc(r.location || '')}</div></div>
          <span class="status ${r.submitted_at ? 'ok' : 'neutral'}">${r.submitted_at ? 'Responded' : 'Awaiting response'}</span></div>
          ${r.submitted_at ? `
          <div class="chips">
            <span class="status neutral">Overall ${esc(stars(r.overall_rating))}</span>
            <span class="status neutral">Communication ${esc(stars(r.communication_rating))}</span>
            <span class="status neutral">Venue ${esc(stars(r.venue_rating))}</span>
          </div>
          <p class="note">${r.traffic_rating ? '<strong>Traffic:</strong> ' + esc(r.traffic_rating) + '<br>' : ''}${r.sales_range ? '<strong>Sales:</strong> ' + esc(r.sales_range) + '<br>' : ''}${r.return_intent ? '<strong>Would return:</strong> ' + esc(r.return_intent) : ''}</p>
          ${r.went_well ? `<p class="note"><strong>Went well:</strong> ${esc(r.went_well)}</p>` : ''}
          ${r.improve ? `<p class="note"><strong>Improve:</strong> ${esc(r.improve)}</p>` : ''}
          ${r.testimonial_permission ? '<p class="note">✓ May be quoted as a testimonial</p>' : ''}` : ''}
        </article>`).join('') || '<div class="card empty-card">No surveys yet.</div>'}</div>`;
  })();
}

// --- Archived Events ------------------------------------------------------------------
let archView = { q: '', eventId: '' };
export function renderArchive(ctx, root) {
  const admin = () => ctx.state.admin;
  root.innerHTML = `
    <p class="eyebrow">Setup</p>
    <h2 class="display">Archived Events</h2>
    <p class="lede">Events move here automatically after their scheduled end time. Historical vendor and booking records are retained and searchable.</p>
    <div class="filter-card card">
      <div class="search"><input id="su-arch-q" type="search" placeholder="Vendor, business, email, phone, category, date or location" value="${esc(archView.q)}"></div>
      <label class="picker-label">Archived event<select id="su-arch-event" class="picker"></select></label>
    </div>
    <div id="su-arch-list"></div>`;

  function draw() {
    const a = admin();
    const upcomingIds = new Set((a.events || []).map(e => String(e.id)));
    const archived = (a.allEvents || []).filter(e => !upcomingIds.has(String(e.id)))
      .sort((x, y) => String(y.date).localeCompare(String(x.date)));
    const sel = root.querySelector('#su-arch-event');
    sel.innerHTML = '<option value="">All archived events</option>' + archived.map(e => `<option value="${esc(e.id)}" ${String(e.id) === archView.eventId ? 'selected' : ''}>${esc(nice(e.date))} — ${esc((a.locations || []).find(l => String(l.id) === String(e.location_id))?.name || e.title || '')}</option>`).join('');
    const rows = (a.applications || []).filter(b => archived.some(e => String(e.id) === String(b.event_id)));
    const q = archView.q.trim().toLowerCase();
    const found = rows.filter(b => (!archView.eventId || String(b.event_id) === archView.eventId)
      && (!q || [b.business, b.name, b.email, b.phone, b.category, b.date, b.location, b.space, b.status].some(v => String(v || '').toLowerCase().includes(q))));
    root.querySelector('#su-arch-list').innerHTML = `<div class="vendor-list">${found.map(b => `
      <article class="card vendor">
        <div class="vendor-top"><div><h3>${esc(b.business || b.name || 'Vendor')}</h3>
        <div class="contact">${esc(niceShort(b.date))} · ${esc(b.location || '')} · ${esc(b.space || '')}</div></div>
        <span class="status neutral">${esc(b.status)}</span></div>
        <p class="note"><strong>Booking ID:</strong> ${esc(b.id || '—')}<br>${esc(b.category || '')}<br>${esc(b.name || '')} · ${esc(b.email || '')} · ${esc(b.phone || '')}</p>
        <div class="vendor-actions"><button class="btn small" data-goto-directory>Find in Vendor Directory</button></div>
      </article>`).join('') || '<div class="card empty-card">No archived records match your search.</div>'}</div>`;
    root.querySelectorAll('[data-goto-directory]').forEach(b => b.onclick = () => ctx.navigate('directory'));
  }
  root.querySelector('#su-arch-q').oninput = e => { archView.q = e.target.value; draw(); };
  root.querySelector('#su-arch-event').onchange = e => { archView.eventId = e.target.value; draw(); };
  draw();
}

// --- Organizer Tools ---------------------------------------------------------------------
async function toolsCall(action, body) {
  const token = getToken();
  const r = await fetch('/.netlify/functions/organizer-tools?action=' + encodeURIComponent(action), {
    method: body === undefined ? 'GET' : 'POST',
    headers: { ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const v = await r.json().catch(() => ({}));
  if (!r.ok) throw Error(v.error || 'Please try again.');
  return v;
}

export function renderTools(ctx, root) {
  root.innerHTML = `
    <p class="eyebrow">Setup</p>
    <h2 class="display">Organizer Tools</h2>
    <p class="lede">Maintenance readouts: email delivery problems with one-tap retry, possible duplicate vendor records, and the recent activity log.</p>
    <div id="su-tools"><div class="card empty-card">Loading organizer tools…</div></div>`;
  const host = root.querySelector('#su-tools');
  const load = async () => {
    let d;
    try { d = await toolsCall('dashboard'); }
    catch (e) { host.innerHTML = `<div class="card empty-card"><p><strong>Organizer tools couldn't load.</strong></p><p class="muted">${esc(e.message)}</p></div>`; return; }
    const problemMail = (d.mail || []).filter(m => m.error || !m.sent_at);
    host.innerHTML = `
      <h3 class="section-title first">Email needing attention <span class="status ${problemMail.length ? 'warn' : 'ok'}">${problemMail.length}</span></h3>
      <div class="vendor-list">${problemMail.map(m => `
        <article class="card vendor">
          <div class="vendor-top"><div><h3>${esc(m.subject || '(no subject)')}</h3>
          <div class="contact">${esc(m.recipient || '')} · ${esc(stamp(m.created_at))}</div></div>
          <span class="status ${m.error ? 'bad' : 'warn'}">${m.error ? 'Failed' : 'Pending'}</span></div>
          ${m.error ? `<p class="note flag-note">${esc(m.error)}</p>` : ''}
          <div class="vendor-actions">${m.error ? `<button class="btn small" data-retry="${esc(m.id)}">Retry email</button>` : ''}</div>
        </article>`).join('') || '<div class="card empty-card">Every recent email has been delivered.</div>'}</div>
      <h3 class="section-title">Possible duplicate vendors <span class="status neutral">${(d.duplicates || []).length}</span></h3>
      <div class="vendor-list">${(d.duplicates || []).map(g => `
        <article class="card vendor"><h3>${esc(g.count)} records share contact details</h3>
        <p class="note">${(g.records || []).map(r => esc((r.business || r.name || 'Vendor') + ' (' + r.source + (r.email ? ' · ' + r.email : '') + ')')).join('<br>')}</p></article>`).join('') || '<div class="card empty-card">No duplicate vendor records found.</div>'}</div>
      <h3 class="section-title">Recent activity</h3>
      <div class="card content-card">${(d.changes || []).map(c => `
        <div class="mini-row"><span><strong>${esc(c.action)}</strong> · ${esc(c.actor || '')}<br><span class="muted">${esc(JSON.stringify(c.detail ?? {}).slice(0, 240))}</span></span><span class="muted">${esc(stamp(c.created_at))}</span></div>`).join('') || '<p class="note">No activity recorded yet.</p>'}</div>`;
    host.querySelectorAll('[data-retry]').forEach(b => b.onclick = async () => {
      try {
        await toolsCall('retry-email', { id: b.dataset.retry });
        ctx.toast('Email re-queued and sent.');
        load();
      } catch (e) { ctx.toast(e.message, true); }
    });
  };
  load();
}
