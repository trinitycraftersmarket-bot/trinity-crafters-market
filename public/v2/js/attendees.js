// Attendees management screen: the per-event vendor list for organizing —
// move space, move date, record payment, cancel vendor, check-in reminders,
// featured posts, CSV export. This is the management half of the legacy Attendees
// (report) panel. Inspection and check-in originally lived ONLY on Event Day
// (Stage 1); §70 (Scott, Nov 18, 2026) brought them here too — a per-card
// Approve inspection / Check in button and a mass inspection-approve for the
// date — because Scott runs the day from this list. The mass approve touches
// ONLY vendors not yet inspected: any inspection status Scott set by hand
// (above all a failed / refused inspection) is never overwritten. Same
// server-is-truth rule: every action is a server call, then a full re-fetch,
// then a re-render from fresh data.
import { api, fn, esc, money, nice, clock, marketName } from './api.js?v=20261118-75';
import { attendeeRows, eventStats } from './data.js?v=20261118-75';
import { parseAttendeePdf } from './pdfimport.js?v=20261118-75';
import { printAttendance } from './print.js?v=20261118-75';
import { imageAllowed, standardizeArea, findVendorSpot, resolvePins, composePlanCanvas, spotIds, spotLegend } from './floorplan.js?v=20261118-75';

const INSP_LABEL = { not_inspected: 'Inspection: Pending', approved: 'Inspection: Approved', needs_correction: 'Needs correction', refused: 'Inspection: Refused' };
const INSP_PRINT = { not_inspected: 'Not inspected', approved: 'Approved', needs_correction: 'Needs correction', refused: 'Refused' };
const INSP_CLASS = { not_inspected: 'warn', approved: 'ok', needs_correction: 'bad', refused: 'bad' };
const ARRIVAL_PRINT = { '08:15': '8:15 AM', '08:30': '8:30 AM', '08:45': '8:45 AM', '09:00': '9:00 AM' };

let view = { eventId: '', q: '' };

function payChip(r) {
  if (r.payStatus === 'paid') return `<span class="status ok">Paid${r.amount ? ' · ' + money(r.amount) : ''}</span>`;
  return `<span class="status warn">Unpaid${r.amount ? ' · ' + money(r.amount) + ' due' : ''}</span>`;
}
function attendanceChip(r) {
  if (r.attendance === 'checked_in') return '<span class="status ok">Checked in</span>';
  if (r.attendance === 'no_show') return '<span class="status bad">No show</span>';
  return '<span class="status neutral">Not checked in</span>';
}

