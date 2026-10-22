// v2 data shaping: turn the admin payload into the rows and numbers the
// screens render. Pure functions over the payload — no fetching, no DOM,
// and NO mutation of the payload (the legacy UI's local-cache mutation is
// audit pattern R-2; here every screen re-fetches, then re-shapes).
//
// Counting semantics are the server's (server/counts.mjs owns every
// capacity/category number; the events in the payload already carry
// indoor_used / outdoor_used from it). The attendee LIST still has to pick
// one display row per vendor when a booking and an imported record describe
// the same person — the winner rule below mirrors the legacy attendee
// list's dedupeVendorRows exactly (paid first, then held, then approved;
// bookings are considered before imported rows), so v2 never shows a
// vendor twice and never disagrees with the current app about who is on
// the list. Writes always go to the server, which twin-syncs both records.

// Identity key: vendor_id, else email (lowercased, trailing commas from PDF
// imports stripped), else phone digits, else normalized business/name —
// the same key order as server/counts.mjs vendorIdentityKey.
export function vendorIdentityKey(v) {
  const email = String(v.email || '').trim().toLowerCase().replace(/,+$/, '');
  const phone = String(v.phone || '').replace(/\D/g, '');
  const name = String(v.business || v.name || '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');
  return v.vendor_id ? 'vendor:' + v.vendor_id : email ? 'email:' + email : phone ? 'phone:' + phone : name ? 'name:' + name : 'row:' + v.id;
}

const rank = v => v.status === 'paid' || v.payment_status === 'paid' ? 5 : v.status === 'held' ? 4 : v.status === 'approved' ? 3 : v.status === 'pending' ? 2 : 1;
export function dedupeVendorRows(rows) {
  const map = new Map();
  for (const v of rows || []) {
    const k = vendorIdentityKey(v), old = map.get(k);
    if (!old || rank(v) > rank(old)) map.set(k, v);
  }
  return [...map.values()];
}

// Bookings store indoor/outdoor; imported rows store Inside/Outside with
// arbitrary casing (audit §8.9). Normalize once, here.
export function normalizeSpace(value) {
  const s = String(value || '').trim().toLowerCase();
  if (s === 'indoor' || s === 'inside') return 'indoor';
  if (s === 'outdoor' || s === 'outside') return 'outdoor';
  return null;
}

const ACTIVE_BOOKING = ['approved', 'held', 'paid'];

// One unified attendee row per vendor for one event, from the admin
// payload's applications (bookings) + importedAttendees — the same union
// the legacy Attendees view renders.
export function attendeeRows(admin, eventId) {
  const bookings = (admin.applications || [])
    .filter(b => String(b.event_id) === String(eventId) && ACTIVE_BOOKING.includes(b.status))
    .map(b => ({
      ...b,
      imported: false,
      attendance: b.checked_in ? 'checked_in' : b.no_show ? 'no_show' : 'not_marked',
      payStatus: b.status === 'paid' ? 'paid' : 'unpaid',
      amount: Number(b.price || 0),
      disclosed: b.description || ''
    }));
  const imported = (admin.importedAttendees || [])
    .filter(i => String(i.event_id) === String(eventId) && !i.cancelled)
    .map(i => ({
      ...i,
      imported: true,
      status: i.payment_status || 'paid',
      attendance: i.attendance_state || 'not_marked',
      payStatus: (i.payment_status || 'paid') === 'paid' ? 'paid' : 'unpaid',
      amount: Number(i.invoice_amount || 0),
      disclosed: i.selling || i.category || '',
      approved_products: i.approved_products || i.selling || i.category || '',
      declined_products: i.declined_products || ''
    }));
  return dedupeVendorRows([...bookings, ...imported])
    .map(r => ({ ...r, spaceNorm: normalizeSpace(r.space), inspection_status: r.inspection_status || 'not_inspected' }))
    .sort((x, y) => String(x.business || x.name || '').localeCompare(String(y.business || y.name || ''), undefined, { sensitivity: 'base' }));
}

// The manager payload (api 'manager') is deliberately narrower than the
// admin payload: its booking rows carry NO price/payment fields and NO
// inspection fields. Rows are shaped with only what the payload actually
// has — a field the payload lacks (a booking's inspection_status) stays
// undefined and the manager screens simply don't render it. Imported rows
// in the manager payload are full attendee records, so they keep the
// fields they carry (inspection included).
export function managerAttendeeRows(manager, eventId) {
  const bookings = (manager?.applications || [])
    .filter(b => String(b.event_id) === String(eventId) && b.status === 'approved')
    .map(b => ({
      id: b.id, application_id: b.application_id, imported: false,
      business: b.business, name: b.name, email: b.email, phone: b.phone,
      category: b.category, space: b.space,
      attendance: b.checked_in ? 'checked_in' : b.no_show ? 'no_show' : 'not_marked',
      setup_arrival_time: b.setup_arrival_time, setup_checkin_at: b.setup_checkin_at,
      inspection_status: undefined,
      disclosed: b.description || ''
    }));
  const imported = (manager?.imported || [])
    .filter(i => String(i.event_id) === String(eventId) && !i.cancelled)
    .map(i => ({
      id: i.id, application_id: null, imported: true,
      business: i.business || i.name, name: i.name, email: i.email, phone: i.phone,
      category: i.category, space: i.space,
      attendance: i.attendance_state || 'not_marked',
      setup_arrival_time: i.setup_arrival_time, setup_checkin_at: i.setup_checkin_at,
      inspection_status: i.inspection_status || 'not_inspected',
      inspection_notes: i.inspection_notes || '',
      disclosed: i.selling || i.category || ''
    }));
  return dedupeVendorRows([...bookings, ...imported])
    .map(r => ({ ...r, spaceNorm: normalizeSpace(r.space) }))
    .sort((x, y) => String(x.business || x.name || '').localeCompare(String(y.business || y.name || ''), undefined, { sensitivity: 'base' }));
}

// Spots left for a space, from the server's own used counts on the event
// (publicData/counts.mjs). A closed space reports 0 regardless of capacity.
export function spotsOpen(event, space) {
  if (!event) return 0;
  if (event[space + '_open'] === false) return 0;
  return Math.max(0, Number(event[space + '_capacity'] || 0) - Number(event[space + '_used'] || 0));
}

// The numbers the Market Day home and the Event Day header show for one
// event. `rows` is attendeeRows(admin, event.id).
export function eventStats(admin, event) {
  const rows = attendeeRows(admin, event.id);
  const unpaid = rows.filter(r => r.payStatus === 'unpaid');
  return {
    rows,
    vendors: rows.length,
    indoor: rows.filter(r => r.spaceNorm === 'indoor').length,
    outdoor: rows.filter(r => r.spaceNorm === 'outdoor').length,
    checkedIn: rows.filter(r => r.attendance === 'checked_in').length,
    inspectionsPending: rows.filter(r => r.inspection_status !== 'approved').length,
    unpaidCount: unpaid.length,
    unpaidDue: unpaid.reduce((s, r) => s + r.amount, 0),
    waitlist: (admin.applications || []).filter(b => String(b.event_id) === String(event.id) && b.status === 'waitlist').length,
    indoorOpen: spotsOpen(event, 'indoor'),
    outdoorOpen: spotsOpen(event, 'outdoor')
  };
}
