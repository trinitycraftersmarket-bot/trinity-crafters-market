// The vendor side of v2 (Stage 3b): Home, My Bookings, Apply, and My
// Profile — the vendor portal the legacy app.js account page, the
// move-requests / vendor-credit / vendor-profile add-ons, and the apply
// form implement, rebuilt on the v2 state rule: every screen renders
// from fresh server payloads (mine / move-requests mine / vendor-credit
// mine / public / vendor-profile get), and every mutation re-fetches
// before re-rendering — no optimistic local copies.
import { api, fnq, esc, nice, money } from './api.js?v=20261022-6';
import { renderVendorFloorPlan } from './floorplan.js?v=20261022-6';

const todayStr = () => new Date().toLocaleDateString('en-CA');
const upcoming = r => String(r.date || '') >= todayStr();
const booked = r => ['approved', 'paid', 'held'].includes(String(r.status));
const offerDeadline = r => r.waitlist_offered_at ? new Date(new Date(r.waitlist_offered_at).getTime() + 12 * 3600 * 1000) : null;

export function statusText(r) {
  const s = String(r.status || '');
  if (s === 'paid') return 'Paid — you are booked';
  if (s === 'approved') return r.invoice_reference ? 'Invoice sent — payment due' : 'Approved — payment instructions coming';
  if (s === 'held') return 'Payment pending — booth held' + (r.hold_until ? ' until ' + new Date(r.hold_until).toLocaleString() : '');
  if (s === 'pending') return 'Application received — waiting for review';
  if (s === 'waitlist') return r.waitlist_offered_at ? 'Waitlist spot offered — answer before the deadline below' : 'On the waitlist';
  if (s === 'declined') return 'Not approved for this date';
  if (s === 'cancelled') return 'Cancelled';
  return s;
}
export const statusClass = r => ({ paid: 'ok', approved: 'warn', held: 'warn', pending: 'neutral', waitlist: 'warn', declined: 'bad', cancelled: 'neutral' })[String(r.status)] || 'neutral';

function inspectionChip(r) {
  const s = String(r.inspection_status || '');
  if (!s) return '';
  const label = { pending_organizer_review: 'Inspection: awaiting organizer review', approved: 'Inspection: approved', declined: 'Inspection: changes requested', not_started: 'Inspection: not started' }[s] || 'Inspection: ' + s.replaceAll('_', ' ');
  return `<span class="status ${s === 'approved' ? 'ok' : s === 'declined' ? 'bad' : 'neutral'}">${esc(label)}</span>`;
}

function moveChip(ctx, r) {
  const mine = (ctx.state.vendorMoves || []).filter(m => String(m.source_id) === String(r.id));
  return mine.filter(m => m.status === 'pending').map(m =>
    `<div class="checkin-box"><strong>Date change requested → ${esc(nice(m.to_date))}</strong><span class="note">Waiting for the organizer to decide.</span>
     <div class="vendor-actions"><button type="button" class="btn small danger" data-move-cancel="${esc(m.id)}">Cancel request</button></div></div>`).join('')
    + mine.filter(m => m.status !== 'pending').map(m =>
      `<p class="note">Date change to ${esc(nice(m.to_date))}: <strong>${m.status === 'approved' ? 'approved' : 'declined'}</strong>${m.decision_note ? ' — ' + esc(m.decision_note) : ''}</p>`).join('');
}

function bookingCard(ctx, r) {
  const dl = offerDeadline(r);
  return `<article class="card vendor" id="v2-booking-${esc(r.id)}">
    <div class="vendor-top"><div>
      <h3>${esc(nice(r.date))}</h3>
      <div class="contact">${esc(r.location || '')} · ${esc(r.space === 'outdoor' ? 'Outdoor' : 'Indoor')} · ${money(r.price)}</div>
    </div><span class="status ${statusClass(r)}">${esc(String(r.status || '').toUpperCase())}</span></div>
    <p class="note"><strong>Status:</strong> ${esc(statusText(r))}</p>
    ${r.setup_checkin_at ? `<p class="note"><strong>Online check-in complete.</strong> Arrival time: ${esc(r.setup_arrival_time || '')}.</p>`
      : r.setup_arrival_time ? `<p class="note"><strong>Setup arrival selected:</strong> ${esc(r.setup_arrival_time)}. Check in when you arrive on market day.</p>` : ''}
    ${r.payment_reference ? `<p class="note"><strong>Payment reference:</strong> ${esc(r.payment_reference)}</p>` : ''}
    ${r.decision_reason ? `<p class="note"><strong>Organizer note:</strong> ${esc(r.decision_reason)}</p>` : ''}
    <div class="chips">${inspectionChip(r)}${r.checked_in ? '<span class="status ok">Checked in</span>' : ''}${r.no_show ? '<span class="status bad">No-show recorded</span>' : ''}</div>
    ${String(r.status) === 'waitlist' && r.waitlist_offered_at ? `
      <div class="offer-box"><strong>🎉 A booth opened up for ${esc(nice(r.date))}!</strong>
      <span>Accept by <strong>${dl.toLocaleString()}</strong> — offers last 12 hours, then the spot goes to the next vendor on the list.</span>
      <div class="vendor-actions"><button type="button" class="btn primary small" data-offer-accept="${esc(r.id)}">Accept booth</button><button type="button" class="btn small danger" data-offer-decline="${esc(r.id)}">Decline</button></div></div>` : ''}
    ${booked(r) && upcoming(r) && !r.setup_checkin_at && !r.setup_arrival_time ? `
      <form class="checkin-form" data-checkin="${esc(r.id)}" data-source="${esc(r.source)}">
        <label class="sheet-field">Choose your setup arrival time
          <select name="arrival_time" required><option value="">Choose arrival time</option><option>08:15</option><option>08:30</option><option>08:45</option><option>09:00</option></select>
        </label>
        <div class="vendor-actions"><button class="btn small">Save arrival time</button></div>
      </form>` : ''}
    ${moveChip(ctx, r)}
    <div class="vendor-actions">
      ${booked(r) && upcoming(r) ? `<button type="button" class="btn small" data-floorplan="${esc(r.id)}">🗺️ Where will you be</button>` : ''}
      ${booked(r) ? `<button type="button" class="btn small" data-move="${esc(r.id)}">Request a date change</button>` : ''}
    </div>
  </article>`;
}

