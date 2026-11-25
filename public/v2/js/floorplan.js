// THE floor-plan module for the v2 app — the single implementation the
// rebuild rule demands (audit §13.9: exactly ONE floor plan implementation
// and ONE store; print renders the same resolved positions as the editor).
//
// The store is market.floor_plan_areas, read via the floor-area-plans
// action and written via floor-area-plans-save — the same rows the legacy
// area manager used. The legacy app's second store (events.floor_plan,
// inside the old app.js editor) is deliberately not read or written here.
//
// Everything that turns saved data into on-screen positions lives in this
// file and nowhere else: per-spot saved x/y percentages win, known venue
// layouts fall back to their label tables, coordinates clamp into 0–100
// at resolve time (and again server-side at save), stacked labels cascade
// apart so every assigned vendor renders, and a post-layout fit pass
// pulls each whole label inside the image. The Event Day read-only view,
// the booth editor (flooredit.js) and both print paths all resolve pins
// through resolvePins() below — there is no second copy of this math.
import { api, esc, nice } from './api.js?v=20261125-94';

export const imageAllowed = url => typeof url === 'string' && /^data:image\/(png|jpeg|webp);base64,/.test(url);
export const standardizeArea = area => ({ ...area, assignments: area.assignments && typeof area.assignments === 'object' ? area.assignments : {}, image_data_url: area.image_data_url || '' });
export const spotId = (area, i) => String(area.prefix || area.area_key.toUpperCase()) + '-' + String(i + 1).padStart(2, '0');
// §86 (Scott, Nov 24, 2026): the Hilton Garden Inn numbers its booths
// continuously through the rooms — Main Room 1–21, Hallway 1 is 23–27,
// Hallway 2 is 28–30 — so a bare H1-01 means nothing in the real room.
// Storage keys stay H1-01… (the server's save/validation is built on
// them); spotLabel() is the ONLY number a person ever reads, on the
// reports, the plan tags, and the booth lists.
export const SPOT_LABEL_START = { H1: 23, H2: 28 };
export function spotLabel(id) {
  const m = /^([A-Z]+[0-9]*)-(\d+)$/.exec(String(id || ''));
  if (!m) return String(id || '');
  const start = SPOT_LABEL_START[m[1]];
  if (!start) return String(id);
  return m[1] + '-' + String(start + Number(m[2]) - 1).padStart(2, '0');
}
export const spotIds = area => Array.from({ length: area.capacity }, (_, i) => spotId(area, i));

const gridPosition = (a, i) => {
  const rows = Math.ceil(a.capacity / 2), col = i < rows ? 0 : 1, row = col ? i - rows : i;
  return { x: col ? 76 : 24, y: 12 + Math.max(0, row) * 76 / Math.max(1, rows - 1) };
};
// Label anchor tables for the known venue graphics (percentages of the
// full uploaded graphic, matching the legacy area manager's tables).
const mainRoomLabels = {
  1: [85, 62], 2: [86, 49.5], 3: [86, 37.5], 4: [86, 24.5],
  5: [65, 16], 6: [32, 21], 7: [56, 31], 8: [51, 49],
  9: [55, 65], 10: [59, 85.5], 11: [68, 86.5], 12: [28, 86.5],
  13: [44, 76.3], 14: [46, 66], 15: [46, 49.5], 16: [43, 30.2],
  17: [12, 33.5], 18: [12, 46], 19: [12, 58], 20: [12, 69], 21: [12, 82]
};
export function autoLabelPosition(area, index) {
  if (area.prefix === 'MR' && area.capacity === 21) {
    const p = mainRoomLabels[index + 1]; if (p) return { x: p[0], y: p[1] };
  }
  if (area.prefix === 'H1' && area.capacity === 5)
    return { x: 55, y: [89, 74, 59, 42, 27][index] };
  if (area.prefix === 'H2' && area.capacity === 3)
    return { x: 43, y: [84, 56, 29][index] };
  if (area.prefix === 'HI' && area.capacity === 9) {
    const p = [[50, 22], [28, 38], [74, 38], [27, 53], [74, 53], [27, 68], [74, 68], [24, 89], [58, 89]][index];
    if (p) return { x: p[0], y: p[1] };
  }
  return gridPosition(area, index);
}
// Coordinates clamp into the plan instead of being dropped: dropping an
// out-of-range value silently teleported the vendor's label back to its
// default spot, which read as "the plan doesn't keep my cards" (§13.9).
export const clampPct = (v, f) => { const n = Number(v); return v != null && Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : f; };

// An assignment's vendor_id is normally the floor-attendees ROW id
// (booking id / imported-attendee id). The attendee rows carry a second
// id space, though — the master vendor id (row.vendor_id) — and any
// assignment recorded against that space must resolve too: a lookup
// that only tries the row id silently drops the pin, and the vendor's
// name vanishes from the on-screen plan, the print, the Download image
// and the setup email alike. Exact row-id match wins; the master-id
// match is the fallback (ids are UUIDs from disjoint tables, so the
// two spaces can never collide in practice).
export const vendorLabel = (vendors, id) => {
  if (id == null || id === '') return null;
  const key = String(id);
  const v = (vendors || []).find(x => String(x.id) === key)
    || (vendors || []).find(x => x.vendor_id != null && String(x.vendor_id) === key);
  return v ? String(v.business || v.name || 'Vendor') : null;
};

