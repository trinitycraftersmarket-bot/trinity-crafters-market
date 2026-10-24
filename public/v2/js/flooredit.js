// Setup & Floor Plan — the ONE floor-plan editor in the rebuild
// (audit §13.9). It reads and writes the same store the read-only views
// render (market.floor_plan_areas via floor-area-plans /
// floor-area-plans-save / floor-area-plans-delete — the delete refuses
// while vendors are still assigned to the area) and resolves label
// positions through the shared
// math in floorplan.js — the editor, the Event Day view and both print
// paths can never disagree about where a vendor's name sits again.
//
// Ported from the legacy area manager at parity: venue-default layouts,
// the Hampton hallway special case, drag-to-place labels that save on
// drop, booth assignment with the "what they sell" aid, image upload /
// replace / reuse, optimistic-concurrency saves that merge another
// organizer's concurrent edits instead of overwriting them, the canvas
// composite print, and the setup instructions email. Native confirm()
// dialogs are replaced by the shared sheet system (§6.2).
import { api, esc, nice, clock, marketName } from './api.js?v=20261023-15';
import {
  imageAllowed, standardizeArea, spotId, spotIds, clampPct, vendorLabel,
  resolvePinPosition, resolvePins, fitPins, composePlanCanvas, printFloorPlan, printBoothList
} from './floorplan.js?v=20261023-15';

let view = { eventId: '' };
const clone = data => JSON.parse(JSON.stringify(data));
// One stable beforeunload guard for whichever editor is mounted: warns
// only while that editor has unsaved changes or a save in flight. A
// module-level handler (removed + re-added per mount) means SPA
// navigation can never stack stale guards from earlier mounts.
let feUnsaved = () => false;
const feWarnUnsaved = e => { if (feUnsaved()) { e.preventDefault(); e.returnValue = ''; } };

// --- venue defaults (ported from the legacy area manager) ----------------
function venueDefaults(event, locations) {
  const location = locations.find(x => x.id === event?.location_id);
  const name = String((location?.name || '') + ' ' + (location?.market_name || '') + ' ' + (event?.title || '')).toLowerCase();
  if (/hilton garden inn|lutz crafter/.test(name)) return [
    { area_key: 'main', title: 'Main Event Room', capacity: 21, space_type: 'indoor', prefix: 'MR' },
    { area_key: 'hallway1', title: 'Hallway 1', capacity: 5, space_type: 'indoor', prefix: 'H1' },
    { area_key: 'hallway2', title: 'Hallway 2', capacity: 3, space_type: 'indoor', prefix: 'H2' },
    { area_key: 'lobby', title: 'Lobby', capacity: 3, space_type: 'indoor', prefix: 'L' },
    { area_key: 'outside', title: 'Outside', capacity: 2, space_type: 'outdoor', prefix: 'OUT' }
  ];
  if (/hampton inn|odessa trinity/.test(name)) return [
    { area_key: 'main', title: 'Indoor Room', capacity: 9, space_type: 'indoor', prefix: 'HI' },
    { area_key: 'hallway', title: 'Hallway', capacity: 2, space_type: 'indoor', prefix: 'HW' }
  ];
  if (/trinity yoga|holistic experience/.test(name)) return [
    { area_key: 'studio', title: 'Yoga Studio', capacity: 8, space_type: 'indoor', prefix: 'YS' }
  ];
  return [
    { area_key: 'inside', title: 'Indoor Area', capacity: 9, space_type: 'indoor', prefix: 'IN' },
    { area_key: 'outside', title: 'Outdoor Area', capacity: 2, space_type: 'outdoor', prefix: 'OUT' }
  ];
}
function isHamptonEvent(event, locations) {
  const place = locations.find(x => x.id === event?.location_id);
  const name = String((place?.name || '') + ' ' + (event?.title || '')).toLowerCase();
  return /hampton inn|odessa trinity/.test(name) && !/hilton garden inn/.test(name);
}
const hamptonHallwayArea = () => ({ area_key: 'hallway', title: 'Hallway', capacity: 2, space_type: 'indoor', prefix: 'HW', image_data_url: '', assignments: {} });
function addHamptonHallway(areas, event, locations) {
  if (!isHamptonEvent(event, locations)) return areas;
  const hallway = areas.find(a => a.area_key === 'hallway');
  if (hallway) {
    if (hallway.capacity < 2) hallway.capacity = 2;
    return areas;
  }
  return [...areas, hamptonHallwayArea()];
}
const spaceOf = v => (['outside', 'outdoor'].includes(String(v.space || '').toLowerCase()) ? 'outdoor' : 'indoor');
const sells = v => String(v?.products || v?.category || 'Not specified').replace(/\s+/g, ' ').trim();
const sellerPreview = v => { const d = sells(v); return d.length > 85 ? d.slice(0, 82).trimEnd() + '…' : d; };