function wireBookingCard(ctx, root, r) {
  // Card buttons are wired once per render in renderVendorBookings; this
  // helper wires only the card's own check-in form.
  const form = root.querySelector(`[data-checkin="${CSS.escape(r.id)}"]`);
  if (form) form.onsubmit = async e => {
    e.preventDefault();
    try {
      await api('vendor-setup-checkin', { id: r.id, source: r.source, arrival_time: new FormData(form).get('arrival_time') });
      ctx.toast('Arrival time saved.');
      await ctx.refreshData();
      renderVendorBookings(ctx, root); // re-render from the fresh payload
    } catch (err) { ctx.toast(err.message, true); }
  };
}

export function renderVendorBookings(ctx, root) {
  root._screenRoot = root;
  const rows = ctx.state.vendorRows || [];
  const credits = (ctx.state.credits?.credits || []).filter(c => Number(c.remaining_amount) > 0 && c.status !== 'used');
  const upcomingRows = rows.filter(upcoming), past = rows.filter(r => !upcoming(r));
  root.innerHTML = `
    <p class="eyebrow">My Bookings</p>
    <h2 class="display">Your markets</h2>
    ${credits.length ? `<section class="card"><h3 class="section-title">💳 Vendor credit</h3>
      ${credits.map(c => `<p class="note"><strong>${money(c.remaining_amount)}</strong> of ${money(c.original_amount)} available${c.source_date ? ' — issued ' + esc(nice(c.source_date)) : ''}${c.category ? ' (' + esc(c.category) + ')' : ''}</p>
        ${(c.eligible_events || []).map(ev => (ev.spaces || []).map(sp => `<div class="vendor-actions"><span class="note">${esc(nice(ev.date))} — ${esc(ev.market_name || '')} · ${esc(sp.space)} ${money(sp.price)}</span><button type="button" class="btn small primary" data-redeem="${esc(c.id)}" data-event="${esc(ev.id)}" data-space="${esc(sp.space)}">Book with credit</button></div>`).join('')).join('') || '<p class="note">No upcoming dates this credit can book yet.</p>'}
      `).join('')}</section>` : ''}
    <div class="vendor-list">${upcomingRows.map(r => bookingCard(ctx, r)).join('') || '<div class="card empty-card">No upcoming bookings yet. Apply for a market date to get started.</div>'}</div>
    ${past.length ? `<h3 class="section-title">Past markets</h3><div class="vendor-list">${past.map(r => bookingCard(ctx, r)).join('')}</div>` : ''}`;

  const rerender = () => renderVendorBookings(ctx, root);
  root.querySelectorAll('[data-offer-accept]').forEach(b => b.onclick = async () => {
    if (!confirm('Accept this booth? Payment instructions will follow.')) return;
    try { await api('waitlist-accept', { id: b.dataset.offerAccept }); ctx.toast('Booth accepted — see you there!'); await ctx.refreshData(); rerender(); }
    catch (e) { ctx.toast(e.message, true); }
  });
  root.querySelectorAll('[data-offer-decline]').forEach(b => b.onclick = async () => {
    if (!confirm('Decline this booth offer? You will move to the back of the waitlist for this date.')) return;
    try { await api('waitlist-decline', { id: b.dataset.offerDecline }); ctx.toast('Offer declined.'); await ctx.refreshData(); rerender(); }
    catch (e) { ctx.toast(e.message, true); }
  });
  root.querySelectorAll('[data-move-cancel]').forEach(b => b.onclick = async () => {
    if (!confirm('Cancel this date-change request?')) return;
    try { await fnq('move-requests', 'cancel', { id: b.dataset.moveCancel }); ctx.toast('Date-change request cancelled.'); await ctx.refreshData(); rerender(); }
    catch (e) { ctx.toast(e.message, true); }
  });
  root.querySelectorAll('[data-redeem]').forEach(b => b.onclick = async () => {
    if (!confirm('Book this date with your vendor credit?')) return;
    try {
      await fnq('vendor-credit', 'redeem', { credit_id: b.dataset.redeem, event_id: b.dataset.event, space: b.dataset.space });
      ctx.toast('Booked with credit — see it in your list above.');
      await ctx.refreshData(); rerender();
    } catch (e) { ctx.toast(e.message, true); }
  });
  rows.forEach(r => wireBookingCard(ctx, root, r));
  root.querySelectorAll('[data-floorplan]').forEach(b => b.onclick = () => {
    const r = rows.find(x => String(x.id) === String(b.dataset.floorplan));
    ctx.openSheet('<h3 class="sheet-title">Where will you be</h3><div id="v2-vendor-fp"><p class="muted">Loading…</p></div>');
    renderVendorFloorPlan(ctx.sheetEl.querySelector('#v2-vendor-fp'), r.event_id, r);
  });
  root.querySelectorAll('[data-move]').forEach(b => b.onclick = () => {
    const r = rows.find(x => String(x.id) === String(b.dataset.move));
    openMoveSheet(ctx, r, rerender);
  });
}