// Resolve one spot's label position: saved x/y (clamped) win, the venue
// label table is the fallback.
export function resolvePinPosition(area, index, entry) {
  const fallback = autoLabelPosition(area, index);
  return { x: clampPct(entry?.x, fallback.x), y: clampPct(entry?.y, fallback.y) };
}

// Resolve every assigned vendor in an area to a pin: [{spot, index,
// vendorId, label, x, y}]. Pins that resolve to the same point (duplicate
// saved positions, identical fallbacks) cascade diagonally so no vendor
// is ever hidden underneath another's label — every assigned vendor
// renders, in the editor, the read-only views and print alike.
export function resolvePins(area, vendors) {
  const used = new Map();
  const pins = [];
  spotIds(area).forEach((id, i) => {
    const entry = area.assignments[id] || {};
    if (!entry.vendor_id) return;
    const label = vendorLabel(vendors, entry.vendor_id);
    if (!label) return;
    let { x, y } = resolvePinPosition(area, i, entry);
    let key = Math.round(x) + ',' + Math.round(y);
    let n = 0;
    while (used.has(key) && n < 12) {
      n++;
      x = Math.min(96, x + 4.5);
      y = Math.min(96, y + 4.5);
      key = Math.round(x) + ',' + Math.round(y);
    }
    used.set(key, id);
    pins.push({ spot: id, spotLabel: spotLabel(id), index: i, vendorId: String(entry.vendor_id), label, x, y });
  });
  return pins;
}

// Fit pass: once the browser knows real pixel sizes, pull each label's
// center back so the whole card sits inside the plan. Without this, a
// label centered at left:100% collapses into a one-character-wide strip.
export function fitPins(root) {
  if (!root) return;
  const maps = [...root.querySelectorAll('.fp-map')];
  if (root.classList?.contains('fp-map')) maps.unshift(root);
  maps.forEach(map => {
    const mw = map.clientWidth, mh = map.clientHeight;
    if (!mw || !mh) return;
    map.querySelectorAll('.fp-pin').forEach(pin => {
      const pw = pin.offsetWidth, ph = pin.offsetHeight;
      if (!pw || !ph) return;
      const hw = pw / mw * 50, hh = ph / mh * 50;
      const x = parseFloat(pin.style.left), y = parseFloat(pin.style.top);
      if (Number.isFinite(x)) pin.style.left = Math.max(hw, Math.min(100 - hw, x)) + '%';
      if (Number.isFinite(y)) pin.style.top = Math.max(hh, Math.min(100 - hh, y)) + '%';
    });
  });
}

// --- read-only renderer (Event Day) --------------------------------------
// Renders the event's saved areas into `host` from fresh server data on
// every call. Display only: pins are pointer-events:none spans.
export async function renderSavedFloorPlan(host, eventId) {
  if (!host || !eventId) return;
  const serial = (host._fpSerial = (host._fpSerial || 0) + 1);
  const stale = () => host._fpSerial !== serial;
  host.innerHTML = '<p class="muted">Loading saved floor plan…</p>';
  try {
    const [result, rows] = await Promise.all([
      api('floor-area-plans', undefined, { event_id: eventId }),
      api('floor-attendees', undefined, { event_id: eventId })
    ]);
    if (stale()) return;
    const vendors = rows || [];
    const areas = (result.areas || []).map(standardizeArea).filter(area => {
      const assigned = Object.values(area.assignments || {}).some(e => e && e.vendor_id);
      return imageAllowed(area.image_data_url) || assigned;
    });
    if (!areas.length) {
      host.innerHTML = '<p class="muted">No floor plan saved for this market yet. Booth assignments made in the floor plan editor will appear here.</p>';
      return;
    }
    host.innerHTML = areas.map(area => {
      const filled = spotIds(area).filter(id => !!area.assignments[id]?.vendor_id).length;
      const head = '<h3 class="fp-title">' + esc(area.title) + ' <span class="status neutral">' + filled + ' of ' + area.capacity + ' assigned</span></h3>';
      if (imageAllowed(area.image_data_url)) {
        const pins = resolvePins(area, vendors).map(p =>
          '<span class="fp-pin" style="left:' + p.x + '%;top:' + p.y + '%">' + esc(p.label) + '<span class="pin-spot">' + esc(p.spotLabel) + '</span></span>').join('');
        return head + '<div class="fp-map"><img class="fp-img" alt="Saved floor plan for ' + esc(area.title) + '" src="' + area.image_data_url + '">' + pins + '</div>';
      }
      const boothRows = spotIds(area).map(id => {
        const entry = area.assignments[id] || {};
        const label = entry.vendor_id ? vendorLabel(vendors, entry.vendor_id) : null;
        return '<div class="fp-booth"><strong>' + esc(id) + '</strong><span>' + (label ? esc(label) : '<span class="muted">Open</span>') + '</span></div>';
      }).join('');
      return head + '<div class="fp-booths">' + boothRows + '</div>';
    }).join('');
    fitPins(host);
    host.querySelectorAll('img.fp-img').forEach(img => {
      if (!img.complete) img.addEventListener('load', () => { if (!stale()) fitPins(host); });
    });
  } catch (e) {
    if (stale()) return;
    host.innerHTML = '<p class="muted">Floor plan could not be loaded. (' + esc(e.message) + ')</p>';
  }
}

