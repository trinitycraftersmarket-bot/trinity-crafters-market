// Read-only saved floor plan for the Event Day screen.
//
// STAGE 1: display only — no editing. The rebuild rule (audit §13.9) is one
// floor-plan implementation and one store; until the editor is rebuilt in a
// later stage, this renderer reads the same store the area manager writes
// (market.floor_plan_areas via the floor-area-plans action) and resolves pin
// positions with the SAME math the editor uses, ported here so v2 stays
// self-contained: per-spot saved x/y percentages win, known venue layouts
// fall back to their label tables, everything clamps onto the plan, and a
// fit pass after layout pulls each whole label inside the image — the exact
// rules whose absence in the old legacy editor made vendors vanish or clip.
import { api, esc } from './api.js?v=20261022-1';

const imageAllowed = url => typeof url === 'string' && /^data:image\/(png|jpeg|webp);base64,/.test(url);
const standardize = area => ({ ...area, assignments: area.assignments && typeof area.assignments === 'object' ? area.assignments : {}, image_data_url: area.image_data_url || '' });
const spot = (area, i) => String(area.prefix || area.area_key.toUpperCase()) + '-' + String(i + 1).padStart(2, '0');
const positions = (a, i) => {
  const rows = Math.ceil(a.capacity / 2), col = i < rows ? 0 : 1, row = col ? i - rows : i;
  return { x: col ? 76 : 24, y: 12 + Math.max(0, row) * 76 / Math.max(1, rows - 1) };
};
// Label anchor tables for the known venue graphics (percentages of the full
// uploaded graphic, matching the editor's autoLabelPosition).
const mainRoomLabels = {
  1: [85, 62], 2: [86, 49.5], 3: [86, 37.5], 4: [86, 24.5],
  5: [65, 16], 6: [32, 21], 7: [56, 31], 8: [51, 49],
  9: [55, 65], 10: [59, 85.5], 11: [68, 86.5], 12: [28, 86.5],
  13: [44, 76.3], 14: [46, 66], 15: [46, 49.5], 16: [43, 30.2],
  17: [12, 33.5], 18: [12, 46], 19: [12, 58], 20: [12, 69], 21: [12, 82]
};
const autoLabelPosition = (area, index) => {
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
  return positions(area, index);
};
const clampPct = (v, f) => { const n = Number(v); return v != null && Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : f; };

// Same fit pass as the editor: once the browser knows real pixel sizes,
// pull each label's center back so the whole card sits inside the plan.
function fitPins(host) {
  host.querySelectorAll('.fp-map').forEach(map => {
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

// Render the event's saved areas into `host`. Fetches fresh data on every
// call (server is the source of truth); renders nothing but a note when the
// event has no saved plan yet.
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
    const vendorName = id => {
      const v = vendors.find(x => String(x.id) === String(id));
      return v ? String(v.business || v.name || 'Vendor') : null;
    };
    const areas = (result.areas || []).map(standardize).filter(area => {
      const assigned = Object.values(area.assignments || {}).some(e => e && e.vendor_id);
      return imageAllowed(area.image_data_url) || assigned;
    });
    if (!areas.length) {
      host.innerHTML = '<p class="muted">No floor plan saved for this market yet. Booth assignments made in Setup &amp; floor plan will appear here.</p>';
      return;
    }
    host.innerHTML = areas.map(area => {
      const ids = Array.from({ length: area.capacity }, (_, i) => spot(area, i));
      const filled = ids.filter(id => !!area.assignments[id]?.vendor_id).length;
      const head = '<h3 class="fp-title">' + esc(area.title) + ' <span class="status neutral">' + filled + ' of ' + area.capacity + ' assigned</span></h3>';
      if (imageAllowed(area.image_data_url)) {
        const pins = ids.map((id, i) => {
          const entry = area.assignments[id] || {};
          if (!entry.vendor_id) return '';
          const label = vendorName(entry.vendor_id);
          if (!label) return '';
          const fallback = autoLabelPosition(area, i);
          const x = clampPct(entry.x, fallback.x), y = clampPct(entry.y, fallback.y);
          return '<span class="fp-pin" style="left:' + x + '%;top:' + y + '%">' + esc(label) + '</span>';
        }).join('');
        return head + '<div class="fp-map"><img class="fp-img" alt="Saved floor plan for ' + esc(area.title) + '" src="' + area.image_data_url + '">' + pins + '</div>';
      }
      const boothRows = ids.map(id => {
        const entry = area.assignments[id] || {};
        const label = entry.vendor_id ? vendorName(entry.vendor_id) : null;
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