// Setup-instructions email template (ported from the legacy Setup panel).
function setupTemplate(event, location) {
  const brand = location?.market_name || event?.title || 'Crafters Market';
  const venue = location?.name || '', address = location?.address || '';
  const isTrinity = /trinity/i.test(brand);
  return `Hello Vendors,

Here are the setup instructions for ${brand}.

Location:
${venue}
${address}

Event Date: ${event ? nice(event.date) : '[Event Date]'}
Market Hours: ${event ? clock(event.start_time) : '10 AM'}–${event ? clock(event.end_time) : '3 PM'}

Setup begins as early as 8:30 AM. All vendors must be completely set up and ready by 9:45 AM. No vendors will be admitted for setup after 9:00 AM.

All vendors must remain set up until the market closes. Packing up early may result in being banned from future events.

${isTrinity ? `OUTSIDE VENDORS:
Please drive to the back of the hotel and set up on the patio, beginning with the portion of the patio closest to State Road 54. Patio furniture is already in place and is very heavy, so please do your best to set up around it. Weights, tents, tables, and chairs are mandatory for all outside vendors.

INSIDE VENDORS:
We will supply your tables and chairs through the end of this year. Please use your assigned space on the attached floor plan.` : `INSIDE VENDORS:
Please use your assigned space on the floor plan and follow any event-specific setup directions provided for the Hilton Garden Inn Suncoast.`}

IMPORTANT:
Please do not display or sell anything that you have not been approved for.

If you need to cancel for any reason, please email trinitycraftersmarket@gmail.com as soon as possible.

Thank you for helping us keep setup organized and the market enjoyable for our vendors and shoppers.

${brand}`;
}