// --- vendor view: "Where will you be" -------------------------------------
// Multi-area events (owner decision, Oct 22 eve — from the Nov 28 market
// onward an event can have NUMEROUS floor_plan_areas): this renderer
// iterates ALL of the event's areas. The vendor lands on the area that
// holds their own booth, shown with that area's ORIGINAL uploaded layout
// image — never a drawn schematic — with every pin resolved through the
// same resolvePins() math and their own pin highlighted. A chip row
// switches to the event's other area plans. Areas without an uploaded
// image fall back to that area's booth list, with the vendor's own booth
// row highlighted. Matching: an assignment's vendor_id is the
// attendee row id, which is the same id the vendor's own `mine` row
// carries (booking id / imported id); assignments recorded against the
// master vendor id resolve too — the server keys vendor_names by both
// id spaces (§31). Pin labels come from that vendor_names map, never
// from the staff-only floor-attendees payload.
// §73 (Scott, Nov 18, 2026): the printed reports carry a legend for the
// booth-code prefixes — "MR = Main Event Room" and so on — derived from
// the event's own areas so it always matches the codes on the page.
// areas: [{title, spots: [spotId, ...]}; the prefix is the part of the
// spot id before its '-'. Returns '' when no area has spots.
export function spotLegend(areas) {
  const seen = new Map();
  for (const a of areas || []) {
    const first = (a.spots || [])[0];
    if (!first) continue;
    const prefix = String(first).split('-')[0];
    if (prefix && !seen.has(prefix)) seen.set(prefix, a.title || prefix);
  }
  if (!seen.size) return '';
  return 'Spot key: ' + [...seen.entries()].map(([p, t]) => p + ' = ' + t).join(' · ');
}

export function findVendorSpot(areas, rowIds) {
  const ids = new Set((rowIds || []).map(String));
  for (const area of areas || []) {
    for (const id of spotIds(area)) {
      const entry = (area.assignments || {})[id] || {};
      if (entry.vendor_id && ids.has(String(entry.vendor_id))) return { area, spot: id };
    }
  }
  return null;
}

export async function renderVendorFloorPlan(host, eventId, mineRow) {
  if (!host || !eventId) return;
  // Venue sharing: an earlier same-day restriction (Hampton Inn /
  // Trinity Yoga venues only) was LIFTED by the owner on Oct 22 eve —
  // vendors see the saved plans at EVERY venue, Hilton Garden Inn
  // included. No venue check and no fetch gate here.
  host.innerHTML = '<p class="muted">Loading the floor plan…</p>';
  let result;
  try {
    // Vendor-safe read (§31): floor-area-plans is served ahead of the
    // identity wall and its non-staff branch returns the areas plus a
    // vendor_names map for the pins. floor-attendees stays staff-only
    // and is NEVER fetched on the vendor path — it 403'd here, which
    // made every vendor's plan read as "not published yet."
    result = await api('floor-area-plans', undefined, { event_id: eventId });
  } catch (e) {
    host.innerHTML = '<p class="muted">Floor plan could not be loaded. (' + esc(e.message) + ')</p>';
    return;
  }
  const vendors = Object.entries(result.vendor_names || {}).map(([id, label]) => ({ id, business: label }));
  const rowIds = new Set();
  if (mineRow?.id) rowIds.add(String(mineRow.id));
  if (mineRow?.vendor_id) rowIds.add(String(mineRow.vendor_id));
  // §55: hallway booths have no floor-plan position and none is invented
  // for them — the sheet says so plainly instead of implying a missing
  // assignment.
  const isHallway = String(mineRow?.space || '').trim().toLowerCase() === 'hallway';
  const areas = (result.areas || []).map(standardizeArea).filter(area => {
    const assigned = Object.values(area.assignments || {}).some(e => e && e.vendor_id);
    return imageAllowed(area.image_data_url) || assigned;
  });
  if (!areas.length) {
    host.innerHTML = isHallway
      ? '<p class="muted">🧭 <strong>Your booth is in the Hallway.</strong> Hallway spots are not marked on the floor plan — check in with the organizer when you arrive and they will show you your spot.</p>'
      : '<p class="muted">No floor plan has been saved for this market yet. Booth assignments will appear here once the organizer arranges the plan.</p>';
    return;
  }
  const mine = findVendorSpot(areas, [...rowIds]);
  let shown = mine ? mine.area : areas[0];

  const draw = () => {
    const area = shown;
    const filled = spotIds(area).filter(id => !!area.assignments[id]?.vendor_id).length;
    const head = mine
      ? `<p class="fp-mine-note">🧭 <strong>Your booth: ${esc(mine.spot)}</strong> · ${esc(mine.area.title)}${mine.area === area ? '' : ' — switch back to the highlighted plan to see it'}</p>`
      : isHallway
        ? '<p class="fp-mine-note">🧭 <strong>Your booth is in the Hallway</strong> — hallway spots are not marked on the floor plan. Check in with the organizer when you arrive; you can still look over the layouts below.</p>'
        : '<p class="fp-mine-note">Your booth has not been placed on the plan yet — you can still look over the layouts below.</p>';
    const chips = areas.length > 1
      ? `<div class="filters fp-area-chips" role="group" aria-label="Floor plan areas">${areas.map(a => `<button type="button" class="chip-btn ${a === area ? 'active' : ''}" data-fp-area="${esc(a.area_key)}">${esc(a.title)}${mine && mine.area === a ? ' · your booth' : ''}</button>`).join('')}</div>`
      : '';
    let body;
    if (imageAllowed(area.image_data_url)) {
      const pins = resolvePins(area, vendors).map(p =>
        `<span class="fp-pin${rowIds.has(String(p.vendorId)) ? ' mine' : ''}" style="left:${p.x}%;top:${p.y}%">${esc(p.label)}<span class="pin-spot">${esc(p.spotLabel)}</span></span>`).join('');
      body = `<div class="fp-map"><img class="fp-img" alt="Floor plan for ${esc(area.title)}" src="${area.image_data_url}">${pins}</div>`;
    } else {
      body = '<div class="fp-booths">' + spotIds(area).map(id => {
        const entry = area.assignments[id] || {};
        const label = entry.vendor_id ? vendorLabel(vendors, entry.vendor_id) : null;
        const isMine = entry.vendor_id && rowIds.has(String(entry.vendor_id));
        return `<div class="fp-booth${isMine ? ' mine' : ''}"><strong>${esc(id)}</strong><span>${label ? esc(label) : '<span class="muted">Open</span>'}</span></div>`;
      }).join('') + '</div>';
    }
    host.innerHTML = `${head}${chips}<h3 class="fp-title">${esc(area.title)} <span class="status neutral">${filled} of ${area.capacity} assigned</span></h3>${body}<p class="note">Booth spots are subject to change without notice.</p>`;
    fitPins(host);
    host.querySelectorAll('img.fp-img').forEach(img => { if (!img.complete) img.addEventListener('load', () => fitPins(host)); });
    host.querySelectorAll('[data-fp-area]').forEach(b => b.onclick = () => {
      shown = areas.find(a => String(a.area_key) === String(b.dataset.fpArea)) || shown;
      draw();
    });
  };
  draw();
}

