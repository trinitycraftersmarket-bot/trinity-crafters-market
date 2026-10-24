// Applications screen: the review queue for vendor applications on
// upcoming market dates (audit §2.1 — a daily driver). Ported from the
// legacy Applications panel: same booking-action endpoint, same payloads,
// same split between active applications and the wait-list / closed list.
// Every action is a server call, then a full re-fetch of the admin payload,
// then a re-render from it — the screen never edits a local copy (§1 rule 1).
//
// Category flags: the legacy panel re-runs a client-side category analysis
// from a legacy module. v2 cannot import legacy modules, so the flag here
// uses the scan SAVED on the application at submit time
// (agreements.category_scan) — the same data the legacy review reads first.
import { api, fn, esc, money, nice, niceShort } from './api.js?v=20261023-16';
import { normalizeSpace } from './data.js?v=20261023-16';

const STATUS_LABEL = { pending: 'Pending', approved: 'Approved', held: 'Payment due', paid: 'Paid', waitlist: 'Wait-list', declined: 'Declined', cancelled: 'Cancelled', expired: 'Expired' };
const STATUS_CLASS = { pending: 'warn', approved: 'neutral', held: 'warn', paid: 'ok', waitlist: 'neutral', declined: 'bad', cancelled: 'bad', expired: 'bad' };
const ACTIVE_STATUSES = ['pending', 'approved', 'held', 'paid', 'expired'];
const CLOSED_STATUSES = ['waitlist', 'cancelled', 'declined'];

let view = { q: '', eventId: '', status: '', category: '', sort: 'date', closedQ: '', closedStatus: '' };

// Credit manual path (audit §19, full-port Stage B): the vendor-credit
// function's applicant-credits / application-conflicts payloads, loaded
// alongside the admin payload and re-drawn in when they land — the same
// async pattern the classic review uses. First available credit per
// vendor email wins, exactly like the classic map.
let creditMap = null, conflictMap = null;
const CREDIT_STATUSES = ['pending', 'waitlist', 'approved', 'held'];
const creditFor = b => (creditMap && CREDIT_STATUSES.includes(b.status))
  ? creditMap[String(b.email || '').trim().toLowerCase()] || null : null;

export function savedCategoryFlag(b) {
  const scan = b?.agreements?.category_scan;
  if (!scan || b.status === 'paid' || b.status === 'waitlist' || b.category_review_approved_at) return null;
  const conflicts = Array.isArray(scan.conflicts) ? [...new Set(scan.conflicts.map(x => x.category).filter(Boolean))] : [];
  const overlaps = Array.isArray(scan.matched_categories) ? scan.matched_categories.filter(x => x && x !== b.category) : [];
  if (!scan.requires_review && !conflicts.length && !overlaps.length && scan.selected_category_match !== false) return null;
  return { conflicts, overlaps, mismatch: scan.selected_category_match === false };
}
const needsReview = b => b.status === 'pending' || b.ban_flagged || !!savedCategoryFlag(b);

function upcomingApps(admin) {
  const ids = new Set((admin.events || []).map(e => String(e.id)));
  return (admin.applications || []).filter(b => ids.has(String(b.event_id)));
}
function matches(b, q) {
  if (!q) return true;
  return [b.business, b.name, b.email, b.phone, b.category, b.id, b.location].some(v => String(v || '').toLowerCase().includes(q));
}
function sortRows(rows, sort) {
  const byBiz = (x, y) => String(x.business || x.name || '').localeCompare(String(y.business || y.name || ''), undefined, { sensitivity: 'base' });
  return [...rows].sort((x, y) => sort === 'business' ? byBiz(x, y)
    : sort === 'status' ? String(x.status).localeCompare(String(y.status)) || String(x.date).localeCompare(String(y.date))
    : String(x.date).localeCompare(String(y.date)) || byBiz(x, y));
}
function groupedHtml(rows, cardFn) {
  const groups = new Map();
  for (const b of rows) {
    const key = b.date ? String(b.date).slice(0, 10) : 'none';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(b);
  }
  return [...groups.entries()].map(([date, list]) => `
    <h3 class="section-title">${date === 'none' ? 'No market date' : esc(nice(date))} · ${list.length} booking${list.length === 1 ? '' : 's'}</h3>
    <div class="vendor-list">${list.map(cardFn).join('')}</div>`).join('');
}