export function renderFloorEditor(ctx, root, params = {}) {
  const admin = ctx.state.admin;
  const events = admin.events || [];
  const locations = admin.locations || [];
  if (!events.length) {
    root.innerHTML = '<p class="eyebrow">Market Day</p><h2 class="display">Setup &amp; Floor Plan</h2><p class="lede">No upcoming markets on the calendar yet. Add one under Setup → Dates &amp; Locations.</p>';
    return;
  }
  const event = events.find(e => String(e.id) === String(params.event || view.eventId)) || events[0];
  view.eventId = String(event.id);
  const location = locations.find(l => String(l.id) === String(event.location_id));

  root.innerHTML = `
    <p class="eyebrow">Market Day · ${esc(nice(event.date))}</p>
    <h2 class="display">Setup &amp; Floor Plan</h2>
    <p class="lede">Arrange booths for this market. Drag a vendor's name on the plan, or assign by booth number — positions save automatically and are exactly what the Event Day view and the printouts show.</p>
    <label class="picker-label">Market date
      <select id="fe-event" class="picker">${events.map(e => `<option value="${esc(e.id)}" ${String(e.id) === String(event.id) ? 'selected' : ''}>${esc(nice(e.date))} — ${esc(marketName(e))}</option>`).join('')}</select>
    </label>
    <div id="fe-body"><div class="card empty-card">Loading floor plans…</div></div>`;
  root.querySelector('#fe-event').onchange = e => ctx.navigate('flooredit', { event: e.target.value });

  const body = root.querySelector('#fe-body');
  const state = {
    eventId: String(event.id), areas: [], baseAreas: [], vendors: [], template: [],
    active: 0, selectedSpot: null, showNames: true, dirty: false, revision: 0, request: 0, statusMsg: ''
  };
  let saving = false;
  const current = () => state.areas[state.active];
  // The status line lives inside the re-rendered region, so the message is
  // kept on state and restored by render() — a save confirmation can never
  // be wiped by the re-render it triggers.
  const status = msg => { state.statusMsg = msg; const el = body.querySelector('#fe-status'); if (el) el.textContent = msg; };
  const markDirty = () => { state.dirty = true; state.revision++; status('Unsaved changes — saving now… Please wait for confirmation before refreshing.'); };
  feUnsaved = () => state.dirty || saving;
  window.removeEventListener('beforeunload', feWarnUnsaved);
  window.addEventListener('beforeunload', feWarnUnsaved);

  const confirmSheet = (title, text, confirmLabel, danger = false) => new Promise(resolve => {
    ctx.openSheet(`
      <h3 class="sheet-title">${esc(title)}</h3>
      <p class="note">${esc(text)}</p>
      <div class="sheet-actions">
        <button class="btn" id="fe-cf-no">Cancel</button>
        <button class="btn ${danger ? 'danger' : 'primary'}" id="fe-cf-yes">${esc(confirmLabel)}</button>
      </div>`);
    ctx.sheetEl.querySelector('#fe-cf-no').onclick = () => { ctx.closeSheet(); resolve(false); };
    ctx.sheetEl.querySelector('#fe-cf-yes').onclick = () => { ctx.closeSheet(); resolve(true); };
  });

  // --- saving (optimistic concurrency, ported from the legacy manager) ---
  const inputForSave = () => {
    const bases = new Map(state.baseAreas.map(a => [a.area_key, a]));
    return {
      event_id: state.eventId,
      areas: state.areas.map(a => ({ ...a, image_changed: (a.image_data_url || '') !== (bases.get(a.area_key)?.image_data_url || '') })),
      base_areas: state.baseAreas.map(a => ({ area_key: a.area_key, title: a.title, prefix: a.prefix, capacity: a.capacity, space_type: a.space_type, updated_at: a.updated_at, assignments: a.assignments }))
    };
  };
  function rebaseEdits(server, currentEdits, sent) {
    const sentByKey = new Map(sent.map(a => [a.area_key, a]));
    const latestByKey = new Map(server.map(a => [a.area_key, a]));
    for (const edited of currentEdits) {
      const sentArea = sentByKey.get(edited.area_key);
      const latest = latestByKey.get(edited.area_key);
      if (!latest) { latestByKey.set(edited.area_key, edited); continue; }
      if (!sentArea) continue;
      for (const [slot, entry] of Object.entries(edited.assignments || {})) {
        if (JSON.stringify(entry) !== JSON.stringify(sentArea.assignments?.[slot])) latest.assignments[slot] = entry;
      }
      if (edited.image_data_url !== sentArea.image_data_url) latest.image_data_url = edited.image_data_url;
    }
    return [...latestByKey.values()];
  }
  async function saveChanges() {
    if (saving || !state.eventId) return;
    saving = true;
    const eventId = state.eventId;
    const btn = body.querySelector('#fe-save');
    if (btn) btn.disabled = true;
    try {
      while (state.eventId === eventId && state.dirty) {
        const revision = state.revision;
        const payload = inputForSave();
        const sent = clone(state.areas);
        status('Saving shared booth assignments…');
        const result = await api('floor-area-plans-save', payload);
        if (state.eventId !== eventId) return;
        const server = result.areas.map(standardizeArea);
        if (state.revision === revision) {
          state.areas = clone(server);
          state.baseAreas = clone(server);
          state.dirty = false;
          const imageCount = server.filter(a => imageAllowed(a.image_data_url)).length;
          status('Saved to database ✓ ' + result.area_count + ' floor plan area(s), ' + imageCount + ' uploaded image(s). You can safely refresh now.');
          render();
          return;
        }
        const pending = clone(state.areas);
        state.baseAreas = clone(server);
        state.areas = rebaseEdits(clone(server), pending, sent);
      }
    } catch (error) {
      if (state.eventId === eventId) status('NOT SAVED — ' + error.message + ' Do not refresh until you retry Save changes or resolve the issue.');
    } finally {
      saving = false;
      const b2 = body.querySelector('#fe-save');
      if (b2) b2.disabled = false;
    }
  }

  // --- rendering -----------------------------------------------------------
  function choices(selected, area) {
    const assignedElsewhere = new Set(state.areas.flatMap(a => Object.values(a.assignments || {}).map(v => String(v.vendor_id || '')).filter(Boolean)));
    return '<option value="">Unassigned</option>' + state.vendors
      .filter(v => spaceOf(v) === area.space_type)
      .sort((a, b) => String(a.business || a.name || '').localeCompare(String(b.business || b.name || '')))
      .map(v => {
        const id = String(v.id), taken = assignedElsewhere.has(id) && id !== String(selected || '');
        const label = String(v.business || v.name || 'Unnamed vendor') + ' — Sells: ' + sellerPreview(v) + (taken ? ' (assigned elsewhere)' : '');
        return '<option value="' + esc(id) + '"' + (id === String(selected || '') ? ' selected' : '') + (taken ? ' disabled' : '') + '>' + esc(label) + '</option>';
      }).join('');
  }

  function renderPins(map) {
    const a = current();
    if (!a || !state.showNames) return;
    spotIds(a).forEach((id, i) => {
      const entry = a.assignments[id] || {};
      if (!entry.vendor_id) return;
      const vendor = state.vendors.find(v => String(v.id) === String(entry.vendor_id));
      if (!vendor) return;
      const pos = resolvePinPosition(a, i, entry);
      let x = pos.x, y = pos.y;
      const pin = document.createElement('button');
      pin.type = 'button';
      pin.className = 'fp-pin fe-pin';
      pin.style.left = x + '%';
      pin.style.top = y + '%';
      pin.textContent = String(vendor.business || vendor.name);
      pin.title = id + ' — drag to move ' + String(vendor.business || vendor.name);
      pin.setAttribute('aria-label', 'Drag ' + id + ' ' + String(vendor.business || vendor.name) + ' to reposition');
      let drag = null;
      pin.addEventListener('pointerdown', ev => {
        if (ev.button !== 0) return;
        ev.preventDefault();
        ev.stopPropagation();
        state.selectedSpot = id;
        drag = { pointerId: ev.pointerId, screenX: ev.clientX, screenY: ev.clientY, x: parseFloat(pin.style.left), y: parseFloat(pin.style.top), moved: false };
        pin.setPointerCapture(ev.pointerId);
        pin.style.cursor = 'grabbing';
        pin.style.zIndex = '30';
      });
      pin.addEventListener('pointermove', ev => {
        if (!drag || drag.pointerId !== ev.pointerId) return;
        ev.preventDefault();
        const bounds = map.getBoundingClientRect();
        if (!bounds.width || !bounds.height) return;
        const shiftX = ev.clientX - drag.screenX, shiftY = ev.clientY - drag.screenY;
        if (Math.hypot(shiftX, shiftY) > 3) drag.moved = true;
        const halfWidth = pin.offsetWidth ? pin.offsetWidth / bounds.width * 50 : 13;
        const halfHeight = pin.offsetHeight ? pin.offsetHeight / bounds.height * 50 : 3;
        const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
        pin.style.left = clamp(drag.x + shiftX / bounds.width * 100, halfWidth, 100 - halfWidth) + '%';
        pin.style.top = clamp(drag.y + shiftY / bounds.height * 100, halfHeight, 100 - halfHeight) + '%';
      });
      pin.addEventListener('pointerup', ev => {
        if (!drag || drag.pointerId !== ev.pointerId) return;
        ev.preventDefault();
        ev.stopPropagation();
        const moved = drag.moved;
        drag = null;
        pin.style.cursor = 'grab';
        pin.style.zIndex = '2';
        if (pin.hasPointerCapture(ev.pointerId)) pin.releasePointerCapture(ev.pointerId);
        if (moved) {
          const left = parseFloat(pin.style.left), top = parseFloat(pin.style.top);
          // The drag already kept the label's center inside its measured
          // half-extents; clampPct is the final 0–100 guard before save.
          a.assignments[id] = { ...a.assignments[id], x: +clampPct(left, left).toFixed(3), y: +clampPct(top, top).toFixed(3) };
          markDirty();
          render();
          void saveChanges();
        } else {
          render();
        }
      });
      pin.addEventListener('pointercancel', ev => {
        if (!drag || drag.pointerId !== ev.pointerId) return;
        drag = null;
        pin.style.left = x + '%';
        pin.style.top = y + '%';
        pin.style.zIndex = '2';
        pin.style.cursor = 'grab';
      });
      pin.addEventListener('click', ev => ev.stopPropagation());
      map.appendChild(pin);
    });
    fitPins(map);
  }

  function render() {
    const a = current();
    if (!a) return;
    const ids = spotIds(a);
    if (!ids.includes(state.selectedSpot)) state.selectedSpot = ids[0];
    const selected = state.selectedSpot, entry = a.assignments[selected] || {};
    const occupied = new Set(state.areas.flatMap(area => Object.values(area.assignments || {}).map(x => String(x.vendor_id || '')).filter(Boolean)));
    const overflow = state.vendors.filter(v => !occupied.has(String(v.id)));
    const assignedInArea = ids.filter(id => !!a.assignments[id]?.vendor_id).length;
    const selectedVendor = state.vendors.find(v => String(v.id) === String(entry.vendor_id || ''));
    const hampton = isHamptonEvent(event, locations);
    const spotAreas = hampton ? state.areas.filter(x => x.area_key === 'main' || x.area_key === 'hallway') : [a];
    const savedArea = state.baseAreas.some(x => x.area_key === a.area_key);

    body.querySelector('#fe-main').innerHTML = `
      <div class="vendor-actions fe-actions">
        <button class="btn primary small" id="fe-save">Save changes</button>
        <button class="btn small" id="fe-refresh">Refresh shared plans</button>
        <button class="btn small" id="fe-print-list">Print booth list</button>
        <button class="btn small" id="fe-print-plan">Print floor plan</button>
      </div>
      <p class="note" id="fe-status" role="status">${esc(state.statusMsg)}</p>
      <div class="filters" role="group" aria-label="Floor plan areas">
        ${state.areas.map((ar, i) => `<button class="chip-btn ${i === state.active ? 'active' : ''}" data-area="${i}">${esc(ar.title)} (${ar.capacity})</button>`).join('')}
      </div>
      <p class="note"><strong>${esc(a.title)}</strong> · ${assignedInArea} of ${a.capacity} booths assigned · ${esc(a.space_type)}${a.area_key === 'hallway' && hampton ? ' · Two separate hallway spots; keep exits and walking routes clear' : ''}</p>
      <section class="card fp-card"><div class="fp-map fe-map" id="fe-map"></div></section>
      <details class="card panel-details">
        <summary>${state.vendors.length} active vendors · ${occupied.size} assigned · ${overflow.length} waiting for a spot</summary>
        <div class="panel-body">${overflow.length
          ? `<p class="note"><strong>Unassigned / overflow</strong></p><p class="note">${overflow.map(v => esc(v.business || v.name || 'Vendor') + ' (' + esc(v.space || '') + ')').join(' · ')}</p><p class="note">Unassigned indoor: ${overflow.filter(v => spaceOf(v) === 'indoor').length}; outside: ${overflow.filter(v => spaceOf(v) === 'outdoor').length}. Booking and payment statuses are unchanged.</p>`
          : '<p class="note">Every active vendor has an assigned booth.</p>'}</div>
      </details>
      <section class="card fe-card">
        <h3 class="section-title first">Assign a booth</h3>
        <div class="filter-row">
          <label class="picker-label">Booth number<select id="fe-spot" class="picker">${spotAreas.map(area => `<optgroup label="${esc(area.title)} (${area.capacity} spots)">${spotIds(area).map(id => `<option value="${esc(id)}" ${id === selected ? 'selected' : ''}>${esc(id)}${area.assignments[id]?.vendor_id ? ' · Assigned' : ' · Open'}</option>`).join('')}</optgroup>`).join('')}</select></label>
          <label class="picker-label">Vendor — what they sell<select id="fe-vendor" class="picker">${choices(entry.vendor_id || '', a)}</select></label>
        </div>
        ${hampton ? '<p class="note">Choose HI-01–HI-09 for the room or HW-01 / HW-02 for the hallway. The floor-plan area changes automatically.</p>' : ''}
        <p class="note" id="fe-spot-info">${selectedVendor ? 'Currently: ' + esc(selectedVendor.business || selectedVendor.name) + ' at ' + esc(selected) + '.' : esc(selected) + ' is currently unassigned.'}</p>
        <p class="note">${selectedVendor ? '<strong>What they sell:</strong> ' + esc(sells(selectedVendor)) : 'Choose a vendor to see their products before assigning the booth.'}</p>
        <div class="vendor-actions">
          <button class="btn small danger" id="fe-remove" ${entry.vendor_id ? '' : 'disabled'}>Remove vendor from booth</button>
          <button class="btn small" id="fe-reset" ${entry.vendor_id && (entry.x != null && entry.y != null) ? '' : 'disabled'}>Reset name position</button>
          <label class="checkline select-line"><input type="checkbox" id="fe-toggle" ${state.showNames ? 'checked' : ''}> Show vendor names</label>
        </div>
        <p class="note">Press and drag any vendor name directly on the floor plan. Release it where you want it — the position saves automatically.</p>
      </section>
      <details class="card panel-details">
        <summary>View all ${a.capacity} booths (${assignedInArea} assigned)</summary>
        <div class="panel-body">${ids.map(id => {
          const v = state.vendors.find(x => String(x.id) === String(a.assignments[id]?.vendor_id || ''));
          return `<button type="button" class="mini-row fe-booth-row" data-open-spot="${esc(id)}"><strong>${esc(id)}</strong><span>${v ? esc(v.business || v.name) : 'Open'}</span></button>`;
        }).join('')}</div>
      </details>
      <details class="card panel-details">
        <summary>Area settings, image &amp; layout reuse</summary>
        <div class="panel-body">
          <p class="note"><strong>${esc(a.title)}</strong> · prefix ${esc(a.prefix)} · ${a.capacity} booths · ${esc(a.space_type)} · ${savedArea ? 'saved for this event' : 'not saved yet — it will be created when you save'}</p>
          <div class="vendor-actions">
            <button class="btn small" id="fe-area-edit">Edit area settings</button>
            <button class="btn small" id="fe-area-add">Add new area</button>
            ${savedArea ? '<button class="btn small danger" id="fe-area-delete">Delete saved area</button>' : '<button class="btn small danger" id="fe-area-remove">Remove this unsaved area</button>'}
          </div>
          <div class="vendor-actions">
            <label class="btn small" for="fe-upload">Upload room image (PNG, JPG or WebP)</label>
            <input id="fe-upload" type="file" accept="image/png,image/jpeg,image/webp" hidden>
            <button class="btn small" id="fe-download" ${imageAllowed(a.image_data_url) ? '' : 'disabled'}>Download floor plan with names</button>
            <button class="btn small" id="fe-reuse" ${state.template.length ? '' : 'disabled'}>Reuse prior venue layouts</button>
            <button class="btn small danger" id="fe-clear" ${a.image_data_url ? '' : 'disabled'}>Remove this image</button>
          </div>
          <p class="note">Changing an image does not remove vendor assignments. Reusing a prior layout does reset assignments, after confirmation. A saved area can be deleted once no vendors are assigned to its booths; a new area can be removed until its first save.</p>
        </div>
      </details>`;

    // Map + pins
    const map = body.querySelector('#fe-map');
    if (imageAllowed(a.image_data_url)) {
      map.innerHTML = `<img class="fp-img" alt="Uploaded venue floor plan" src="${a.image_data_url}">`;
    } else {
      map.innerHTML = `<div class="fe-placeholder">${a.area_key === 'hallway' && hampton
        ? 'Hampton Hallway — select HW-01 and choose an indoor vendor below. An image is optional. Keep entrances and emergency exits clear.'
        : 'No floor plan image uploaded for ' + esc(a.title) + '. Open “Area settings, image &amp; layout reuse” to add one.'}</div>`;
    }
    renderPins(map);
    const img = map.querySelector('img.fp-img');
    if (img && !img.complete) img.addEventListener('load', () => fitPins(map));

    // Bindings
    const q = sel => body.querySelector(sel);
    q('#fe-save').onclick = () => { void saveChanges(); };
    q('#fe-refresh').onclick = async () => {
      if (state.dirty && !(await confirmSheet('Discard unsaved changes?', 'Refreshing will discard only your local, unsaved changes. Saved plans are shared and stay as they are.', 'Refresh anyway'))) return;
      void load();
    };
    q('#fe-print-list').onclick = () => printBoothList({ event, venue: location, areas: state.areas, vendors: state.vendors, dirty: state.dirty, toast: ctx.toast });
    q('#fe-print-plan').onclick = () => { void printFloorPlan({ event, area: current(), areas: state.areas, vendors: state.vendors, toast: ctx.toast }); };
    body.querySelectorAll('[data-area]').forEach(b => b.onclick = () => { state.active = Number(b.dataset.area) || 0; state.selectedSpot = null; render(); });
    q('#fe-spot').onchange = e => {
      const id = e.target.value;
      const index = state.areas.findIndex(area => spotIds(area).includes(id));
      if (index >= 0) state.active = index;
      state.selectedSpot = id;
      render();
    };
    q('#fe-vendor').onchange = e => {
      const newId = e.target.value;
      if (newId && state.areas.some(area => Object.entries(area.assignments || {}).some(([key, v]) => !(area === a && key === selected) && String(v.vendor_id || '') === newId))) {
        ctx.toast('That vendor is already assigned to another booth.', true);
        render();
        return;
      }
      if (String(a.assignments[selected]?.vendor_id || '') === String(newId || '')) return;
      // Moving a booth to a different person also removes the former
      // person's label coordinates, so the new vendor starts fresh.
      a.assignments[selected] = { vendor_id: newId };
      markDirty();
      render();
      void saveChanges();
    };
    q('#fe-remove').onclick = async () => {
      const ent = a.assignments?.[selected];
      if (!ent?.vendor_id) return;
      const name = String(vendorLabel(state.vendors, ent.vendor_id) || 'this vendor');
      if (!(await confirmSheet('Remove ' + name + ' from booth ' + selected + '?', 'This only removes the booth assignment. Their event booking and payment remain unchanged.', 'Remove vendor', true))) return;
      a.assignments[selected] = { vendor_id: '' };
      markDirty();
      render();
      void saveChanges();
    };
    q('#fe-reset').onclick = () => {
      const ent = a.assignments[selected];
      if (!ent || ent.x == null || ent.y == null) return;
      const { x, y, ...rest } = ent;
      a.assignments[selected] = rest;
      markDirty();
      render();
      void saveChanges();
    };
    q('#fe-toggle').onchange = e => { state.showNames = e.target.checked; render(); };
    body.querySelectorAll('[data-open-spot]').forEach(el => el.onclick = () => {
      state.selectedSpot = el.dataset.openSpot;
      render();
      body.querySelector('.fe-card')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
    q('#fe-area-edit').onclick = () => areaSettingsSheet(a, false);
    q('#fe-area-add').onclick = () => areaSettingsSheet(null, true);
    const removeBtn = q('#fe-area-remove');
    if (removeBtn) removeBtn.onclick = () => {
      state.areas.splice(state.active, 1);
      state.active = 0;
      state.selectedSpot = null;
      render();
    };
    const deleteBtn = q('#fe-area-delete');
    if (deleteBtn) deleteBtn.onclick = async () => {
      // Delete acts on the SAVED row; with unsaved changes pending, the
      // editor state and the stored area may disagree (and a pending
      // autosave could re-create the area), so require a clean state.
      if (state.dirty) { ctx.toast('Save or discard your changes before deleting an area.', true); return; }
      if (!(await confirmSheet('Delete ' + a.title + '?', 'This permanently deletes the saved "' + a.title + '" floor plan for this market date, including its image. It cannot be undone.', 'Delete area', true))) return;
      try {
        await api('floor-area-plans-delete', { event_id: state.eventId, area_key: a.area_key });
        ctx.toast('Deleted ' + a.title + '.');
        await load();
      } catch (e) { ctx.toast(e.message, true); } // a server refusal (vendors still assigned) shows its reason
    };
    q('#fe-upload').onchange = onUpload;
    q('#fe-clear').onclick = async () => {
      if (!a.image_data_url) return;
      if (!(await confirmSheet('Remove this area image?', 'Existing vendor assignments for ' + a.title + ' will remain.', 'Remove image', true))) return;
      a.image_data_url = '';
      markDirty();
      render();
      void saveChanges();
    };
    q('#fe-reuse').onclick = async () => {
      if (!state.template.length) return;
      if (!(await confirmSheet('Reuse prior venue layouts?', 'Copy the latest venue layouts and images into this event? Vendor assignments will be cleared.', 'Reuse layouts', true))) return;
      state.areas = addHamptonHallway(state.template.map(t => standardizeArea({ ...t, assignments: {} })), event, locations);
      state.active = 0;
      state.selectedSpot = null;
      state.showNames = true;
      markDirty();
      render();
      void saveChanges();
    };
    q('#fe-download').onclick = onDownload;
  }

  // --- area settings (rename / resize / re-prefix / create) ----------------
  function areaSettingsSheet(area, isNew) {
    const highestAssigned = area ? spotIds(area).reduce((m, id, i) => (area.assignments[id]?.vendor_id ? Math.max(m, i + 1) : m), 0) : 0;
    ctx.openSheet(`
      <h3 class="sheet-title">${isNew ? 'Add floor plan area' : 'Area settings — ' + esc(area.title)}</h3>
      <form id="fe-area-form">
        <label class="sheet-field">Area name<input name="title" required maxlength="100" value="${esc(area?.title || '')}" placeholder="Main Event Room"></label>
        <div class="sheet-grid">
          <label class="sheet-field">Booth prefix<input name="prefix" required maxlength="12" value="${esc(area?.prefix || '')}" placeholder="MR"></label>
          <label class="sheet-field">Booths (capacity)<input name="capacity" type="number" min="${Math.max(1, highestAssigned)}" max="100" required value="${area?.capacity ?? 9}"></label>
        </div>
        <label class="sheet-field">Space type<select name="space_type">
          <option value="indoor" ${area?.space_type !== 'outdoor' ? 'selected' : ''}>Indoor</option>
          <option value="outdoor" ${area?.space_type === 'outdoor' ? 'selected' : ''}>Outdoor</option>
        </select></label>
        ${highestAssigned ? `<p class="note">Capacity can't go below ${highestAssigned} — booths up to ${esc(spotId(area, highestAssigned - 1))} are assigned. Unassign those vendors first to shrink further.</p>` : ''}
        <p class="note flag-note" data-area-msg hidden></p>
        <div class="sheet-actions"><button type="button" class="btn" data-sheet-close>Cancel</button><button class="btn primary">${isNew ? 'Add area' : 'Save settings'}</button></div>
      </form>`);
    ctx.sheetEl.querySelector('#fe-area-form').onsubmit = e => {
      e.preventDefault();
      const f = new FormData(e.target);
      const msg = ctx.sheetEl.querySelector('[data-area-msg]');
      const fail = m => { msg.hidden = false; msg.textContent = m; };
      const title = String(f.get('title') || '').trim();
      const prefix = String(f.get('prefix') || '').trim().toUpperCase();
      const capacity = Number(f.get('capacity'));
      const spaceType = String(f.get('space_type'));
      if (!title) return fail('Give the area a name.');
      if (!/^[A-Z0-9]{1,12}$/.test(prefix)) return fail('Prefix must be 1–12 letters or numbers (it builds booth numbers like ' + (prefix || 'MR') + '-01).');
      if (!Number.isInteger(capacity) || capacity < 1 || capacity > 100) return fail('Capacity must be a whole number from 1 to 100.');
      if (capacity < highestAssigned) return fail('Capacity can\'t go below ' + highestAssigned + ' while booths are assigned.');
      if (state.areas.some(x => x !== area && x.prefix === prefix)) return fail('Another area already uses the prefix ' + prefix + '.');
      if (area && spaceType !== area.space_type) {
        const mismatched = spotIds(area).filter(id => {
          const vid = area.assignments[id]?.vendor_id;
          const v = vid ? state.vendors.find(x => String(x.id) === String(vid)) : null;
          return v && spaceOf(v) !== spaceType;
        }).length;
        if (mismatched) return fail(mismatched + ' assigned vendor(s) are ' + area.space_type + ' vendors. Unassign them before changing this area to ' + spaceType + '.');
      }
      ctx.closeSheet();
      if (isNew) {
        let key = prefix.toLowerCase(), n = 2;
        while (state.areas.some(x => x.area_key === key)) key = prefix.toLowerCase() + '-' + (n++);
        state.areas.push({ area_key: key, title, prefix, capacity, space_type: spaceType, image_data_url: '', assignments: {} });
        state.active = state.areas.length - 1;
        state.selectedSpot = null;
      } else {
        if (prefix !== area.prefix) {
          // Booth numbers derive from the prefix — re-key the saved
          // positions by booth index so nobody's label is lost.
          const remapped = {};
          spotIds(area).forEach((oldId, i) => { if (area.assignments[oldId]) remapped[prefix + '-' + String(i + 1).padStart(2, '0')] = area.assignments[oldId]; });
          area.assignments = remapped;
        }
        area.title = title;
        area.prefix = prefix;
        area.capacity = capacity;
        area.space_type = spaceType;
      }
      markDirty();
      render();
      void saveChanges();
    };
  }

  // --- image upload / download (ported pipelines) ---------------------------
  async function onUpload(e) {
    const file = e.target.files?.[0], a = current();
    if (!file || !a) return;
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) { ctx.toast('Please choose PNG, JPG or WebP.', true); return; }
    if (file.size > 14000000) { ctx.toast('Image exceeds 14 MB. Please reduce its size.', true); return; }
    try {
      const url = await new Promise((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(r.result); r.onerror = reject; r.readAsDataURL(file); });
      const img = await new Promise((resolve, reject) => { const x = new Image(); x.onload = () => resolve(x); x.onerror = reject; x.src = url; });
      const factor = Math.min(1, 1700 / Math.max(img.width, img.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(img.width * factor);
      canvas.height = Math.round(img.height * factor);
      const c2 = canvas.getContext('2d');
      c2.fillStyle = '#ffffff';
      c2.fillRect(0, 0, canvas.width, canvas.height);
      c2.drawImage(img, 0, 0, canvas.width, canvas.height);
      let output = canvas.toDataURL('image/jpeg', 0.83);
      if (output.length > 2800000) output = canvas.toDataURL('image/jpeg', 0.67);
      if (output.length > 2800000) throw Error('Image is still too large after resizing. Please use a smaller source image.');
      a.image_data_url = output;
      markDirty();
      render();
      void saveChanges();
    } catch (error) { ctx.toast('Image upload failed: ' + error.message, true); }
    e.target.value = '';
  }
  async function onDownload() {
    const area = current();
    if (!area || !imageAllowed(area.image_data_url)) { ctx.toast('Upload and save a floor plan image before downloading.', true); return; }
    // Never hand over a silently nameless image: when vendors are
    // assigned to spots but not one name resolves against the attendee
    // list, the composed file would be the bare layout — say so instead.
    const assigned = Object.values(area.assignments || {}).some(e => e && e.vendor_id);
    if (assigned && !resolvePins(area, state.vendors).length) {
      ctx.toast('Vendor names could not be matched to the spots on this plan, so no file was downloaded. Reload the editor and try again.', true);
      return;
    }
    try {
      const canvas = await composePlanCanvas(area, state.vendors);
      const blob = await new Promise(res => canvas.toBlob(res, 'image/png'));
      if (!blob) throw Error('Could not prepare the exported image.');
      const href = URL.createObjectURL(blob), link = document.createElement('a');
      link.href = href;
      link.download = String(event.date || 'Event') + '-' + String(area.title || 'Floor-Plan').replace(/[^a-z0-9]+/gi, '-') + '-With-Vendors.png';
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(href), 15000);
      ctx.toast('Downloaded the floor plan with vendor names.');
    } catch (error) { ctx.toast('Image download failed: ' + error.message, true); }
  }

  // --- setup instructions email (built once per event load) ------------------
  // Compose every area's COMPLETED floor plan — the saved layout image
  // with each assigned vendor's name pinned at their spot, drawn by the
  // same shared composer as Download and Print — as JPEG at the upload
  // pipeline's quality steps and size ceiling. The setup email attaches
  // these named plans (the server cannot draw names itself; it falls
  // back to the saved raw image for any area missing here).
  async function composeAreaImages() {
    const images = {};
    for (const a of state.areas) {
      if (!imageAllowed(a.image_data_url)) continue;
      try {
        const canvas = await composePlanCanvas(a, state.vendors);
        let url = canvas.toDataURL('image/jpeg', 0.83);
        if (url.length > 2800000) url = canvas.toDataURL('image/jpeg', 0.67);
        if (url.length <= 2800000) images[a.area_key] = url;
      } catch { /* omitted on purpose: the server falls back to the saved image */ }
    }
    return images;
  }

  function renderEmail() {
    const host = body.querySelector('#fe-email');
    if (!host) return;
    // Owner ruling Oct 22, 2026: floor plans are shareable at EVERY venue
    // (the Hampton/Trinity-Yoga-only restriction was lifted, Hilton included).
    const canShare = true;
    host.innerHTML = `
      <h3 class="section-title first">Setup instructions email</h3>
      <p class="note">Floor plan sharing is permitted for this venue. You may uncheck the attachment option before sending.</p>
      <label class="sheet-field">Email subject<input id="fe-subject" value="${esc((location?.market_name || event.title || 'Crafters Market') + ' Setup Instructions — ' + nice(event.date))}"></label>
      <label class="sheet-field">Setup instructions<textarea id="fe-body-text" rows="16">${esc(setupTemplate(event, location))}</textarea></label>
      <label class="checkline"><input type="checkbox" id="fe-attach" ${canShare ? 'checked' : 'disabled'}> Attach the completed floor plan (with vendor names) for each vendor's assigned area</label>
      <div class="vendor-actions"><button class="btn primary small" id="fe-send">${canShare ? 'Send Setup Instructions + Floor Plan' : 'Send Setup Instructions (no floor plans)'}</button><button class="btn small" id="fe-send-test">Send test email</button></div>
      <p class="note">${event.setup_sent_at ? 'Setup email already sent for this market on ' + esc(new Date(event.setup_sent_at).toLocaleString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })) + '. Sending again re-emails every active vendor.' : 'Not sent yet for this market.'}</p>`;
    const sendBtn = host.querySelector('#fe-send'), testBtn = host.querySelector('#fe-send-test');
    const readForm = () => ({
      subject: host.querySelector('#fe-subject').value.trim(),
      text: host.querySelector('#fe-body-text').value.trim(),
      attach: host.querySelector('#fe-attach').checked && canShare
    });
    const setBusy = busy => { sendBtn.disabled = busy; testBtn.disabled = busy; };
    sendBtn.onclick = async () => {
      const { subject, text, attach } = readForm();
      if (!subject || !text) { ctx.toast('Subject and email message are required.', true); return; }
      if (!(await confirmSheet('Send setup instructions?', 'This emails every active vendor for ' + nice(event.date) + (attach ? ', with the completed floor plan (vendor names included) for their assigned area attached.' : ', without floor plan attachments.'), 'Send email'))) return;
      setBusy(true);
      try {
        const r = await api('setup-email', { event_id: state.eventId, subject, body: text, attach_floor_plan: attach, area_images: attach ? await composeAreaImages() : {} });
        ctx.toast(r.failed_count
          ? 'Setup email queued for ' + r.count + ' vendors — ' + r.failed_count + ' failed to send. Check Connections for details.'
          : 'Setup instructions sent to ' + r.count + ' vendor email(s)' + (r.attachment_count ? ' · ' + r.attachment_count + ' floor plan attachment(s)' : '') + '.');
        await ctx.refreshAdmin();
      } catch (e) { ctx.toast(e.message, true); }
      finally { setBusy(false); }
    };
    testBtn.onclick = async () => {
      const { subject, text, attach } = readForm();
      if (!subject || !text) { ctx.toast('Subject and email message are required.', true); return; }
      setBusy(true);
      const oldLabel = testBtn.textContent;
      testBtn.textContent = 'Sending test…';
      try {
        const r = await api('setup-email', { event_id: state.eventId, subject, body: text, attach_floor_plan: attach, area_images: attach ? await composeAreaImages() : {}, test: true });
        ctx.toast('Test setup email sent to ' + (r.sent_to || 'your email address') + ' with ' + (r.attachment_count || 0) + ' floor plan attachment(s). No vendors were emailed.');
      } catch (e) { ctx.toast(e.message, true); }
      finally { setBusy(false); testBtn.textContent = oldLabel; }
    };
  }

  // --- load -------------------------------------------------------------------
  async function load() {
    const serial = ++state.request;
    body.innerHTML = '<div class="card empty-card">Loading floor plans…</div>';
    try {
      const [result, rows] = await Promise.all([
        api('floor-area-plans', undefined, { event_id: state.eventId }),
        api('floor-attendees', undefined, { event_id: state.eventId })
      ]);
      if (serial !== state.request) return;
      state.vendors = rows || [];
      state.template = (result.template || []).map(standardizeArea);
      state.areas = addHamptonHallway((result.areas && result.areas.length ? result.areas : venueDefaults(event, locations)).map(standardizeArea), event, locations);
      state.baseAreas = clone((result.areas || []).map(standardizeArea));
      state.active = 0;
      state.selectedSpot = null;
      state.showNames = true;
      state.dirty = false;
      state.revision = 0;
      body.innerHTML = '<div id="fe-main"></div><section class="card fe-card" id="fe-email"></section>';
      render();
      renderEmail();
      status(result.areas?.length ? 'Loaded saved floor plans for this event.' : 'New event layouts prepared. Upload images and save to keep these plans for this event.');
    } catch (e) {
      if (serial !== state.request) return;
      body.innerHTML = `<div class="card empty-card"><p><strong>Floor plans couldn't load.</strong></p><p class="muted">${esc(e.message)}</p><p class="muted">The editor needs the floor plans permission (organizers have it automatically). Nothing was changed.</p></div>`;
    }
  }

  load();
}