// --- print: composite image ----------------------------------------------
// Flatten the uploaded layout image + every vendor label into ONE canvas
// at the resolved pin positions (the Oct 22 fix: DOM-overlay printing
// paginated badly — a single image prints as a single page).
function drawPinsOnCanvas(ctx, W, H, pins) {
  const maxRectW = W * 0.30, basePx = Math.max(20, Math.round(W * 0.017));
  for (const p of pins) {
    let fontPx = basePx, lines = [], textW = 0;
    for (let attempt = 0; attempt < 4; attempt++) {
      ctx.font = '700 ' + fontPx + 'px Arial,Helvetica,sans-serif';
      lines = []; let line = '';
      const words = p.label.split(/\s+/);
      for (const w of words) {
        const t = line ? line + ' ' + w : w;
        if (ctx.measureText(t).width <= maxRectW - 16 || !line) { line = t; }
        else { lines.push(line); line = w; if (lines.length === 2) break; }
      }
      if (line && lines.length < 2) lines.push(line);
      const joined = lines.join(' ');
      if (joined !== p.label && lines.length === 2) {
        let l2 = lines[1];
        while (l2.length > 1 && ctx.measureText(l2 + '…').width > maxRectW - 16) l2 = l2.slice(0, -1);
        lines[1] = l2 + '…';
      }
      textW = Math.max.apply(null, lines.map(l => ctx.measureText(l).width));
      if (textW <= maxRectW - 16 || attempt === 3) break;
      fontPx = Math.max(12, Math.round(fontPx * 0.85));
    }
    const padX = 10, padY = 7, lineH = Math.round(fontPx * 1.18);
    // §85 (Scott, Nov 24, 2026): the full spot ID (MR-06, H1-02) prints
    // under the vendor name — the bare number baked into the uploaded
    // artwork doesn't say which room the booth is in.
    const spotPx = Math.max(11, Math.round(fontPx * 0.8)), spotH = Math.round(spotPx * 1.2);
    ctx.font = '800 ' + spotPx + 'px Arial,Helvetica,sans-serif';
    textW = Math.max(textW, ctx.measureText(p.spotLabel).width);
    const rw = Math.ceil(textW) + padX * 2, rh = lineH * lines.length + spotH + padY * 2;
    let cx = p.x / 100 * W, cy = p.y / 100 * H;
    cx = Math.max(rw / 2 + 4, Math.min(W - rw / 2 - 4, cx));
    cy = Math.max(rh / 2 + 4, Math.min(H - rh / 2 - 4, cy));
    const x = cx - rw / 2, y = cy - rh / 2, r = 8;
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + rw, y, x + rw, y + rh, r);
    ctx.arcTo(x + rw, y + rh, x, y + rh, r);
    ctx.arcTo(x, y + rh, x, y, r);
    ctx.arcTo(x, y, x + rw, y, r);
    ctx.closePath();
    ctx.fillStyle = 'rgba(255,255,255,0.97)'; ctx.fill();
    ctx.lineWidth = Math.max(2, W * 0.0016); ctx.strokeStyle = '#16594a'; ctx.stroke();
    ctx.fillStyle = '#103e35'; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    ctx.font = '700 ' + fontPx + 'px Arial,Helvetica,sans-serif';
    lines.forEach((l, i) => ctx.fillText(l, cx, y + padY + i * lineH));
    ctx.font = '800 ' + spotPx + 'px Arial,Helvetica,sans-serif';
    ctx.fillStyle = '#16594a';
    ctx.fillText(p.spotLabel, cx, y + padY + lines.length * lineH);
  }
}