async function openMoveSheet(ctx, r, rerender) {
  ctx.openSheet('<h3 class="sheet-title">Request a date change</h3><div id="v2-move-box"><p class="muted">Checking which dates you can move to…</p></div>');
  const boxEl = ctx.sheetEl.querySelector('#v2-move-box');
  let data;
  try {
    data = await fnq('move-requests', 'options', { source_type: r.source, source_id: r.id });
  } catch (e) { boxEl.innerHTML = `<p class="muted">${esc(e.message)}</p>`; return; }
  const eligible = data.eligible || [], excluded = data.excluded || [];
  boxEl.innerHTML = `
    <p class="note">You are booked for <strong>${esc(nice(r.date))}</strong> (${esc(data.space || r.space || '')}). Pick the new date — the organizer approves every change, and requests close 48 hours before the market.</p>
    ${eligible.map(ev => `<div class="vendor-actions"><span class="note"><strong>${esc(nice(ev.date))}</strong> — ${esc(ev.location || '')} · ${esc(data.space === 'outdoor' ? 'Outdoor' : 'Indoor')} ${money(data.space === 'outdoor' ? ev.outdoor_price : ev.indoor_price)}</span><button type="button" class="btn small primary" data-move-to="${esc(ev.id)}">Request this date</button></div>`).join('') || '<p class="note">No other dates are open for a move right now.</p>'}
    ${excluded.map(x => `<p class="note">${esc(nice(x.event?.date))}: ${esc((x.problems || []).join(' '))}</p>`).join('')}
    <label class="sheet-field">Anything the organizer should know? (optional)<textarea id="v2-move-reason" rows="2" maxlength="1000"></textarea></label>`;
  boxEl.querySelectorAll('[data-move-to]').forEach(b => b.onclick = async () => {
    b.disabled = true;
    try {
      await fnq('move-requests', 'create', { source_type: r.source, source_id: r.id, to_event_id: b.dataset.moveTo, reason: boxEl.querySelector('#v2-move-reason').value });
      ctx.toast('Date-change request sent — the organizer will decide.');
      ctx.closeSheet();
      await ctx.refreshData();
      rerender();
    } catch (e) { ctx.toast(e.message, true); b.disabled = false; }
  });
}

// ----------------------------------------------------------------- home ---
export function renderVendorHome(ctx, root) {
  const rows = ctx.state.vendorRows || [];
  const next = rows.filter(r => booked(r) && upcoming(r)).sort((a, b) => String(a.date).localeCompare(String(b.date)))[0];
  const pending = rows.filter(r => r.status === 'pending').length;
  const offers = rows.filter(r => r.status === 'waitlist' && r.waitlist_offered_at);
  const creditTotal = (ctx.state.credits?.credits || []).reduce((n, c) => n + Number(c.remaining_amount || 0), 0);
  const first = rows.find(r => r.business);
  root.innerHTML = `
    <p class="eyebrow">Vendor home</p>
    <h2 class="display">${esc(first?.business || 'Welcome')}</h2>
    ${offers.map(r => `<section class="card offer-box"><strong>🎉 A booth opened up for ${esc(nice(r.date))}!</strong><span>Accept by <strong>${offerDeadline(r).toLocaleString()}</strong> — offers last 12 hours.</span><div class="vendor-actions"><button class="btn primary small" data-go="vbookings">Answer the offer</button></div></section>`).join('')}
    ${next ? `<section class="card next-card">
      <p class="note">Your next market</p>
      <h3>${esc(nice(next.date))}</h3>
      <p class="note">${esc(next.location || '')} · ${esc(next.space === 'outdoor' ? 'Outdoor' : 'Indoor')} · Setup from 8:30 AM — be ready by 9:45 AM.</p>
      <p><span class="status ${statusClass(next)}">${esc(statusText(next))}</span></p>
      ${next.setup_arrival_time ? `<p class="note">Setup arrival: <strong>${esc(next.setup_arrival_time)}</strong></p>` : '<p class="note">You have not picked a setup arrival time yet — choose one in My Bookings.</p>'}
      <div class="vendor-actions">
        <button class="btn primary small" data-go="vbookings">My Bookings</button>
        <button class="btn small" id="v2-home-fp">🗺️ Where will you be</button>
      </div>
    </section>` : '<section class="card empty-card"><h3>No upcoming market booked</h3><p class="muted">Apply for a date and it will show up here.</p><div class="vendor-actions"><button class="btn primary small" data-go="vapply">Apply for a market</button></div></section>'}
    <section class="card">
      <h3 class="section-title">At a glance</h3>
      <p class="note">${rows.filter(r => booked(r) && upcoming(r)).length} upcoming market(s) booked · ${pending} application(s) awaiting review${creditTotal ? ` · <strong>${money(creditTotal)}</strong> vendor credit available` : ''}</p>
      <div class="sheet-menu">
        <button class="menu-item" data-go="vbookings"><span><b>My Bookings</b><span>Status, check-in, date changes, and your booth</span></span><span class="chev">›</span></button>
        <button class="menu-item" data-go="vapply"><span><b>Apply</b><span>Apply for another market date</span></span><span class="chev">›</span></button>
        <button class="menu-item" data-go="vprofile"><span><b>My Profile</b><span>Keep your details once — applications pre-fill</span></span><span class="chev">›</span></button>
        <button class="menu-item" data-go="vmessages"><span><b>Messages</b><span>Chat with the organizer</span></span><span class="chev">›</span></button>
      </div>
    </section>`;
  ctx.bindGo(root);
  const fp = root.querySelector('#v2-home-fp');
  if (fp && next) fp.onclick = () => {
    ctx.openSheet('<h3 class="sheet-title">Where will you be</h3><div id="v2-vendor-fp"><p class="muted">Loading…</p></div>');
    renderVendorFloorPlan(ctx.sheetEl.querySelector('#v2-vendor-fp'), next.event_id, next);
  };
}