export function renderAttendees(ctx, root, params = {}) {
  const events = ctx.state.admin.events || [];
  if (!events.length) {
    root.innerHTML = '<p class="eyebrow">Market Day</p><h2 class="display">Attendees</h2><p class="lede">No upcoming markets on the calendar yet.</p>';
    return;
  }
  const wanted = params.event || view.eventId;
  const event = events.find(e => String(e.id) === String(wanted)) || events[0];
  view.eventId = String(event.id);
  const loc = (ctx.state.admin.locations || []).find(l => String(l.id) === String(event.location_id));

  root.innerHTML = `
    <p class="eyebrow">${esc(nice(event.date))} · ${esc(event.location || loc?.name || '')}</p>
    <h2 class="display">Attendees</h2>
    <p class="lede" id="v2-att-summary"></p>
    <label class="picker-label">Market date
      <select id="v2-att-picker" class="picker">${events.map(e => `<option value="${esc(e.id)}" ${String(e.id) === String(event.id) ? 'selected' : ''}>${esc(nice(e.date))} — ${esc(marketName(e))}</option>`).join('')}</select>
    </label>
    <div class="search"><input id="v2-att-search" type="search" placeholder="Search business, name, email or phone…" autocomplete="off" value="${esc(view.q)}"></div>
    <div class="vendor-list" id="v2-att-list"></div>
    <div class="vendor-actions att-tools">
      <button class="btn small" id="v2-att-csv">Export CSV</button>
      <button class="btn small" id="v2-att-import">Import attendees from PDF</button>
      <button class="btn small" id="v2-att-print">Print attendance list</button>
      <button class="btn small" id="v2-att-insp-all">✓ Approve all inspections</button>
      <button class="btn small ghost" data-go-eventday>Open Event Day for inspections &amp; check-in</button>
    </div>`;

  const rowsNow = () => attendeeRows(ctx.state.admin, event.id);
  const findRow = (id, imported) => rowsNow().find(r => String(r.id) === String(id) && r.imported === imported);
  // §73 (Scott, Nov 18, 2026): each vendor's booth spot (MR-19 and friends)
  // shows on their Attendees card and in the printed list. Assignments live
  // in the floor plans, so load them once for this event and resolve each
  // row's spot with the same helper the vendor's own floor-plan view uses.
  let spotAreas = [];
  const spotOf = r => { const f = findVendorSpot(spotAreas, [r.id, r.vendor_id]); return f ? f.spot : ''; };
  api('floor-area-plans', undefined, { event_id: event.id })
    .then(res => { spotAreas = (res.areas || []).map(standardizeArea); draw(); })
    .catch(() => { /* no floor plans — cards and print simply carry no spots */ });
  const mutate = async (call, okMsg) => {
    try {
      await call();
      await ctx.refreshAdmin();
      draw();
      if (okMsg) ctx.toast(okMsg);
    } catch (e) { ctx.toast(e.message, true); }
  };

  function cardHtml(r) {
    return `<article class="card vendor" data-row="${esc(r.id)}">
      <div class="vendor-top">
        <div><h3>${esc(r.business || r.name || 'Vendor')}</h3>
        <div class="contact">${esc(r.name || '')}${r.category ? ' · ' + esc(r.category) : ''}</div></div>
        <span class="badge ${r.spaceNorm === 'outdoor' ? 'outside' : r.spaceNorm === 'hallway' ? 'hallway' : 'inside'}">${r.spaceNorm === 'outdoor' ? 'OUTSIDE' : r.spaceNorm === 'hallway' ? 'HALLWAY' : 'INSIDE'}</span>
      </div>
      <div class="chips">
        <span class="status ${INSP_CLASS[r.inspection_status]}">${INSP_LABEL[r.inspection_status]}</span>
        ${payChip(r)}
        ${attendanceChip(r)}
        ${spotOf(r) ? `<span class="status neutral">📍 Spot ${esc(spotOf(r))}</span>` : ''}
        ${r.setup_checkin_at ? `<span class="status neutral">Online check-in ✓${r.setup_arrival_time ? ' · arrives ' + esc(clock(r.setup_arrival_time)) : ''}${r.setup_tables ? ' · ' + esc(r.setup_tables) + (Number(r.setup_tables) === 1 ? ' table' : ' tables') : ''}</span>` : '<span class="status neutral">Online check-in not done</span>'}
        ${r.featured_posted_at ? '<span class="status neutral">Featured ✓</span>' : ''}
        ${r.imported ? '<span class="status neutral">Imported record</span>' : ''}
      </div>
      <p class="note"><strong>Booking ID:</strong> ${esc(r.id || '—')}<br><strong>Phone:</strong> ${esc(r.phone || 'Not provided')} · <strong>Email:</strong> ${esc(String(r.email || '').replace(/,+\s*$/, '').trim() || 'Not provided')}</p>
      ${r.disclosed ? `<p class="note"><strong>Everything disclosed:</strong> ${esc(r.disclosed)}</p>` : ''}
      ${r.approved_products ? `<p class="note"><strong>Approved to sell:</strong> ${esc(r.approved_products)}${r.declined_products ? `<br><strong>Not approved:</strong> ${esc(r.declined_products)}` : ''}</p>` : ''}
      <div class="vendor-actions">
        <button class="btn small" data-act="move-space" data-id="${esc(r.id)}" data-imported="${r.imported ? '1' : '0'}">⇄ Move space</button>
        <button class="btn small" data-act="move-date" data-id="${esc(r.id)}" data-imported="${r.imported ? '1' : '0'}">📅 Move date</button>
        ${r.attendance === 'checked_in'
          ? `<button class="btn small" data-act="attendance" data-state="clear" data-id="${esc(r.id)}" data-imported="${r.imported ? '1' : '0'}">Undo check-in</button>`
          : r.inspection_status === 'approved'
            ? `<button class="btn primary small" data-act="attendance" data-state="checked_in" data-id="${esc(r.id)}" data-imported="${r.imported ? '1' : '0'}">✓ Check in</button>`
            : `<button class="btn primary small" data-act="inspect-approve" data-id="${esc(r.id)}" data-imported="${r.imported ? '1' : '0'}">Approve inspection</button>`}
        ${r.payStatus !== 'paid' ? `<button class="btn primary small" data-act="pay" data-id="${esc(r.id)}" data-imported="${r.imported ? '1' : '0'}">Record payment</button>` : ''}
        <button class="btn small ghost" data-act="more" data-id="${esc(r.id)}" data-imported="${r.imported ? '1' : '0'}">More ⋯</button>
      </div>
    </article>`;
  }

  function moveSpaceSheet(r) {
    // §55: three spaces now — offer a move to each OTHER space (the
    // server still checks the target has room before moving).
    // §60: when the server refuses because the target space is full,
    // the sheet turns into a swap picker — choose a vendor in that
    // space and the server exchanges the two spaces atomically
    // (move-space's swapWith), repricing both bookings for their new
    // space. Nothing changes until a swap partner is picked.
    const label = s => s === 'outdoor' ? 'Outside' : s === 'hallway' ? 'Hallway' : 'Inside';
    const others = ['indoor', 'outdoor', 'hallway'].filter(s => s !== r.spaceNorm && Number(event[s + '_capacity'] || 0) > 0);
    const done = msg => { ctx.closeSheet(); ctx.refreshAdmin().then(() => { draw(); ctx.toast(msg); }); };
    const swapSheet = target => {
      const partners = rowsNow().filter(x => x.spaceNorm === target && !(String(x.id) === String(r.id) && x.imported === r.imported));
      ctx.openSheet(`
        <h3 class="sheet-title">Swap space</h3>
        <p><strong>${label(target)}</strong> is full for ${esc(nice(event.date))} — swap with:</p>
        <p><strong>${esc(r.business || r.name || 'Vendor')}</strong> (${label(r.spaceNorm)}) takes the ${label(target)} space, and the vendor you pick takes the ${label(r.spaceNorm)} space. Both bookings reprice for their new space.</p>
        ${partners.length ? `<div class="sheet-menu">${partners.map(x => `<button class="menu-item" data-swap-id="${esc(x.id)}" data-swap-imported="${x.imported ? '1' : '0'}"><span><b>${esc(x.business || x.name || 'Vendor')}</b><span>${esc(x.category || '')}</span></span><span class="chev">›</span></button>`).join('')}</div>` : '<p class="note">No movable vendor is listed in that space — reload and try again.</p>'}
        <div class="sheet-actions"><button class="btn" data-sheet-close>Cancel</button></div>`);
      ctx.sheetEl.querySelectorAll('[data-swap-id]').forEach(b => b.onclick = async () => {
        try {
          await fn('move-space', { id: r.id, imported: r.imported, space: target, swapWith: { id: b.dataset.swapId, imported: b.dataset.swapImported === '1' } });
          done('Swapped — ' + (r.business || r.name || 'Vendor') + ' is now ' + label(target) + '.');
        } catch (e) { ctx.toast(e.message, true); }
      });
    };
    ctx.openSheet(`
      <h3 class="sheet-title">Move space</h3>
      <p><strong>${esc(r.business || r.name || 'Vendor')}</strong> is currently <strong>${label(r.spaceNorm)}</strong> for ${esc(nice(event.date))}.</p>
      <p class="note">The server checks that the other space has room before moving — if it's full, you'll be offered a swap with a vendor in that space, and nothing changes until you pick one.</p>
      <div class="sheet-actions">
        <button class="btn" data-sheet-close>Cancel</button>
        ${others.map(s => `<button class="btn primary" data-move-space="${s}">Move to ${label(s)}</button>`).join('')}
      </div>`);
    ctx.sheetEl.querySelectorAll('[data-move-space]').forEach(b => b.onclick = async () => {
      const target = b.dataset.moveSpace;
      try {
        await fn('move-space', { id: r.id, imported: r.imported, space: target });
        done('Moved to ' + label(target) + '.');
      } catch (e) {
        if (/is full for this market date/.test(e.message)) swapSheet(target);
        else ctx.toast(e.message, true);
      }
    });
  }
  function moveDateSheet(r) {
    // §68: organizer-initiated date move, on the Attendees card where
    // Scott manages the date (the v2 rebuild never got the classic
    // app's organizer move — Scott, Nov 16, 2026: "I have no way we
    // change a vendors date"). Same move-requests backend as the
    // classic dialog: organizer-options lists the dates that can
    // take this booking (with the spaces that fit and why the rest
    // can't), organizer-move performs it immediately — no request,
    // no 48-hour cutoff for the organizer; payment stays on the
    // booking and the vendor is emailed the new date.
    const label = s => s === 'outdoor' ? 'Outside' : s === 'hallway' ? 'Hallway' : 'Inside';
    const sourceType = r.imported ? 'imported' : 'booking';
    ctx.openSheet(`<h3 class="sheet-title">Move date</h3><p>Checking which dates <strong>${esc(r.business || r.name || 'this vendor')}</strong> can move to…</p>`);
    (async () => {
      let v;
      try { v = await fn('move-requests', { action: 'organizer-options', source_type: sourceType, source_id: r.id }); }
      catch (e) { ctx.toast(e.message, true); ctx.closeSheet(); return; }
      const who = v.source?.business || v.source?.name || r.business || r.name || 'this vendor';
      if (!v.movable) {
        ctx.openSheet(`
          <h3 class="sheet-title">Move date — ${esc(who)}</h3>
          <p>${esc(v.reason || 'This booking cannot be moved.')}</p>
          <div class="sheet-actions"><button class="btn" data-sheet-close>Close</button></div>`);
        return;
      }
      const targets = v.targets || [], excluded = v.excluded || [];
      ctx.openSheet(`
        <h3 class="sheet-title">Move date — ${esc(who)}</h3>
        <p>Currently booked ${esc(nice(event.date))} as <strong>${label(r.spaceNorm)}</strong>. The move happens right away: payment stays on the booking, the old date's check-in and booth assignment are cleared, and the vendor is emailed the new date.</p>
        ${targets.length ? `<form id="v2-att-move-form">
          ${targets.map(t => `<div class="move-target">
            <label class="checkline"><input type="radio" name="to" value="${esc(t.event.id)}" data-space="${esc(t.spaces[0].space)}" required> <strong>${esc(nice(t.event.date))}</strong> — ${esc(t.event.location || '')}</label>
            ${t.spaces.length > 1
              ? `<label class="sheet-field">Space<select name="space-${esc(t.event.id)}">${t.spaces.map(s => `<option value="${esc(s.space)}" ${s.space === r.spaceNorm ? 'selected' : ''}>${label(s.space)} ${money(s.price)}</option>`).join('')}</select></label>`
              : `<p class="note">${label(t.spaces[0].space)} · ${money(t.spaces[0].price)}</p>`}
          </div>`).join('')}
          <p class="note flag-note" id="v2-att-move-error" hidden></p>
          <div class="sheet-actions"><button type="button" class="btn" data-sheet-close>Never mind</button><button class="btn primary">Move booking</button></div>
        </form>` : '<p><strong>No other dates can take this booking right now.</strong></p>'}
        ${excluded.length ? `<div class="note"><p><strong>Why some dates aren't listed:</strong></p><ul>${excluded.map(x => `<li>${esc(nice(x.event?.date))} — ${esc((x.problems || [])[0] || 'Not available')}</li>`).join('')}</ul></div>` : ''}`);
      const form = ctx.sheetEl.querySelector('#v2-att-move-form');
      if (form) form.onsubmit = async e => {
        e.preventDefault();
        const radio = form.querySelector('input[name="to"]:checked');
        if (!radio) return;
        const space = form.querySelector(`[name="space-${CSS.escape(radio.value)}"]`)?.value || radio.dataset.space;
        const btn = form.querySelector('button.btn.primary');
        if (btn) btn.disabled = true;
        try {
          const out = await fn('move-requests', { action: 'organizer-move', source_type: sourceType, source_id: r.id, to_event_id: radio.value, space });
          ctx.closeSheet();
          await ctx.refreshAdmin();
          draw();
          ctx.toast('Moved — ' + who + ' is now booked for ' + nice(out.to?.date) + '. The vendor has been emailed.' + (out.resolved_request ? ' Their pending move request was resolved as approved.' : ''));
        } catch (err) {
          const errEl = form.querySelector('#v2-att-move-error');
          if (errEl) { errEl.hidden = false; errEl.textContent = err.message; }
          if (btn) btn.disabled = false;
        }
      };
    })();
  }
  function paySheet(r) {
    ctx.openSheet(`
      <h3 class="sheet-title">Record payment</h3>
      <p><strong>${esc(r.business || r.name || 'Vendor')}</strong><br>${esc(nice(event.date))} · ${r.spaceNorm === 'outdoor' ? 'Outside' : r.spaceNorm === 'hallway' ? 'Hallway' : 'Inside'}</p>
      <form id="v2-att-pay-form">
        <label class="sheet-field">Amount ($)<input name="amount" type="number" min="0.01" step="0.01" value="${(r.amount / 100).toFixed(2)}" required></label>
        <label class="sheet-field">Payment method<select name="payment_method"><option>GoDaddy Payments</option><option>PayPal</option><option>Cash</option><option>Check</option><option>Other</option></select></label>
        <label class="sheet-field">Note<input name="note" placeholder="Optional note or transaction reference"></label>
        <div class="sheet-actions"><button type="button" class="btn" data-sheet-close>Cancel</button><button class="btn primary">Record payment &amp; mark paid</button></div>
      </form>`);
    ctx.sheetEl.querySelector('#v2-att-pay-form').onsubmit = e => {
      e.preventDefault();
      const f = new FormData(e.target);
      ctx.closeSheet();
      mutate(() => api('vendor-payment', {
        application_id: r.imported ? r.id : r.application_id,
        source: r.imported ? 'pdf' : 'application',
        imported_attendee_id: r.imported ? r.id : null,
        booking_id: r.imported ? null : r.id,
        amount: Number(f.get('amount')),
        payment_method: f.get('payment_method'),
        note: f.get('note')
      }), 'Payment recorded and vendor marked paid.');
    };
  }
  function cancelSheet(r) {
    ctx.openSheet(`
      <h3 class="sheet-title">Cancel vendor</h3>
      <p><strong>${esc(r.business || r.name || 'Vendor')}</strong><br>${esc(nice(event.date))}</p>
      <form id="v2-att-cancel-form">
        <label class="sheet-field">Reason for cancellation (included in the email)<textarea name="reason" rows="3" maxlength="2000" required placeholder="Example: Vendor requested cancellation"></textarea></label>
        <p class="note">Saving releases the space, stores the reason and emails the vendor a cancellation confirmation.</p>
        <div class="sheet-actions"><button type="button" class="btn" data-sheet-close>Keep vendor</button><button class="btn danger">Cancel vendor &amp; email confirmation</button></div>
      </form>`);
    ctx.sheetEl.querySelector('#v2-att-cancel-form').onsubmit = e => {
      e.preventDefault();
      const reason = new FormData(e.target).get('reason');
      ctx.closeSheet();
      mutate(() => r.imported
        ? api('imported-attendance', { id: r.id, state: 'remove', reason })
        : api('booking', { id: r.id, status: 'cancelled', reason }),
        'Vendor cancelled and cancellation email queued.');
    };
  }
  function featuredSheet(r) {
    const brand = loc?.market_name || event.title || 'Trinity Crafters Market';
    const products = r.disclosed || r.social_products || r.approved_products || r.category || 'their locally offered products';
    const draft = `🌟 FEATURED VENDOR SPOTLIGHT 🌟\n\nWe're excited to feature ${r.business || r.name} at our upcoming ${brand}!\n\n🛍️ What you'll find: ${products}\n\n📅 ${nice(event.date)}\n⏰ ${clock(event.start_time)}–${clock(event.end_time)}\n📍 ${loc?.name || event.location || ''}${loc?.address ? '\n' + loc.address : ''}\n\nCome out, support local, and be sure to stop by ${r.business || r.name}!\n\n#SupportLocal #ShopLocal #FeaturedVendor #CraftersMarket`;
    ctx.openSheet(`
      <h3 class="sheet-title">Featured vendor post</h3>
      <p><strong>${esc(r.business || r.name || 'Vendor')}</strong></p>
      <label class="sheet-field">Facebook post<textarea id="v2-featured-text" rows="12">${esc(draft)}</textarea></label>
      <p class="note">Edit anything you want. The vendor is marked featured only when you copy the post.</p>
      <div class="sheet-actions"><button class="btn" data-sheet-close>Cancel</button><button class="btn primary" id="v2-featured-copy">Copy post &amp; mark featured</button></div>`);
    ctx.sheetEl.querySelector('#v2-featured-copy').onclick = async () => {
      const text = ctx.sheetEl.querySelector('#v2-featured-text').value;
      try {
        await navigator.clipboard.writeText(text);
        ctx.closeSheet();
        mutate(() => api('featured-post', { id: r.id, imported: r.imported }), 'Featured vendor post copied and vendor marked featured.');
      } catch (e) { ctx.toast('Could not copy the post text.', true); }
    };
  }
  function moreSheet(r) {
    ctx.openSheet(`
      <h3 class="sheet-title">${esc(r.business || r.name || 'Vendor')}</h3>
      <p class="note">${esc(nice(event.date))} · ${r.spaceNorm === 'outdoor' ? 'Outside' : r.spaceNorm === 'hallway' ? 'Hallway' : 'Inside'} · ${esc(r.category || '')}</p>
      <div class="sheet-menu">
        ${!r.setup_checkin_at && String(r.email || '').trim() ? `<button class="menu-item" data-more="reminder"><span><b>Send online check-in reminder</b><span>Emails the vendor to complete check-in</span></span><span class="chev">›</span></button>` : ''}
        <button class="menu-item" data-more="featured"><span><b>Create featured vendor post</b><span>Draft, copy and mark them featured</span></span><span class="chev">›</span></button>
        <button class="menu-item" data-more="cancel"><span><b>Cancel vendor</b><span>Releases the space and emails a confirmation</span></span><span class="chev">›</span></button>
      </div>`);
    ctx.sheetEl.querySelectorAll('[data-more]').forEach(b => b.onclick = () => {
      const act = b.dataset.more;
      if (act === 'featured') featuredSheet(r);
      else if (act === 'cancel') cancelSheet(r);
      else if (act === 'reminder') { ctx.closeSheet(); mutate(() => api('checkin-reminder', { id: r.id, imported: r.imported }), 'Online check-in reminder sent to ' + (r.business || r.name) + '.'); }
    });
  }

  function bindCards() {
    root.querySelectorAll('[data-act]').forEach(btn => btn.onclick = () => {
      const r = findRow(btn.dataset.id, btn.dataset.imported === '1');
      if (!r) { ctx.toast('That vendor is no longer on the list — reloading.', true); ctx.refreshAdmin().then(draw); return; }
      if (btn.dataset.act === 'move-space') moveSpaceSheet(r);
      else if (btn.dataset.act === 'move-date') moveDateSheet(r);
      else if (btn.dataset.act === 'pay') paySheet(r);
      else if (btn.dataset.act === 'more') moreSheet(r);
      else if (btn.dataset.act === 'inspect-approve') mutate(
        () => api('inspection', { id: r.id, imported: r.imported, status: 'approved', notes: '' }),
        'Inspection approved for ' + (r.business || r.name) + '.');
      else if (btn.dataset.act === 'attendance') mutate(
        () => api(r.imported ? 'imported-attendance' : 'attendance', { id: r.id, state: btn.dataset.state }),
        btn.dataset.state === 'checked_in' ? (r.business || r.name) + ' checked in.' : 'Check-in cleared for ' + (r.business || r.name) + '.');
    });
  }
  function importSheet() {
    let rows = [], filename = '';
    ctx.openSheet(`
      <h3 class="sheet-title">Import attendees from PDF</h3>
      <p class="note">Choose the market date and PDF. You can edit every row before anything is saved.</p>
      <label class="sheet-field">Market date<select id="v2-pdf-event">${events.map(e => {
        const l = (ctx.state.admin.locations || []).find(x => String(x.id) === String(e.location_id));
        return `<option value="${esc(e.id)}" ${String(e.id) === String(event.id) ? 'selected' : ''}>${esc(nice(e.date))} — ${esc(l?.name || '')}</option>`;
      }).join('')}</select></label>
      <label class="sheet-field">Attendee PDF<input id="v2-pdf-file" type="file" accept="application/pdf"></label>
      <div class="sheet-actions"><button type="button" class="btn primary" id="v2-pdf-read">Read PDF</button></div>
      <div id="v2-pdf-review"><p class="note">No PDF has been read yet.</p></div>`);
    const review = ctx.sheetEl.querySelector('#v2-pdf-review');
    const harvest = () => {
      review.querySelectorAll('[data-import-row]').forEach(tr => {
        const r = rows[Number(tr.dataset.importRow)];
        if (!r) return;
        tr.querySelectorAll('[data-k]').forEach(inp => { r[inp.dataset.k] = inp.value.trim(); });
      });
    };
    const drawReview = () => {
      review.innerHTML = rows.length ? `
        <p class="note"><strong>${rows.length}</strong> possible attendees found. Review and correct before importing.</p>
        <div class="tbl-wrap"><table class="tbl"><thead><tr><th>Name</th><th>Business</th><th>Email</th><th>Phone</th><th>Category</th><th>Space</th><th></th></tr></thead><tbody>
        ${rows.map((r, i) => `<tr data-import-row="${i}"><td><input data-k="name" value="${esc(r.name)}"></td><td><input data-k="business" value="${esc(r.business)}"></td><td><input data-k="email" value="${esc(r.email)}"></td><td><input data-k="phone" value="${esc(r.phone)}"></td><td><input data-k="category" value="${esc(r.category)}"></td><td><select data-k="space"><option value="">Choose</option><option value="Inside" ${/^(inside|indoor)$/i.test(r.space) ? 'selected' : ''}>Inside</option><option value="Outside" ${/^(outside|outdoor)$/i.test(r.space) ? 'selected' : ''}>Outside</option></select></td><td><button type="button" class="btn small ghost" data-remove-import="${i}">Remove</button></td></tr>`).join('')}
        </tbody></table></div>
        <div class="sheet-actions"><button type="button" class="btn" id="v2-pdf-add">Add row</button><button type="button" class="btn primary" id="v2-pdf-save">Import Attendees</button></div>`
        : '<p class="note">No PDF has been read yet.</p>';
      review.querySelectorAll('[data-remove-import]').forEach(b => b.onclick = () => { harvest(); rows.splice(Number(b.dataset.removeImport), 1); drawReview(); });
      review.querySelector('#v2-pdf-add')?.addEventListener('click', () => { harvest(); rows.push({ name: '', business: '', email: '', phone: '', category: '', space: '' }); drawReview(); });
      review.querySelector('#v2-pdf-save')?.addEventListener('click', async () => {
        harvest();
        const clean = rows.filter(r => r.name || r.business);
        if (!clean.length) { ctx.toast('Keep at least one attendee row.', true); return; }
        try {
          await api('import-attendees', { event_id: ctx.sheetEl.querySelector('#v2-pdf-event').value, source_file: filename, rows: clean });
          ctx.closeSheet();
          await ctx.refreshAdmin();
          draw();
          ctx.toast(clean.length + ' attendees imported.');
        } catch (e) { ctx.toast(e.message, true); }
      });
    };
    ctx.sheetEl.querySelector('#v2-pdf-read').onclick = async () => {
      const file = ctx.sheetEl.querySelector('#v2-pdf-file').files[0];
      filename = file?.name || '';
      try {
        rows = await parseAttendeePdf(file);
        drawReview();
        ctx.toast('PDF read. Review the attendee rows before importing.');
      } catch (e) {
        ctx.toast(e.message, true);
        if (!rows.length) rows = [{ name: '', business: '', email: '', phone: '', category: '', space: '' }];
        drawReview();
      }
    };
  }

  function draw() {
    const stats = eventStats(ctx.state.admin, event);
    const summary = root.querySelector('#v2-att-summary');
    if (summary) summary.textContent = `${stats.vendors} vendors for this date · ${stats.unpaidCount} unpaid${stats.unpaidCount ? ' (' + money(stats.unpaidDue) + ')' : ''}. Manage spaces, payments and cancellations here; run inspections and check-in on Event Day.`;
    let rows = rowsNow();
    if (view.q) rows = rows.filter(r => [r.business, r.name, r.email, r.phone, r.category].some(v => String(v || '').toLowerCase().includes(view.q)));
    const list = root.querySelector('#v2-att-list');
    list.innerHTML = rows.map(cardHtml).join('') || `<div class="card empty-card">${stats.vendors ? 'No vendors match this search.' : 'No attendees for this date yet.'}</div>`;
    bindCards();
  }

  root.querySelector('#v2-att-picker').onchange = e => ctx.navigate('attendees', { event: e.target.value });
  const search = root.querySelector('#v2-att-search');
  search.oninput = () => { view.q = search.value.trim().toLowerCase(); draw(); };
  root.querySelector('[data-go-eventday]').onclick = () => ctx.navigate('event-day', { event: String(event.id) });
  root.querySelector('#v2-att-insp-all').onclick = () => {
    // §70: mass-approve ONLY the vendors not yet inspected. Anyone Scott
    // already marked by hand — approved, needs correction, or refused
    // (failed) — is left exactly as he left them; the server enforces the
    // same rule, this count is just what the confirm sheet promises.
    const pending = rowsNow().filter(r => r.inspection_status === 'not_inspected').length;
    if (!pending) { ctx.toast('No pending inspections on this date — everyone is already marked.'); return; }
    ctx.openSheet(`
      <h3 class="sheet-title">Approve all inspections</h3>
      <p><strong>${esc(nice(event.date))}</strong></p>
      <p class="note">This approves inspection for the ${pending} vendor${pending === 1 ? '' : 's'} on this date who ${pending === 1 ? 'has' : 'have'} not been inspected yet. Anyone you already marked yourself — including a failed inspection — stays exactly as you left them.</p>
      <div class="sheet-actions"><button type="button" class="btn" data-sheet-close>Not yet</button><button class="btn primary" id="v2-att-insp-all-go">Approve ${pending} inspection${pending === 1 ? '' : 's'}</button></div>`);
    ctx.sheetEl.querySelector('#v2-att-insp-all-go').onclick = () => {
      ctx.closeSheet();
      mutate(() => api('inspection-bulk-approve', { event_id: event.id }),
        'Inspections approved for this date.');
    };
  };
  root.querySelector('#v2-att-csv').onclick = () => {
    const rows = rowsNow();
    const csv = [['Vendor', 'Business', 'Disclosed', 'Approved', 'Not Approved', 'Category', 'Space', 'Inspection', 'Inspection Notes', 'Attendance'],
      ...rows.map(r => [r.name, r.business, r.disclosed, r.approved_products, r.declined_products, r.category, r.space, r.inspection_status, r.inspection_notes, r.attendance === 'checked_in' ? 'Checked in' : r.attendance === 'no_show' ? 'No show' : 'Not marked'])]
      .map(row => row.map(v => '"' + String(v ?? '').replaceAll('"', '""') + '"').join(',')).join('\n');
    const link = document.createElement('a');
    link.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    link.download = 'market-inspection-' + event.id + '.csv';
    link.click();
    URL.revokeObjectURL(link.href);
  };
  root.querySelector('#v2-att-import').onclick = () => importSheet();
  root.querySelector('#v2-att-print').onclick = async () => {
    // §71 (Scott, Nov 18, 2026): the printed list runs in desired check-in
    // (setup arrival) order, earliest first; vendors who never picked a
    // time ('99:99' sorts them last) print at the end.
    const rows = [...rowsNow()].sort((a, b) => String(a.setup_arrival_time || '99:99').slice(0, 5).localeCompare(String(b.setup_arrival_time || '99:99').slice(0, 5)));
    let plans = [];
    let legend = '';
    try {
      const areas = spotAreas.length ? spotAreas : ((await api('floor-area-plans', undefined, { event_id: event.id })).areas || []).map(standardizeArea);
      // §73: the plan pages must carry the vendors' NAMES — composite the
      // assignment pins onto each layout image (composePlanCanvas, the
      // same renderer the floor-plan print uses) instead of embedding the
      // bare layout image, which printed with no names at all (Scott,
      // Nov 18, 2026).
      const floorRows = await api('floor-attendees', undefined, { event_id: event.id }).catch(() => []);
      for (const a of areas) {
        if (!resolvePins(a, floorRows || []).length && !imageAllowed(a.image_data_url)) continue;
        const canvas = await composePlanCanvas(a, floorRows || []);
        plans.push({ title: a.title || 'Floor plan', image: canvas.toDataURL('image/png') });
      }
      legend = spotLegend(areas.map(a => ({ title: a.title, spots: spotIds(a) })));
    } catch { /* no readable plans — print the list alone */ }
    try {
      printAttendance({
        market: loc?.market_name || event.title || 'Crafters Market',
        subtitle: nice(event.date) + ' · ' + (loc?.name || event.location || '') + ' · ' + clock(event.start_time) + '–' + clock(event.end_time),
        summary: rows.length + ' vendors · ' + rows.filter(r => r.payStatus === 'paid').length + ' paid · ' + rows.filter(r => r.attendance === 'checked_in').length + ' checked in',
        headers: ['Space', 'Spot', 'Business', 'Vendor', 'Category', 'Phone', 'Email', 'Payment', 'Attendance', 'Inspection', 'Setup Arrival'],
        rows: rows.map(r => [
          r.space || (r.spaceNorm === 'outdoor' ? 'Outside' : r.spaceNorm === 'hallway' ? 'Hallway' : 'Inside'),
          spotOf(r) || '—',
          r.business || '', r.name || '', r.category || '',
          r.phone || 'Not provided',
          String(r.email || '').replace(/,+\s*$/, '').trim() || 'Not provided',
          r.payStatus === 'paid' ? 'Paid' : 'Unpaid',
          r.attendance === 'checked_in' ? 'Checked in' : r.attendance === 'no_show' ? 'No show' : 'Not marked',
          INSP_PRINT[r.inspection_status] || 'Not inspected',
          ARRIVAL_PRINT[String(r.setup_arrival_time || '').slice(0, 5)] || '—'
        ]),
        plans,
        legend
      });
    } catch (e) { ctx.toast(e.message, true); }
  };

  draw();
}