export function composePlanCanvas(area, vendors) {
  const pins = resolvePins(area, vendors);
  const render = img => {
    let W, H;
    if (img) { W = img.naturalWidth; H = img.naturalHeight; }
    else { W = 1600; H = 2000; }
    const scale = Math.min(1, 2400 / W);
    W = Math.round(W * scale); H = Math.round(H * scale);
    const canvas = document.createElement('canvas');
    canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext('2d');
    if (img) ctx.drawImage(img, 0, 0, W, H);
    else { ctx.fillStyle = '#f7f3e7'; ctx.fillRect(0, 0, W, H); ctx.lineWidth = 4; ctx.strokeStyle = '#174d40'; ctx.strokeRect(2, 2, W - 4, H - 4); }
    drawPinsOnCanvas(ctx, W, H, pins);
    return canvas;
  };
  if (!imageAllowed(area.image_data_url)) return Promise.resolve(render(null));
  return new Promise(resolve => {
    const img = new Image();
    img.onload = () => resolve(render(img));
    img.onerror = () => resolve(render(null));
    img.src = area.image_data_url;
  });
}

// Print the floor plan: one printed page PER area plan. Each area gets a
// .plan-page section sized to the printed page's content box (flex column:
// title block, then the composite image in a flexing frame with
// object-fit:contain), so title + full plan always land together on a
// single page, whatever margins the printer or print service uses. The
// previous version sized the image in fixed inches (9.5in tall plus
// ~0.75in of titles) against an assumed 10.4in printable height at .3in
// margins; with any larger effective margin the unbreakable image no
// longer fit under the titles and was pushed whole onto page 2. The popup
// opens synchronously inside the click (popup blockers), shows a preparing
// note, and is replaced once the composite images are rendered. The
// toolbar (Print / \u2715 Close) never prints.
const PLAN_PRINT_CSS = '@page{size:letter portrait;margin:.4in;background:#fff}*{box-sizing:border-box}html,body{margin:0;padding:0;height:100%;background:#fff;font-family:Arial,Helvetica,sans-serif}.tools{position:sticky;top:0;display:flex;gap:10px;padding:12px;background:#fff;border-bottom:1px solid #ccc;z-index:5}.tools button{padding:11px 20px;border:0;border-radius:7px;background:#175745;color:#fff;font-weight:bold;font-size:14px;cursor:pointer}.tools button.close{background:#e8eee8;color:#175745;border:1px solid #175745}.plan-page{display:flex;flex-direction:column;height:100%;overflow:hidden;break-inside:avoid-page;page-break-inside:avoid;break-after:page;page-break-after:always}.plan-page.last{break-after:auto;page-break-after:auto}.plan-head{flex:0 0 auto}.plan-head h1{font:700 15pt Georgia,serif;color:#174d40;margin:10px 4px 2px}.plan-head .sub{margin:0 4px 10px;color:#44554c;font-size:10pt}.plan-frame{flex:1 1 auto;min-height:0}.plan-frame img{display:block;width:100%;height:100%;object-fit:contain}.plan-names{flex:0 0 auto;padding:8px 4px 2px;font-size:10pt;color:#22312a;line-height:1.55}@media print{.tools{display:none!important}}';
// §76: no auto-print script on the floor-plan page (see print.js §76
// note) — the modal print dialog swallowed the page's own controls.
// §74 (Scott, Nov 18, 2026): printouts open in THIS tab, never a popup.
// On Scott's phone every window.open('_blank') print page got handed
// off to the browser app ('it's still opening the browser'), where the
// generated page and its buttons misbehaved. Same-tab rendering keeps
// the printout inside the app; the §72 Close chain (close -> back ->
// app root) is the way back. Because the editor page is replaced, a
// print requested while autosave is still holding changes is refused
// with a toast instead of discarding them.
export async function printFloorPlan({ event, areas, area, vendors, dirty, toast }) {
  if (dirty) { toast('Your changes are still saving — wait for the saved checkmark, then print.', true); return; }
  const list = (areas && areas.length ? areas : [area]).filter(Boolean);
  // Every area with a layout image or at least one assigned vendor gets
  // its own page; an area with neither is skipped so no blank page appears.
  const targets = list.map(a => ({ area: a, pins: resolvePins(a, vendors) }))
    .filter(x => x.pins.length || imageAllowed(x.area.image_data_url));
  if (!targets.some(x => x.pins.length)) { toast('No vendors are assigned in ' + (area?.title || list[0]?.title || 'this area') + ' yet. Assign vendors before printing the floor plan.', true); return; }
  const popup = window.open('', '_self');
  if (!popup) { toast('Could not open the print view in this browser.', true); return; }
  popup.document.open();
  popup.document.write('<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Preparing floor plan</title></head><body style="font-family:Arial,Helvetica,sans-serif;padding:24px;color:#174d40">Preparing your printable floor plan\u2026</body></html>');
  popup.document.close();
  const sections = [];
  for (const [i, t] of targets.entries()) {
    const canvas = await composePlanCanvas(t.area, vendors);
    sections.push('<section class="plan-page' + (i === targets.length - 1 ? ' last' : '') + '"><div class="plan-head"><h1>' + esc(t.area.title) + ' \u2014 floor plan</h1><p class="sub">' + esc(event?.date ? nice(event.date) : '') + ' \u00b7 ' + t.pins.length + ' vendor' + (t.pins.length === 1 ? '' : 's') + ' placed</p></div><div class="plan-frame"><img class="plan" alt="Floor plan with vendor names" src="' + canvas.toDataURL('image/png') + '"></div>' + (t.pins.length ? '<div class="plan-names"><strong>Vendor names:</strong> ' + t.pins.map(p => esc(p.spot) + ' — ' + esc(p.label)).join(' · ') + '</div>' : '') + '</section>');
  }
  const title = String(event?.title || 'Market') + ' \u2014 floor plans';
  const doc = '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>' + esc(title) + '</title><style>' +
    PLAN_PRINT_CSS +
    '</style></head><body>' +
    '<div class="tools"><button type="button" onclick="if(window.TrinityPrint&&TrinityPrint.print){TrinityPrint.print()}else{window.print()}">Print floor plan</button><button type="button" class="close" onclick="window.close();setTimeout(function(){if(!window.closed)location.reload()},300);setTimeout(function(){if(!window.closed)location.href=\'https://trinitylutzmarkets.com/v2/?from=print\'},800)">\u2715 Close</button><a href="https://trinitylutzmarkets.com/v2/?from=print" onclick="location.reload();return false;">← Back to the app</a></div>' +
    sections.join('') +
    '</body></html>';
  popup.document.open();
  popup.document.write(doc);
  popup.document.close();
  popup.focus();
  toast('Printable floor plan opened \u2014 ' + targets.length + ' area plan' + (targets.length === 1 ? '' : 's') + ', one page each.');
}