export function renderApplications(ctx, root) {
  root.innerHTML = `
    <p class="eyebrow">Vendors</p>
    <h2 class="display">Applications</h2>
    <p class="lede">Review new applications for upcoming dates. Approving reserves the booth and category; the payment deadline starts when the invoice is sent. Wait-list offers and category positions live on the Wait List screen.</p>
    <div class="stat-grid" id="v2-app-summary"></div>
    <div class="card filter-card">
      <div class="search"><input id="v2-app-search" type="search" placeholder="Search business, vendor, email, phone or booking ID…" autocomplete="off" value="${esc(view.q)}"></div>
      <div class="filter-row">
        <label class="picker-label">Market date<select id="v2-app-event" class="picker">${''}</select></label>
        <label class="picker-label">Status<select id="v2-app-status" class="picker">
          <option value="">All active statuses</option><option value="attention">Needs review</option>
          ${ACTIVE_STATUSES.map(s => `<option value="${s}">${STATUS_LABEL[s]}</option>`).join('')}
        </select></label>
        <label class="picker-label">Category<select id="v2-app-category" class="picker"></select></label>
        <label class="picker-label">Sort<select id="v2-app-sort" class="picker">
          <option value="date">Market date — soonest</option><option value="business">Business A–Z</option><option value="status">Status</option>
        </select></label>
      </div>
    </div>
    <div id="v2-app-list"></div>
    <h3 class="section-title">Wait-list / closed applications</h3>
    <div class="card filter-card">
      <div class="search"><input id="v2-closed-search" type="search" placeholder="Search the closed list…" autocomplete="off" value="${esc(view.closedQ)}"></div>
      <div class="filters" role="group" aria-label="Closed status">
        ${[['', 'All closed'], ['waitlist', 'Wait-list'], ['cancelled', 'Cancelled'], ['declined', 'Declined']].map(([k, t]) => `<button class="chip-btn ${view.closedStatus === k ? 'active' : ''}" data-closed="${k}">${t}</button>`).join('')}
      </div>
    </div>
    <div id="v2-closed-list"></div>`;

  const admin = () => ctx.state.admin;
  const all = () => upcomingApps(admin());
  const activeApps = () => all().filter(b => !CLOSED_STATUSES.includes(b.status));
  const closedApps = () => all().filter(b => CLOSED_STATUSES.includes(b.status));
  const findBooking = id => (admin().applications || []).find(b => String(b.id) === String(id));

  // One mutation path for the whole screen (same rule as Event Day).
  const mutate = async (call, okMsg) => {
    try {
      await call();
      await ctx.refreshAdmin();
      draw();
      if (okMsg) ctx.toast(okMsg);
    } catch (e) { ctx.toast(e.message, true); }
  };
  const bookingAction = (id, payload, okMsg) => mutate(() => api('booking', { id, ...payload }), okMsg);

  // §19 flag + who-sells-what conflict panel (owner's exact line format:
  // "<Business> sells <products>", "products not listed" when the record
  // carries none — the server never invents product text).
  function creditFlagHtml(b) {
    const c = creditFor(b);
    return c ? `<p class="note">💳 Holds a ${money(c.remaining_amount)} credit from ${esc(nice(c.source_date))}.</p>` : '';
  }
  function conflictPanelHtml(b) {
    const c = conflictMap?.[b.id];
    if (!c) return '';
    const line = (business, sells) => `${esc(business || 'Vendor')} sells ${esc(String(sells || '').trim() || 'products not listed')}`;
    return `<p class="note flag-note"><strong>⚠ Category conflict — who sells what (${esc(c.category)} is full for this date)</strong><br>${line(c.applicant.business, c.applicant.sells)}<br>${(c.vendors || []).map(v => line(v.business, v.sells)).join('<br>')}</p>`;
  }
  function approveCreditSheet(b) {
    const c = creditFor(b);
    if (!c) return;
    ctx.openSheet(`
      <h3 class="sheet-title">Approve &amp; apply credit</h3>
      <p><strong>${esc(b.business || b.name || 'Vendor')}</strong> · ${esc(niceShort(b.date))} · ${money(b.price)}</p>
      <p class="note">Approve this booking and settle it from their ${money(c.remaining_amount)} credit (from ${esc(nice(c.source_date))})?<br><br>This is your organizer override: it approves even if the category or booths are full. If the credit is smaller than the ${money(b.price)} price, the rest stays due. The credit application is audit-logged.</p>
      <div class="sheet-actions"><button class="btn" data-sheet-close>Cancel</button><button class="btn primary" id="v2-approve-credit-go">Approve &amp; apply credit</button></div>`);
    ctx.sheetEl.querySelector('#v2-approve-credit-go').onclick = async () => {
      ctx.closeSheet();
      try {
        const r = await fn('vendor-credit', { action: 'redeem-for-application', booking_id: b.id, credit_id: c.id });
        await ctx.refreshAdmin();
        await loadCreditData();
        draw();
        ctx.toast(r.amount_due > 0
          ? 'Approved. ' + money(r.applied) + ' paid from credit; ' + money(r.amount_due) + ' remains due.'
          : 'Approved and paid in full from credit (' + money(r.applied) + ').');
      } catch (e) { ctx.toast(e.message, true); }
    };
  }
  async function loadCreditData() {
    try {
      const r = await fn('vendor-credit', { action: 'applicant-credits' });
      const m = {};
      for (const c of r.credits || []) { const k = String(c.email || '').trim().toLowerCase(); if (!m[k]) m[k] = c; }
      creditMap = m;
    } catch { creditMap = {}; }
    try {
      const r = await fn('vendor-credit', { action: 'application-conflicts' });
      const m = {};
      for (const c of r.conflicts || []) m[c.booking_id] = c;
      conflictMap = m;
    } catch { conflictMap = {}; }
  }

  function cardHtml(b) {
    const flag = savedCategoryFlag(b);
    const space = normalizeSpace(b.space);
    return `<article class="card vendor" data-row="${esc(b.id)}">
      <div class="vendor-top">
        <div><h3>${esc(b.business || b.name || 'Vendor')}</h3>
        <div class="contact">${esc(b.name || '')}${b.category ? ' · ' + esc(b.category) : ''}</div></div>
        <span class="badge ${space === 'outdoor' ? 'outside' : 'inside'}">${space === 'outdoor' ? 'OUTSIDE' : 'INSIDE'}</span>
      </div>
      <div class="chips">
        <span class="status ${STATUS_CLASS[b.status] || 'neutral'}">${STATUS_LABEL[b.status] || esc(b.status)}</span>
        <span class="status neutral">${esc(niceShort(b.date))}</span>
        <span class="status neutral">${money(b.price)}</span>
        ${b.location ? `<span class="status neutral">${esc(b.location)}</span>` : ''}
      </div>
      <p class="note"><strong>Contact:</strong> ${esc(b.email || '')}${b.phone ? ' · ' + esc(b.phone) : ''}<br><strong>Booking ID:</strong> ${esc(b.id || '—')}</p>
      ${b.description ? `<p class="note"><strong>Sells:</strong> ${esc(String(b.description).slice(0, 180))}${String(b.description).length > 180 ? '…' : ''}</p>` : ''}
      ${b.ban_flagged ? `<p class="note flag-note"><strong>⚠ Potential banned-vendor match:</strong> ${esc(b.ban_match_reason || 'Review this application before approval.')}</p>` : ''}
      ${flag ? `<p class="note flag-note"><strong>⚠ Category review needed</strong> — selected: ${esc(b.category || 'Not selected')}${flag.overlaps.length ? '<br>Products appear to fit: ' + flag.overlaps.map(esc).join(' · ') : ''}${flag.conflicts.length ? '<br><strong>Filled/sold-out conflict: ' + flag.conflicts.map(esc).join(' · ') + '</strong>' : ''}</p>` : ''}
      ${creditFlagHtml(b)}
      ${conflictPanelHtml(b)}
      ${b.status === 'held' && b.hold_until ? `<p class="note"><strong>Payment deadline:</strong> ${esc(new Date(b.hold_until).toLocaleString('en-US', { timeZone: 'America/New_York' }))} Eastern</p>` : ''}
      ${b.status === 'declined' && b.decision_reason ? `<p class="note"><strong>Decline reason:</strong> ${esc(b.decision_reason)}</p>` : ''}
      <div class="vendor-actions">
        ${primaryActions(b)}
        ${creditFor(b) ? `<button class="btn primary small" data-act="approve-credit" data-id="${esc(b.id)}">Approve &amp; apply ${money(creditFor(b).remaining_amount)} credit</button>` : ''}
        <button class="btn small ghost" data-act="details" data-id="${esc(b.id)}">Details &amp; photos</button>
        <button class="btn small ghost" data-act="more" data-id="${esc(b.id)}">More ⋯</button>
      </div>
    </article>`;
  }
  function primaryActions(b) {
    const id = esc(b.id);
    if (b.status === 'pending' || b.status === 'waitlist') return `
      <button class="btn primary small" data-act="status" data-status="approved" data-id="${id}">Approve</button>
      <button class="btn small" data-act="status" data-status="declined" data-id="${id}">Decline</button>
      ${savedCategoryFlag(b) ? `<button class="btn small" data-act="catapprove" data-id="${id}">Approve category</button>` : ''}`;
    if (b.status === 'approved') return `<button class="btn primary small" data-act="paypal-invoice" data-id="${id}">Create &amp; send PayPal invoice</button>`;
    if (b.status === 'held') return `
      <button class="btn primary small" data-act="reminder" data-id="${id}">Email payment warning</button>
      <button class="btn small" data-act="paypal-sync" data-id="${id}">Check PayPal payment</button>`;
    if (b.status === 'expired' || b.status === 'cancelled') return `<button class="btn primary small" data-act="reinstate" data-id="${id}">Reinstate booking</button>`;
    return '';
  }
  function moreSheet(b) {
    const items = [];
    if (['pending', 'approved', 'held', 'expired'].includes(b.status)) items.push(['waitlist', 'Move to wait-list', 'Releases the booth and emails the vendor']);
    if (b.status === 'approved') items.push(['held', 'Invoice sent manually', 'Starts the 24-hour payment deadline now']);
    if (b.status === 'held') items.push(['paid', 'Record other payment', 'Cash, check, card or other — marks the booking paid']);
    if (['approved', 'held', 'paid', 'expired', 'waitlist'].includes(b.status)) items.push(['cancelled', 'Cancel booking', 'Releases the booth; reason goes in the vendor email']);
    items.push(['ban', 'Ban vendor', 'Blocks future bookings; the reason stays private']);
    ctx.openSheet(`
      <h3 class="sheet-title">${esc(b.business || b.name || 'Vendor')}</h3>
      <p class="note">${esc(niceShort(b.date))} · ${esc(b.category || '')} · ${STATUS_LABEL[b.status] || esc(b.status)}</p>
      <div class="sheet-menu">${items.map(([act, t, d]) => `<button class="menu-item" data-more="${act}"><span><b>${t}</b><span>${d}</span></span><span class="chev">›</span></button>`).join('')}</div>`);
    ctx.sheetEl.querySelectorAll('[data-more]').forEach(btn => btn.onclick = () => {
      const act = btn.dataset.more;
      if (act === 'waitlist') waitlistSheet(b);
      else if (act === 'ban') banSheet(b);
      else statusSheet(b, act);
    });
  }
  function statusSheet(b, status) {
    const flag = status === 'approved' ? savedCategoryFlag(b) : null;
    const related = status === 'held' && b.application_id ? (admin().applications || []).filter(x => x.application_id === b.application_id && x.status === 'approved') : [];
    const titles = { approved: 'Approve this date', held: 'Start the payment deadline', paid: 'Confirm received payment', declined: 'Decline this date', cancelled: 'Cancel this booking' };
    ctx.openSheet(`
      <h3 class="sheet-title">${titles[status]}</h3>
      <p><strong>${esc(b.business || b.name || 'Vendor')}</strong> · ${esc(niceShort(b.date))} · ${money(b.price)}</p>
      <form id="v2-status-form">
        ${status === 'approved' ? `<p class="note">Approval reserves booth and category inventory. The payment deadline starts only after you send the invoice.</p>
          <label class="checkline"><input type="checkbox" name="exception"> Approve a category exception for this booking</label>
          ${flag ? `<p class="note flag-note"><strong>${flag.conflicts.length ? 'Sold-out category conflict' : 'Category conflict review'}</strong><br>Review the comparison under Details &amp; photos before approving.</p>
          <label class="checkline"><input type="checkbox" name="cat_override" required> I reviewed the category conflict and approve this vendor anyway</label>` : ''}` : ''}
        ${status === 'declined' ? `<label class="sheet-field">Reason for denial (included in the vendor email)<textarea name="reason" rows="3" maxlength="2000" required></textarea></label>` : ''}
        ${status === 'cancelled' ? `<label class="sheet-field">Reason for cancellation (included in the vendor email)<textarea name="reason" rows="3" maxlength="2000" required></textarea></label><p class="note">This releases the booth. No payment refund is issued by the website.</p>` : ''}
        ${status === 'held' ? `<p class="note">Send your invoice first. Saving starts a 24-hour hold immediately.</p>
          ${related.length > 1 ? `<label class="checkline"><input type="checkbox" name="apply_all" checked> Apply this invoice reference and hold to all ${related.length} approved dates on this application</label>` : ''}
          <label class="sheet-field">Invoice reference<input name="reference" required></label>` : ''}
        ${status === 'paid' ? `<label class="sheet-field">Payment method<select name="payment_method"><option>GoDaddy Payments</option><option>PayPal</option><option>Cash</option><option>Check</option><option>Other</option></select></label>
          <label class="sheet-field">GoDaddy transaction ID / payment reference<input name="reference"></label>` : ''}
        <div class="sheet-actions"><button type="button" class="btn" data-sheet-close>Cancel</button><button class="btn ${status === 'declined' || status === 'cancelled' ? 'danger' : 'primary'}">Confirm</button></div>
      </form>`);
    ctx.sheetEl.querySelector('#v2-status-form').onsubmit = e => {
      e.preventDefault();
      const f = new FormData(e.target);
      ctx.closeSheet();
      bookingAction(b.id, {
        status,
        reference: f.get('reference') || undefined,
        payment_method: f.get('payment_method') || undefined,
        reason: f.get('reason') || undefined,
        exception: f.get('exception') === 'on',
        apply_all: f.get('apply_all') === 'on'
      }, { approved: 'Application approved.', declined: 'Application declined.', held: 'Payment deadline started.', paid: 'Payment recorded.', cancelled: 'Booking cancelled.' }[status]);
    };
  }
  function waitlistSheet(b) {
    ctx.openSheet(`
      <h3 class="sheet-title">Move to wait-list</h3>
      <p><strong>${esc(b.business || b.name || 'Vendor')}</strong>${b.date ? ' · ' + esc(niceShort(b.date)) : ''}</p>
      <form id="v2-waitlist-form">
        <label class="sheet-field">Reason for moving to wait-list (included in the vendor email)<textarea name="reason" rows="3" maxlength="2000" required></textarea></label>
        <p class="note">This releases the booth, stops any active hold, and emails the vendor automatically. If a PayPal invoice is linked, it will be cancelled before the move is completed.</p>
        <div class="sheet-actions"><button type="button" class="btn" data-sheet-close>Cancel</button><button class="btn primary">Move to wait-list</button></div>
      </form>`);
    ctx.sheetEl.querySelector('#v2-waitlist-form').onsubmit = e => {
      e.preventDefault();
      const reason = new FormData(e.target).get('reason');
      ctx.closeSheet();
      bookingAction(b.id, { status: 'waitlist', reason }, 'Vendor moved to wait-list and email queued.');
    };
  }
  function reinstateSheet(b) {
    ctx.openSheet(`
      <h3 class="sheet-title">Reinstate this booking</h3>
      <p><strong>${esc(b.business || b.name || 'Vendor')}</strong> · ${esc(niceShort(b.date))}</p>
      <p class="note">This restores the booth and category inventory, marks the booking paid and confirmed, and emails the vendor a confirmation.</p>
      <form id="v2-reinstate-form">
        <label class="sheet-field">Payment reference<input name="reference" required></label>
        <label class="sheet-field">Payment method<input name="payment_method" value="PayPal" required></label>
        <div class="sheet-actions"><button type="button" class="btn" data-sheet-close>Cancel</button><button class="btn primary">Reinstate as paid &amp; confirmed</button></div>
      </form>`);
    ctx.sheetEl.querySelector('#v2-reinstate-form').onsubmit = e => {
      e.preventDefault();
      const f = new FormData(e.target);
      ctx.closeSheet();
      mutate(() => api('reinstate-booking', { id: b.id, reference: f.get('reference'), payment_method: f.get('payment_method') }), 'Booking reinstated, marked paid and confirmation email queued.');
    };
  }
  function banSheet(b) {
    ctx.openSheet(`
      <h3 class="sheet-title">Ban vendor</h3>
      <p class="note">The reason stays private. A ban notification will be emailed if an email address is available. Review existing bookings separately.</p>
      <form id="v2-ban-form">
        <label class="sheet-field">Vendor name<input name="name" value="${esc(b.name || '')}" required></label>
        <label class="sheet-field">Email<input name="email" type="email" value="${esc(b.email || '')}"></label>
        <label class="sheet-field">Phone<input name="phone" value="${esc(b.phone || '')}"></label>
        <label class="sheet-field">Private reason / notes<textarea name="reason" rows="3" maxlength="2000" required></textarea></label>
        <div class="sheet-actions"><button type="button" class="btn" data-sheet-close>Cancel</button><button class="btn danger">Ban vendor</button></div>
      </form>`);
    ctx.sheetEl.querySelector('#v2-ban-form').onsubmit = e => {
      e.preventDefault();
      const f = Object.fromEntries(new FormData(e.target));
      ctx.closeSheet();
      mutate(() => api('ban', { ...f, user_id: b.user_id }), 'Vendor banned.');
    };
  }
  function detailsSheet(b) {
    const agreements = b.agreements && typeof b.agreements === 'object' ? Object.entries(b.agreements).filter(([, v]) => v === true).map(([k]) => k) : [];
    ctx.openSheet(`
      <h3 class="sheet-title">${esc(b.business || b.name || 'Vendor')}</h3>
      <p class="note">${esc(b.name || '')} · ${esc(b.email || '')}${b.phone ? ' · ' + esc(b.phone) : ''}</p>
      <p><strong>What they sell</strong><br>${esc(b.description || 'Not provided')}</p>
      <p><strong>Category:</strong> ${esc(b.category || 'Not selected')}</p>
      ${b.ban_flagged ? `<p class="note flag-note"><strong>Potential banned-vendor match:</strong> ${esc(b.ban_match_reason || 'Review this application.')}</p>` : ''}
      <p><strong>Billing address</strong><br>${esc(b.billing_address || 'Not provided')}</p>
      <p><strong>How they heard about us</strong><br>${esc(b.referral_source || 'Not provided')}${b.referral_group ? ' · ' + esc(b.referral_group) : ''}</p>
      <p><strong>Exception request</strong><br>${esc(b.exception_reason || 'None')}</p>
      ${agreements.length ? `<p><strong>Accepted agreements</strong><br>${agreements.map(esc).join(' · ')}</p>` : ''}
      ${(b.photos || []).length ? `<p><strong>Product photos</strong></p><div class="sheet-menu">${b.photos.map(path => `<button class="menu-item" data-photo="${esc(path)}"><span><b>View product photo</b><span>Opens a signed link, valid briefly</span></span><span class="chev">›</span></button>`).join('')}</div><div id="v2-photo-slot"></div>` : '<p class="note">No photos on file.</p>'}
      <div class="sheet-actions"><button class="btn" data-sheet-close>Close</button></div>`);
    ctx.sheetEl.querySelectorAll('[data-photo]').forEach(btn => btn.onclick = async () => {
      try {
        const v = await api('photo', undefined, { path: btn.dataset.photo });
        const slot = ctx.sheetEl.querySelector('#v2-photo-slot');
        if (slot) slot.innerHTML = `<img class="sheet-photo" src="${esc(v.url)}" alt="Vendor product photo">`;
      } catch (e) { ctx.toast(e.message, true); }
    });
  }

  function bindCards(scope) {
    scope.querySelectorAll('[data-act]').forEach(btn => btn.onclick = () => {
      const b = findBooking(btn.dataset.id);
      if (!b) { ctx.toast('That application is no longer in the list — reloading.', true); ctx.refreshAdmin().then(draw); return; }
      const act = btn.dataset.act;
      if (act === 'details') detailsSheet(b);
      else if (act === 'approve-credit') approveCreditSheet(b);
      else if (act === 'more') moreSheet(b);
      else if (act === 'status') statusSheet(b, btn.dataset.status);
      else if (act === 'reinstate') reinstateSheet(b);
      else if (act === 'catapprove') mutate(() => api('category-review-approve', { id: b.id }), 'Category reviewed and approved for ' + (b.business || b.name) + '.');
      else if (act === 'reminder') {
        const deadline = b.hold_until ? new Date(b.hold_until).toLocaleString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }) : 'the payment deadline';
        if (confirm('Email ' + (b.business || b.name) + ' a payment warning now?\n\nThe email will tell them they will be cancelled if payment is not received by ' + deadline + '.'))
          mutate(async () => { const r = await api('payment-reminder-now', { id: b.id }); return r; }, 'Payment warning emailed.');
      }
      else if (act === 'paypal-invoice') {
        if (confirm('Create and email this vendor a PayPal invoice now? The 24-hour payment hold starts immediately after PayPal sends it.'))
          mutate(async () => { const r = await api('paypal-invoice', { id: b.id }); ctx.toast('PayPal invoice ' + r.invoice_id + ' was sent.'); }, null);
      }
      else if (act === 'paypal-sync') mutate(async () => {
        const r = await api('paypal-sync', { id: b.id });
        ctx.toast(['PAID', 'MARKED_AS_PAID', 'PAID_EXTERNAL'].includes(r.status) ? 'Payment confirmed — booking marked paid.' : 'PayPal invoice status: ' + r.status);
      }, null);
    });
  }

  function draw() {
    const a = admin();
    const act = activeApps(), closed = closedApps();
    // Summary counts come straight from the payload (server truth).
    const counts = {
      attention: act.filter(needsReview).length,
      pending: act.filter(x => x.status === 'pending').length,
      approved: act.filter(x => x.status === 'approved').length,
      held: act.filter(x => x.status === 'held').length,
      paid: act.filter(x => x.status === 'paid').length
    };
    root.querySelector('#v2-app-summary').innerHTML = [
      ['attention', counts.attention + ' to review', 'Needs review — pending, flagged or category-flagged'],
      ['pending', counts.pending + ' pending', 'Waiting on your decision'],
      ['approved', counts.approved + ' approved', 'Booked, invoice not yet started'],
      ['held', counts.held + ' payment due', 'Invoice sent, deadline running'],
      ['paid', counts.paid + ' paid', 'Confirmed for their dates']
    ].map(([k, big, small]) => `<button class="stat stat-btn ${view.status === k ? 'gold' : ''}" data-quick="${k}"><b>${big}</b><span>${small}</span></button>`).join('');
    root.querySelectorAll('[data-quick]').forEach(btn => btn.onclick = () => { view.status = btn.dataset.quick === 'attention' ? 'attention' : btn.dataset.quick; root.querySelector('#v2-app-status').value = view.status; draw(); });

    // Filter option lists are rebuilt from the payload each draw.
    const evSel = root.querySelector('#v2-app-event');
    evSel.innerHTML = '<option value="">All upcoming dates</option>' + (a.events || []).map(e => `<option value="${esc(e.id)}">${esc(nice(e.date))}${e.location ? ' — ' + esc(e.location) : ''}</option>`).join('');
    evSel.value = view.eventId;
    const catSel = root.querySelector('#v2-app-category');
    const cats = [...new Set(all().map(b => b.category).filter(Boolean))].sort((x, y) => x.localeCompare(y));
    catSel.innerHTML = '<option value="">All categories</option>' + cats.map(c => `<option value="${esc(c)}">${esc(c)}</option>`).join('');
    catSel.value = view.category;
    root.querySelector('#v2-app-status').value = view.status;
    root.querySelector('#v2-app-sort').value = view.sort;

    let rows = act.filter(b => (!view.eventId || String(b.event_id) === view.eventId)
      && (!view.category || b.category === view.category)
      && (!view.status || (view.status === 'attention' ? needsReview(b) : b.status === view.status))
      && matches(b, view.q));
    rows = sortRows(rows, view.sort);
    const listEl = root.querySelector('#v2-app-list');
    listEl.innerHTML = (groupedHtml(rows, cardHtml) || `<div class="card empty-card">No active applications match these filters.</div>`)
      + `<p class="note">${rows.length} of ${act.length} active applications shown.</p>`;
    bindCards(listEl);

    let closedRows = closed.filter(b => (!view.closedStatus || b.status === view.closedStatus) && matches(b, view.closedQ));
    closedRows = sortRows(closedRows, 'date');
    const closedEl = root.querySelector('#v2-closed-list');
    closedEl.innerHTML = (groupedHtml(closedRows, cardHtml) || `<div class="card empty-card">No wait-list, cancelled or declined applications match.</div>`)
      + `<p class="note">${closedRows.length} of ${closed.length} closed applications shown. Wait-list offers are managed on the Wait List screen.</p>`;
    bindCards(closedEl);
  }

  root.querySelector('#v2-app-search').oninput = e => { view.q = e.target.value.trim().toLowerCase(); draw(); };
  root.querySelector('#v2-app-event').onchange = e => { view.eventId = e.target.value; draw(); };
  root.querySelector('#v2-app-status').onchange = e => { view.status = e.target.value; draw(); };
  root.querySelector('#v2-app-category').onchange = e => { view.category = e.target.value; draw(); };
  root.querySelector('#v2-app-sort').onchange = e => { view.sort = e.target.value; draw(); };
  root.querySelector('#v2-closed-search').oninput = e => { view.closedQ = e.target.value.trim().toLowerCase(); draw(); };
  root.querySelectorAll('[data-closed]').forEach(b => b.onclick = () => {
    view.closedStatus = b.dataset.closed;
    root.querySelectorAll('[data-closed]').forEach(x => x.classList.toggle('active', x === b));
    draw();
  });

  creditMap = null; conflictMap = null;
  draw();
  loadCreditData().then(() => { if (root.isConnected) draw(); });
}