// ---------------------------------------------------------------- apply ---
const AGREEMENTS = [
  ['nonrefundable', 'I understand booth fees are non-refundable.'],
  ['rain', 'I understand indoor markets continue rain or shine. For outdoor markets, I must check in by the required time or my space may be reassigned, and I must remain set up until 3:00 PM even if weather becomes unfavorable.'],
  ['nolm', 'I understand NO MLM or direct-sales products are allowed to be sold at the market. I agree to inform the organizer immediately if I see a violation.'],
  ['facebook', 'I understand the market Facebook Event and organizer reserves booth placement and all final decisions concerning booth placement.'],
  ['stayuntil3', 'I understand I MUST remain set up and present until 3:00 PM and will be responsible for any damage caused by an early departure.'],
  ['hurricane', 'I understand that during hurricane season, events will continue as scheduled unless a state of emergency is declared.'],
  ['paymentready', 'I understand payment instructions will be sent separately if my application is approved.'],
  ['contract', 'I have read and agree to the complete Vendor Participation Agreement and understand it becomes part of this application.']
];
const CONTRACT_TEXT = `VENDOR PARTICIPATION AGREEMENT

This Vendor Participation Agreement ("Agreement") is entered into between Trinity Crafters Market ("Organizer") and the vendor submitting this application ("Vendor").

1. Products and Eligibility: Vendor represents that all items offered for sale are handmade, handcrafted, personally created, or otherwise expressly approved in writing by Organizer. Commercially manufactured resale items, multi-level marketing products, and direct-sales products are prohibited unless Organizer gives prior written approval for a specific market date.
2. Application and Approval: Submission of an application does not guarantee acceptance. Organizer may approve, waitlist, or decline an application in its sole discretion. Vendor must accurately describe all products in the application and may sell only the products and product categories approved by Organizer.
3. Fees and Payment: All booth fees are non-refundable unless Organizer cancels the market or expressly agrees otherwise in writing. Vendor must pay all invoices and booth fees by the deadline provided by Organizer. Failure to pay by the deadline may result in cancellation of Vendor's space without a refund.
4. Booth Assignment: Organizer reserves all booth placement decisions. Vendor may not transfer, share, sublet, or switch a booth without prior written approval.
5. Market Hours and Attendance: Vendor must arrive and check in during the setup period announced by Organizer and must be ready before the market opens. Vendor must remain set up and present until 3:00 PM. Early departure is prohibited and may affect future participation.
6. Weather and Emergencies: Indoor markets continue rain or shine. Outdoor markets may be delayed, modified, moved, or cancelled at Organizer's discretion based on safety or weather conditions. During hurricane season, events continue as scheduled unless a state of emergency is declared or Organizer announces a change.
7. Setup, Safety, and Property: Vendor is responsible for all tables, displays, equipment, merchandise, and personal property brought to the market. Vendor must keep displays within the assigned booth area and maintain a safe setup. Vendor is responsible for damage caused by the Vendor or Vendor's setup, agents, employees, or guests.
8. Cleanup and Venue Rules: Vendor must remove all merchandise, display materials, trash, and personal property at the conclusion of the market and comply with all venue rules.
9. Conduct and Removal: Vendor must conduct business professionally and courteously. Organizer may remove Vendor from a market and may prohibit future participation for violation of this Agreement, inaccurate application information, unsafe conduct, prohibited products, or disruptive behavior.
10. Media Release: Vendor grants Organizer permission to photograph or record Vendor, Vendor's booth, and Vendor's products during market events and to use those images for market promotion without additional compensation.
11. Assumption of Risk and Release: Vendor understands that participation involves inherent risks. To the fullest extent allowed by law, Vendor releases Organizer, the venue, and their respective owners, employees, agents, and volunteers from claims arising from Vendor's participation, except to the extent caused by their gross negligence or intentional misconduct.
12. Indemnification: Vendor agrees to indemnify and hold harmless Organizer and the venue from claims, damages, costs, and expenses arising from Vendor's products, conduct, setup, or breach of this Agreement.
13. Modifications: Organizer may update market policies or this Agreement. The version accepted with this application will be retained with the submitted application.
14. Governing Terms: This Agreement may be accepted electronically. Vendor's electronic signature and submission of the application constitute agreement to all terms above.`;
const REFERRALS = ['Facebook', 'Friend or vendor', 'Google search', 'Returning vendor', 'Other'];