// §79 (Nov 18, 2026): the plan pages attached to the back of the booth
// assignments printout — one section per printable area, composited
// image plus the §78 plain-text names list, from the same resolved
// pins that draw the tags.
export function boothPlanSections(targets, urls, sub) {
  return targets.map((t, i) => '<section class="plan-page"><h2>' + esc(t.area.title) + ' — floor plan</h2><p class="sub">' + esc(sub) + ' · ' + t.pins.length + ' vendor' + (t.pins.length === 1 ? '' : 's') + ' placed</p><img class="plan" alt="Floor plan with vendor names" src="' + urls[i] + '">' + (t.pins.length ? '<div class="plan-names"><strong>Vendor names:</strong> ' + t.pins.map(p => esc(p.spot) + ' — ' + esc(p.label)).join(' · ') + '</div>' : '') + '</section>').join('');
}

// §83 (Scott, Nov 24, 2026): "I want their elected check in time to
// show on this report, then grouped by time on the print out, anyone
// who didn't check in gets put at the bottom of the report." The booth
// list is no longer one table per area: assigned booths are grouped by
// the setup arrival time the vendor elected at online check-in
// (setup_arrival_time, carried on the floor-attendees rows since §83),
// earliest first, and vendors who never completed online check-in —
// no elected time — form the last group. Pure helper so the grouping
// is testable without a DOM: rows are {id, name, time}.
export function boothCheckinGroups(rows) {
  const label = raw => {
    const m = /^(\d{1,2}):(\d{2})/.exec(String(raw || '').trim());
    if (!m) return String(raw || '').trim();
    let h = Number(m[1]);
    const ap = h >= 12 ? 'PM' : 'AM';
    h = h % 12 || 12;
    return h + ':' + m[2] + ' ' + ap;
  };
  const minutes = raw => {
    const m = /^(\d{1,2}):(\d{2})/.exec(String(raw || '').trim());
    return m ? Number(m[1]) * 60 + Number(m[2]) : Number.MAX_SAFE_INTEGER;
  };
  const boothSort = (a, b) => String(a.id).localeCompare(String(b.id), undefined, { numeric: true });
  const byTime = new Map(), none = [];
  for (const r of rows || []) {
    const raw = String(r.time || '').trim();
    if (!raw) { none.push(r); continue; }
    if (!byTime.has(raw)) byTime.set(raw, []);
    byTime.get(raw).push(r);
  }
  const groups = [...byTime.entries()]
    .sort((a, b) => minutes(a[0]) - minutes(b[0]) || label(a[0]).localeCompare(label(b[0])))
    .map(([raw, rs]) => ({ time: raw, label: label(raw), rows: rs.slice().sort(boothSort) }));
  return { groups, none: none.slice().sort(boothSort) };
}