export function renderVendorApply(ctx, root) {
  const pub = ctx.state.publicData;
  if (!pub) { root.innerHTML = '<div class="card empty-card">Application data could not load. Check your connection and reload.</div>'; return; }
  const events = (pub.events || []).filter(e => String(e.date) >= todayStr()).sort((a, b) => String(a.date).localeCompare(String(b.date)));
  const byId = new Map(events.map(e => [String(e.id), e]));
  const chosen = new Map(); // eventId -> space
  const photos = [];
  let categoryId = '';
  let attemptId = null, attemptBusy = false;
  const counts = pub.counts || [];
  const usedFor = (eventId, catId) => counts.filter(x => String(x.event_id) === String(eventId) && String(x.category_id) === String(catId)).reduce((n, x) => n + Number(x.used || 0), 0);
  const limitTotal = (event, catId) => (pub.categoryLimits || []).filter(x => String(x.location_id) === String(event.location_id) && String(x.category_id) === String(catId)).reduce((n, x) => n + Number(x.capacity || 0), 0);
  const categoryOkFor = (event, catId) => {
    const limit = limitTotal(event, catId);
    return limit > 0 ? (limit - usedFor(event.id, catId)) > 0 : true;
  };
  const spacesOf = e => ['indoor', 'outdoor'].filter(s => Number(e[s + '_capacity'] || 0) > 0);
  const slotsLeft = (e, s) => Number(e[s + '_capacity'] || 0) - Number(e[s + '_used'] || 0);
  const venueNote = e => /hampton/i.test(e.location || '')
    ? 'This is our indoor market. Only indoor spaces are available. Rain or shine.'
    : /lutz|gateway/i.test(e.location || '') ? 'This is our outdoor market. Only outdoor spaces are available.' : '';
  const locations = [...new Set(events.map(e => e.location).filter(Boolean))];

  root.innerHTML = `
    <p class="eyebrow">Apply</p>
    <h2 class="display">Vendor application</h2>
    <p class="lede">One application can cover several market dates. Applying as <strong>${esc(ctx.state.user.email)}</strong>.</p>
    <form id="v2-apply" novalidate>
      <section class="card">
        <h3 class="section-title">Your details</h3>
        <label class="sheet-field">Your name<input name="name" autocomplete="name" maxlength="200" required></label>
        <label class="sheet-field">Business name<input name="business" autocomplete="organization" maxlength="200" required></label>
        <label class="sheet-field">Phone<input name="phone" type="tel" autocomplete="tel" maxlength="30" required></label>
        <label class="sheet-field">Billing address<input name="billing_address" autocomplete="street-address" maxlength="500" placeholder="Street, city, state, ZIP"></label>
        <label class="sheet-field">What do you sell?<textarea name="description" rows="4" maxlength="5000" required placeholder="Describe your handmade products"></textarea></label>
        <p class="note" id="v2-apply-scan"></p>
      </section>
      <section class="card">
        <h3 class="section-title">Market dates</h3>
        <label class="sheet-field">Location
          <select id="v2-apply-location"><option value="">All locations</option>${locations.map(l => `<option>${esc(l)}</option>`).join('')}</select>
        </label>
        <div id="v2-apply-dates"></div>
        <div id="v2-apply-chosen"></div>
      </section>
      <section class="card">
        <h3 class="section-title">Category</h3>
        <label class="sheet-field">What best describes what you sell?<select id="v2-apply-category"></select></label>
        <label class="sheet-field">Need a category exception? Tell us (optional)<textarea name="category_exception" rows="2" maxlength="2000" placeholder="Different items than your category covers? Explain here."></textarea></label>
      </section>
      <section class="card">
        <h3 class="section-title">Product photos</h3>
        <p class="note">Add between 1 and 5 clear photos of the products you plan to sell.</p>
        <label class="sheet-field">Photos<input id="v2-apply-photos" type="file" accept="image/jpeg,image/png,image/webp" multiple></label>
        <div id="v2-apply-thumbs" class="photo-thumbs"></div>
      </section>
      <section class="card">
        <h3 class="section-title">How did you hear about us?</h3>
        <label class="sheet-field">Referral source
          <select name="referral_source" required><option value="">Choose one</option>${REFERRALS.map(r => `<option>${esc(r)}</option>`).join('')}</select>
        </label>
        <label class="sheet-field" id="v2-apply-group-wrap" hidden>Which Facebook group?<input name="referral_group" maxlength="200"></label>
      </section>
      <section class="card">
        <h3 class="section-title">Agreements</h3>
        ${AGREEMENTS.map(([key, text]) => `<label class="checkline"><input type="checkbox" name="agree_${key}" value="yes"><span>${esc(text)}</span></label>`).join('')}
        <details class="contract"><summary>Read the complete Vendor Participation Agreement</summary><pre>${esc(CONTRACT_TEXT)}</pre></details>
        <label class="sheet-field">Type your full name as your electronic signature<input name="signature" autocomplete="name" maxlength="200" required></label>
        <div class="vendor-actions"><button class="btn primary" id="v2-apply-submit" type="submit">Submit application</button></div>
        <p class="note">Payment is never collected with this application. If approved, payment instructions arrive separately.</p>
      </section>
    </form>`;
  const form = root.querySelector('#v2-apply');
  const $ = s => root.querySelector(s);
  // Named access (form.name) is shadowed by HTMLFormElement's own
  // properties — always go through elements.namedItem.
  const F = n => form.elements.namedItem(n);
  const FV = n => F(n)?.value ?? '';

  // Application Recovery draft tracking (application-attempt), same as
  // the legacy form: a draft row appears once the form has real content,
  // then submitting / failed / completed as the submit resolves.
  const snapshot = () => ({
    name: FV('name'), business: FV('business'), phone: FV('phone'), billing_address: FV('billing_address'),
    description: FV('description'), category_id: categoryId,
    referral_source: FV('referral_source'), referral_group: FV('referral_group'),
    signature: FV('signature'), dates: [...chosen].map(([id, space]) => ({ id, space })),
    photos: photos.map(p => p.path)
  });
  async function saveAttempt(status, step, errorMessage = '', applicationId = null) {
    if (attemptBusy) return;
    attemptBusy = true;
    try {
      if (!attemptId) attemptId = (crypto.randomUUID ? crypto.randomUUID() : 'attempt-' + Date.now());
      await api('application-attempt', { id: attemptId, status, step, error_message: errorMessage, snapshot: snapshot(), application_id: applicationId });
    } catch { /* tracking never blocks the application itself */ }
    attemptBusy = false;
  }
  let draftTimer = 0;
  const queueDraft = () => {
    clearTimeout(draftTimer);
    draftTimer = setTimeout(() => {
      const s = snapshot();
      if (s.name || s.business || s.phone || s.description || s.dates.length || s.photos.length) saveAttempt('draft', 'Application form in progress');
    }, 700);
  };
  form.addEventListener('input', queueDraft);
  form.addEventListener('change', queueDraft);

  // Category select with per-date availability labels (rebuilt whenever
  // the chosen dates change, like the legacy form).
  function drawCategory() {
    const sel = $('#v2-apply-category');
    const dates = [...chosen.keys()];
    const avail = [], full = [];
    for (const c of pub.categories || []) {
      if (!dates.length) { avail.push({ c, label: c.name }); continue; }
      const okCount = dates.filter(id => categoryOkFor(byId.get(id), c.id)).length;
      if (okCount > 0) avail.push({ c, label: `${c.name} — ${okCount} of ${dates.length} date(s) available` });
      else full.push(c);
    }
    sel.innerHTML = `<option value="">Choose a category…</option>` +
      avail.map(x => `<option value="${esc(x.c.id)}" ${String(x.c.id) === String(categoryId) ? 'selected' : ''}>${esc(x.label)}</option>`).join('') +
      (full.length ? `<optgroup label="Unavailable for selected dates">${full.map(c => `<option disabled>${esc(c.name)} — fully booked</option>`).join('')}</optgroup>` : '');
    if (categoryId && !avail.some(x => String(x.c.id) === String(categoryId))) categoryId = '';
    sel.value = categoryId;
  }
  $('#v2-apply-category').onchange = e => { categoryId = e.target.value; queueDraft(); queueScan(); };

  function drawDates() {
    const loc = $('#v2-apply-location').value;
    $('#v2-apply-dates').innerHTML = events.filter(e => !loc || e.location === loc).map(e => {
      const isChosen = chosen.has(String(e.id));
      const avail = spacesOf(e).map(s => `${s === 'indoor' ? 'Indoor' : 'Outdoor'} ${slotsLeft(e, s) > 0 ? slotsLeft(e, s) + ' left' : 'full'}`).join(' · ');
      const closed = !e.open || e.sold_out;
      return `<div class="apply-date">
        <div><strong>${esc(nice(e.date))}</strong><br><span class="note">${esc(e.location || '')}${e.market_name ? ' — ' + esc(e.market_name) : ''}</span>
        <br><span class="note">${closed ? 'Closed or sold out' : esc(avail)}</span>
        ${venueNote(e) ? `<br><span class="note">${esc(venueNote(e))}</span>` : ''}</div>
        ${closed ? '' : `<button type="button" class="btn small ${isChosen ? 'danger' : 'primary'}" data-date-toggle="${esc(e.id)}">${isChosen ? 'Remove' : 'Add date'}</button>`}
      </div>`;
    }).join('') || '<p class="note">No upcoming dates at this location.</p>';
    root.querySelectorAll('[data-date-toggle]').forEach(b => b.onclick = () => {
      const id = b.dataset.dateToggle, e = byId.get(id);
      if (chosen.has(id)) chosen.delete(id);
      else {
        const open = spacesOf(e).filter(s => slotsLeft(e, s) > 0);
        if (!open.length) { ctx.toast('That date is full.', true); return; }
        chosen.set(id, open[0]);
      }
      drawDates(); drawChosen(); drawCategory(); queueDraft(); queueScan();
    });
    drawChosen();
  }
  function drawChosen() {
    $('#v2-apply-chosen').innerHTML = chosen.size ? `<h4 class="section-title">Chosen dates</h4>` + [...chosen].map(([id, space]) => {
      const e = byId.get(id);
      return `<div class="apply-date"><div><strong>${esc(nice(e.date))}</strong> — ${esc(e.location || '')}</div>
        <label class="sheet-field">Space<select data-date-space="${esc(id)}">${spacesOf(e).map(s => `<option value="${s}" ${s === space ? 'selected' : ''} ${slotsLeft(e, s) <= 0 && s !== space ? 'disabled' : ''}>${s === 'indoor' ? 'Indoor' : 'Outdoor'} — ${money(e[s + '_price'])}${slotsLeft(e, s) <= 0 ? ' (full)' : ''}</option>`).join('')}</select></label></div>`;
    }).join('') : '<p class="note">No dates chosen yet — add at least one date above.</p>';
    root.querySelectorAll('[data-date-space]').forEach(sel => sel.onchange = () => { chosen.set(sel.dataset.dateSpace, sel.value); queueDraft(); });
  }
  $('#v2-apply-location').onchange = drawDates;

  // Category conflict scan (server-side): notes likely category clashes
  // for the chosen dates so the vendor can add an exception note.
  let scanTimer = 0;
  function queueScan() {
    clearTimeout(scanTimer);
    scanTimer = setTimeout(async () => {
      const note = $('#v2-apply-scan');
      const cat = (pub.categories || []).find(c => String(c.id) === String(categoryId));
      if (!FV('description').trim() && !cat && !chosen.size) { note.textContent = ''; return; }
      try {
        const r = await api('category-scan', { description: FV('description'), category: cat?.name || '', dates: [...chosen.keys()] });
        if (r.requires_review || (r.conflicts || []).length) {
          note.innerHTML = '<strong>Heads up:</strong> ' + esc((r.conflicts || []).join(' ') || 'Your products may overlap a category that is full on a chosen date.') + ' You can still apply — add a note in the category exception box and the organizer will review.';
        } else note.textContent = '';
      } catch { note.textContent = ''; }
    }, 600);
  }
  F('description').addEventListener('input', queueScan);

  // Photos: signed-ticket upload, identical flow to the legacy form.
  async function uploadPhoto(file) {
    const ticket = await api('upload-ticket', { type: file.type, size: file.size });
    const body = new FormData();
    body.append('cacheControl', '3600');
    body.append('', file);
    const r = await fetch(ticket.url, { method: 'PUT', body });
    if (!r.ok) throw Error('Photo upload failed. Check your connection and try again.');
    await api('upload-complete', { path: ticket.path });
    return { path: ticket.path, url: URL.createObjectURL(file) };
  }
  function drawThumbs() {
    $('#v2-apply-thumbs').innerHTML = photos.map((p, i) => `<span class="thumb"><img src="${p.url}" alt="Product photo ${i + 1}"><button type="button" data-photo-remove="${i}" aria-label="Remove photo ${i + 1}">×</button></span>`).join('');
    root.querySelectorAll('[data-photo-remove]').forEach(b => b.onclick = () => { photos.splice(Number(b.dataset.photoRemove), 1); drawThumbs(); queueDraft(); });
  }
  $('#v2-apply-photos').onchange = async e => {
    const files = [...e.target.files];
    e.target.value = '';
    for (const file of files) {
      if (photos.length >= 5) { ctx.toast('You can add up to 5 photos.', true); break; }
      try { photos.push(await uploadPhoto(file)); drawThumbs(); queueDraft(); }
      catch (err) { ctx.toast(err.message, true); }
    }
  };

  F('referral_source').onchange = () => { $('#v2-apply-group-wrap').hidden = FV('referral_source') !== 'Facebook'; };

  form.onsubmit = async e => {
    e.preventDefault();
    const fail = m => { ctx.toast(m, true); };
    const digits = FV('phone').replace(/\D/g, '');
    if (!FV('name').trim() || !FV('business').trim()) return fail('Add your name and business name.');
    if (digits.length < 10 || digits.length > 15) return fail('Enter a valid phone number.');
    if (!FV('description').trim()) return fail('Describe what you sell.');
    if (!chosen.size) return fail('Add at least one market date.');
    if (!categoryId) return fail('Choose the category that best describes what you sell.');
    if (!photos.length) return fail('Add at least one product photo.');
    if (!FV('referral_source')) return fail('Tell us how you heard about us.');
    if (FV('referral_source') === 'Facebook' && !FV('referral_group').trim()) return fail('Tell us which Facebook group you saw us in.');
    const agreements = {};
    for (const [key] of AGREEMENTS) {
      agreements[key] = !!F('agree_' + key)?.checked;
      if (!agreements[key]) return fail('Please review and accept every agreement.');
    }
    if (FV('signature').trim().length < 2) return fail('Type your full name as your signature.');
    const btn = $('#v2-apply-submit');
    btn.disabled = true; btn.textContent = 'Submitting…';
    await saveAttempt('submitting', 'Submitting application');
    try {
      // Payload keys are the server's, verified against the apply
      // handler: category (id), exception, billing_address, and the
      // signature rides INSIDE agreements — the handler rejects the
      // submission without agreements.signature.
      const result = await api('apply', {
        name: FV('name').trim(), business: FV('business').trim(), phone: FV('phone').trim(),
        billing_address: FV('billing_address').trim(),
        description: FV('description').trim(), category: categoryId,
        exception: FV('category_exception').trim(),
        referral_source: FV('referral_source'), referral_group: FV('referral_group').trim(),
        photos: photos.map(p => p.path),
        dates: [...chosen].map(([id, space]) => ({ id, space })),
        agreements: { ...agreements, signature: FV('signature').trim() }
      });
      await saveAttempt('completed', 'Application submitted', '', result.id || result.application_id || null);
      ctx.toast('Application submitted — watch your email for the decision.');
      await ctx.refreshData();
      ctx.navigate('vbookings');
    } catch (err) {
      await saveAttempt('failed', 'Application submission failed', err.message);
      ctx.toast(err.message, true);
      btn.disabled = false; btn.textContent = 'Submit application';
    }
  };

  drawDates(); drawCategory();
  // Profile prefill (§13.7): the saved profile fills the form so a
  // returning vendor mostly just picks dates and photos.
  fnq('vendor-profile', 'get').then(r => {
    const p = r?.prefill || {};
    if (p.name && !FV('name')) F('name').value = p.name;
    if (p.business && !FV('business')) F('business').value = p.business;
    if (p.phone && !FV('phone')) F('phone').value = p.phone;
    // The profile's saved address pre-fills the billing address, like
    // the legacy form (the profile payload carries it as `address`).
    if (p.address && !FV('billing_address')) F('billing_address').value = p.address;
    if (p.description && !FV('description')) F('description').value = p.description;
    if (p.category_id) { categoryId = p.category_id; drawCategory(); }
  }).catch(() => {});
}

// -------------------------------------------------------------- profile ---
const MISSING_LABEL = { business: 'your business name', name: 'your contact name', category_id: 'your category', description: 'your products', phone: 'your phone number', address: 'your mailing address', space_preference: 'your space preference', website: 'your website', social_links: 'your social links' };
const SPACE_LABEL = { indoor: 'Indoor', outdoor: 'Outdoor', none: 'No preference' };

export function renderVendorProfile(ctx, root) {
  root.innerHTML = `
    <p class="eyebrow">My Profile</p>
    <h2 class="display">Your vendor profile</h2>
    <p class="lede">Keep these details once — every future application starts filled in.</p>
    <div id="v2-profile-box"><div class="card empty-card">Loading your profile…</div></div>`;
  const box = root.querySelector('#v2-profile-box');
  const categories = ctx.state.publicData?.categories || [];

  async function load(note = '') {
    let r;
    try {
      r = await fnq('vendor-profile', 'get');
    } catch (e) {
      box.innerHTML = `<div class="card empty-card"><p><strong>Your profile couldn't load.</strong></p><p class="muted">${esc(e.message)}</p></div>`;
      return;
    }
    const p = r.profile || {};
    const c = p.completeness;
    const hint = !c ? '' : c.percent >= 100
      ? '<p class="note">Your profile is complete — applying takes seconds.</p>'
      : `<p class="note">Your profile is ${c.percent}% complete${(c.missing || [])[0] ? ` — add ${esc(MISSING_LABEL[c.missing[0]] || c.missing[0])} so applying takes seconds` : ''}.</p>`;
    box.innerHTML = `
      <form id="v2-profile-form" class="card">
        ${hint}
        ${note ? `<p class="note"><strong>${esc(note)}</strong></p>` : ''}
        ${(p.linked_imported_ids || []).length ? '<p class="note">Your past market bookings from our records are linked to this account.</p>' : ''}
        <label class="sheet-field">Business name<input name="business" value="${esc(p.business || '')}" maxlength="200"></label>
        <label class="sheet-field">Contact name<input name="name" value="${esc(p.name || '')}" maxlength="200"></label>
        <label class="sheet-field">Category
          <select name="category_id"><option value="">Choose a category…</option>${categories.map(cat => `<option value="${esc(cat.id)}" ${String(p.category_id || '') === String(cat.id) ? 'selected' : ''}>${esc(cat.name)}</option>`).join('')}</select>
        </label>
        <label class="sheet-field">Phone<input name="phone" value="${esc(p.phone || '')}" maxlength="30"></label>
        <label class="sheet-field">Mailing address<textarea name="address" rows="2" maxlength="500" placeholder="Street, city, state, ZIP">${esc(p.address || '')}</textarea></label>
        <label class="sheet-field">What you sell<textarea name="description" rows="3" maxlength="5000">${esc(p.description || '')}</textarea></label>
        <label class="sheet-field">Space preference
          <select name="space_preference"><option value="" ${!p.space_preference ? 'selected' : ''}>Not set</option>${Object.entries(SPACE_LABEL).map(([v, l]) => `<option value="${v}" ${p.space_preference === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
        </label>
        <label class="sheet-field">Website<input name="website" value="${esc(p.website || '')}" maxlength="500" placeholder="https://…"></label>
        <label class="sheet-field">Social links<input name="social_links" value="${esc(typeof p.social_links === 'string' ? p.social_links : '')}" maxlength="1000" placeholder="Instagram, Facebook…"></label>
        <div class="vendor-actions"><button class="btn primary small">Save profile</button></div>
      </form>`;
    box.querySelector('#v2-profile-form').onsubmit = async e => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const body = { action: 'save' };
      for (const k of ['business', 'name', 'category_id', 'phone', 'address', 'description', 'space_preference', 'website', 'social_links']) body[k] = fd.get(k) ?? '';
      try {
        const v = await fnq('vendor-profile', 'save', body);
        ctx.toast('Profile saved.');
        // Re-render from the server's saved profile (state rule).
        await load('Profile saved — this is what the server has now.');
        ctx.state.vendorProfile = v.profile;
      } catch (err) { ctx.toast(err.message, true); }
    };
  }
  load();
}