// Print the booth list: assigned booths grouped by elected check-in
// time (§83), plus the unassigned/overflow list. Organizer-only
// printout (the legacy wording is preserved: it is never sent to
// vendors).
export function printBoothList({ event, venue, areas, vendors, dirty, toast }) {
  if (dirty) { toast('Your changes are still saving — wait for the saved checkmark, then print.', true); return; }
  if (!event || !areas.length) { toast('Choose an event with floor plan areas before printing.', true); return; }
  const vendorById = new Map((vendors || []).map(v => [String(v.id), v]));
  const assigned = new Set();
  // §83: one flat row per assigned booth, carrying the vendor's elected
  // check-in time; open booths are collected per area for the summary
  // line (they have no vendor and no time, so they leave the tables).
  const boothRows = [], openByArea = [];
  let total = 0;
  for (const area of areas) {
    total += area.capacity;
    const open = [];
    for (const id of spotIds(area)) {
      const vendorId = String(area.assignments[id]?.vendor_id || '');
      const vendor = vendorById.get(vendorId);
      if (vendor) {
        assigned.add(vendorId);
        boothRows.push({ id: spotLabel(id), name: String(vendor.business || vendor.name || 'Unnamed vendor'), time: String(vendor.setup_arrival_time || '') });
      } else open.push(spotLabel(id));
    }
    if (open.length) openByArea.push({ title: String(area.title), spots: open });
  }
  const filled = boothRows.length;
  const unassigned = (vendors || []).filter(v => !assigned.has(String(v.id)))
    .sort((a, b) => String(a.business || a.name || '').localeCompare(String(b.business || b.name || '')));
  const d = new Date(String(event.date).slice(0, 10) + 'T12:00:00');
  const dateText = Number.isNaN(d.getTime()) ? String(event.date || '') : d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
  const title = String(venue?.market_name || event.title || 'Market') + ' — Booth Assignments';
  const checkinTable = rows => '<table><thead><tr><th class="booth">Booth</th><th>Vendor / Business</th><th class="check">Checked in</th></tr></thead><tbody>' +
    rows.map(r => '<tr><td class="booth">' + esc(r.id) + '</td><td>' + esc(r.name) + '</td><td class="check"><span class="tick"></span></td></tr>').join('') +
    '</tbody></table>';
  const grouped = boothCheckinGroups(boothRows);
  const sections = grouped.groups.map(g => '<section class="area"><div class="area-heading"><h2>Check-in ' + esc(g.label) + '</h2><span>' + g.rows.length + ' vendor' + (g.rows.length === 1 ? '' : 's') + '</span></div>' +
    checkinTable(g.rows) + '</section>').join('') +
    (grouped.none.length ? '<section class="area"><div class="area-heading"><h2>No check-in time chosen</h2><span>' + grouped.none.length + ' vendor' + (grouped.none.length === 1 ? '' : 's') + ' — not checked in online</span></div>' +
      checkinTable(grouped.none) + '</section>' : '');
  const pending = unassigned.length ? '<section class="area"><div class="area-heading"><h2>Unassigned / Overflow</h2><span>' + unassigned.length + ' vendor(s)</span></div>' +
    '<table><thead><tr><th>Vendor / Business</th><th class="booth">Booking</th><th>Placement notes</th></tr></thead><tbody>' +
    unassigned.map(v => '<tr><td>' + esc(v.business || v.name || 'Unnamed vendor') + '</td><td>' + esc(v.space || '') + '</td><td>&nbsp;</td></tr>').join('') +
    '</tbody></table></section>' : '';
  const stylesheet = '@page{size:letter portrait;margin:.48in .5in;background:#fff}' +
    '*{box-sizing:border-box}html,body{margin:0;padding:0;color:#172821;background:white;font:11pt Arial,Helvetica,sans-serif}' +
    'header{border-bottom:2px solid #174d40;padding-bottom:10px;margin-bottom:15px}h1{font:700 19pt Georgia,serif;color:#174d40;margin:0 0 5px}' +
    'header p{margin:3px 0;color:#34443d;font-size:10pt}.summary{font-weight:700;margin:12px 0 4px;font-size:10pt}.legend{font-size:9pt;color:#34443d;margin:0 0 12px}.private{font-size:8pt;letter-spacing:.7px;text-transform:uppercase;font-weight:700}' +
    '.draft{font-weight:700;color:#a13d18;margin-top:5px}.area{break-inside:avoid-page;page-break-inside:avoid;margin:12px 0 16px}' +
    '.area-heading{display:flex;justify-content:space-between;gap:12px;align-items:baseline;border-bottom:1px solid #b9cec4;margin-bottom:5px}' +
    '.area-heading h2{margin:0;padding:3px 0 5px;font-size:13pt;color:#16483c}.area-heading span{font-size:9pt;color:#56675e}' +
    'table{width:100%;border-collapse:collapse;table-layout:fixed}thead{display:table-header-group}tr{break-inside:avoid;page-break-inside:avoid}' +
    'th{background:#e8f1eb;color:#173d33;text-align:left;font-size:9pt;padding:6px;border:1px solid #d3dfd7}' +
    'td{padding:6px 8px;border:1px solid #d3dfd7;overflow-wrap:anywhere;font-size:10pt;line-height:1.15;height:25px}' +
    '.booth{width:21%;font-weight:700}.check{width:16%;text-align:center}.tick{display:inline-block;width:14px;height:14px;border:1.3px solid #65796c;border-radius:2px}' +
    '.open{color:#777;font-style:italic}.button-row{position:sticky;top:0;background:#fffefb;padding:12px 0;display:flex;gap:10px;flex-wrap:wrap;align-items:center}.button-row a{color:#175745;font-weight:bold;font-size:13px}.button-row p{flex-basis:100%;margin:2px 0 0;font-size:9pt;color:#56675e}' +
    'button{padding:10px 18px;border:0;border-radius:7px;background:#175745;color:white;font-weight:bold;font-size:13px;cursor:pointer}' +
    '@media print{.button-row{display:none!important}}' +
    '.plan-page{break-before:page;page-break-before:always}.plan-page h2{font:700 14pt Georgia,serif;color:#174d40;margin:0 0 2px}.plan-page .sub{margin:0 0 8px;color:#44554c;font-size:10pt}.plan-page img{width:100%;max-height:8.4in;object-fit:contain}.plan-names{margin-top:8px;font-size:10pt;line-height:1.55;color:#22312a}';
  const legend = spotLegend(areas.map(a => ({ title: String(a.title), spots: spotIds(a) })));
  const openLine = openByArea.length ? '<p class="legend">Open booths: ' + openByArea.map(a => esc(a.title) + ': ' + a.spots.map(esc).join(', ')).join(' · ') + '</p>' : '';
  const doc = '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>' + esc(title) + '</title><style>' + stylesheet + '</style></head><body>' +
    '<div class="button-row"><button type="button" onclick="if(window.TrinityPrint&&TrinityPrint.print){TrinityPrint.print()}else{window.print()}">Print / Save as PDF</button><button type="button" style="background:#e8eee8;color:#175745;border:1px solid #175745" onclick="window.close();setTimeout(function(){if(!window.closed)location.reload()},300);setTimeout(function(){if(!window.closed)location.href=\'https://trinitylutzmarkets.com/v2/?from=print\'},800)">✕ Close</button><a href="https://trinitylutzmarkets.com/v2/?from=print" onclick="location.reload();return false;">← Back to the app</a><p>In the app, the Print button above opens the print dialog. In a browser you can also use ⋮ → Share → Print.</p></div>' +
    '<header><h1>' + esc(title) + '</h1><p><strong>' + esc(dateText) + '</strong> · ' + esc(venue?.name || event.title || '') + '</p>' +
    (venue?.address ? '<p>' + esc(venue.address) + '</p>' : '') +
    '<p class="private">Private organizer copy — do not distribute to vendors</p>' +
    (dirty ? '<p class="draft">UNSAVED CHANGES — this printout includes edits not yet saved online.</p>' : '') +
    '</header><p class="summary">' + filled + ' of ' + total + ' booths assigned · ' + (total - filled) + ' open · ' + unassigned.length + ' vendors awaiting a booth</p>' +
    (legend ? '<p class="legend">' + esc(legend) + '</p>' : '') +
    openLine +
    sections + pending + '</body></html>';
  const popup = window.open('', '_self');
  if (!popup) { toast('Could not open the print view in this browser.', true); return; }
  // §79 (Scott, Nov 18, 2026): "printing the floor plan for November 28
  // isn't attached to the booth assignments report" — it is now: the
  // plan pages for THIS event (composited images + the §78 names
  // lists) ride at the back of this printout, so one print carries the
  // tables and the plans. Same two-phase write as printFloorPlan: the
  // preparing note opens inside the click, the full document lands
  // once the composites render.
  const targets = areas.map(area => ({ area, pins: resolvePins(area, vendors || []) })).filter(x => x.pins.length || imageAllowed(x.area.image_data_url));
  if (!targets.length) {
    popup.document.open();
    popup.document.write(doc);
    popup.document.close();
    popup.focus();
    toast('Printable booth list opened — Print / Save as PDF is at the top.');
    return;
  }
  popup.document.open();
  popup.document.write('<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Preparing booth assignments</title></head><body style="font-family:Arial,Helvetica,sans-serif;padding:24px;color:#174d40">Preparing your printable booth assignments…</body></html>');
  popup.document.close();
  Promise.all(targets.map(async x => {
    const canvas = await composePlanCanvas(x.area, vendors || []);
    return canvas.toDataURL('image/png');
  })).then(urls => {
    popup.document.open();
    popup.document.write(doc.replace('</body></html>', boothPlanSections(targets, urls, dateText) + '</body></html>'));
    popup.document.close();
    popup.focus();
    toast('Printable booth list opened — floor plans attached at the back.');
  });
}
