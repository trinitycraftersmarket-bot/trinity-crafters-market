// Wait List screen: vendors waiting for a spot, with the Features A
// auto-offer state the legacy panel shows — queue position, per-category
// spots (from the server counts), live offer state, and the organizer's
// "Offer anyway" override. Ported from the legacy waitlistPanel(): same
// payload fields (applications + waitlistOffers + counts), same actions
// (waitlist-offer, booking approve). Mutations re-fetch, then re-render.
import { api, esc, nice, niceShort } from './api.js?v=20261023-13';
import { normalizeSpace } from './data.js?v=20261023-13';

let view = { eventId: '', space: '' };

export function renderWaitlist(ctx, root) {
  const admin = () => ctx.state.admin;
  root.innerHTML = `
    <p class="eyebrow">Vendors</p>
    <h2 class="display">Wait List</h2>
    <p class="lede">When a spot opens, the first vendor in line whose category isn't full gets an automatic offer with 12 hours to accept. Anyone skipped for a full category keeps their place — and you can offer anyway.</p>
    <div class="filter-row">
      <label class="picker-label">Market date<select id="v2-wait-event" class="picker"><option value="">All dates</option>${(admin().events || []).map(e => `<option value="${esc(e.id)}">${esc(nice(e.date))}</option>`).join('')}</select></label>
      <label class="picker-label">Space<select id="v2-wait-space" class="picker"><option value="">All spaces</option><option value="indoor">Indoor</option><option value="outdoor">Outdoor</option></select></label>
    </div>
    <div id="v2-wait-list"></div>`;

  const waitlisted = () => (admin().applications || []).filter(b => b.status === 'waitlist');
  // Queue position: first-come by waitlisted_at per event + space,
  // computed over ALL waitlisted vendors (not just the filtered view),
  // exactly like the legacy panel.
  const queuePos = () => {
    const pos = {};
    [...waitlisted()].sort((x, y) => String(x.waitlisted_at || x.created_at || '').localeCompare(String(y.waitlisted_at || y.created_at || '')))
      .forEach(b => {
        const k = String(b.event_id) + ':' + String(b.space || '').toLowerCase();
        pos[b.id] = (pos[k] = (pos[k] || 0) + 1);
      });
    return pos;
  };
  const offersByBooking = () => {
    const map = {};
    for (const o of (admin().waitlistOffers || [])) if (!map[o.booking_id]) map[o.booking_id] = o;
    return map;
  };
  const catInfo = b => {
    const row = (admin().counts || []).find(c => String(c.event_id) === String(b.event_id) && String(c.category_id) === String(b.category_id));
    const used = row ? Number(row.used || 0) : 0;
    const lim = row?.vendor_limit
      ?? (admin().categoryLimits || []).find(l => String(l.event_id) === String(b.event_id) && String(l.category_id) === String(b.category_id))?.vendor_limit
      ?? (admin().allCategories || []).find(c => String(c.id) === String(b.category_id))?.vendor_limit
      ?? null;
    // Limit 0 = no cap (owner ruling), so it can never be "full".
    return { used, lim, full: lim != null && lim > 0 && used >= lim };
  };
  const offerState = (b, offers) => {
    const o = offers[b.id];
    if (b.waitlist_offered_at && o && o.state === 'offered') {
      return { label: 'Offered · expires ' + new Date(o.expires_at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' }), cls: 'warn' };
    }
    if (o && o.state === 'offered') return { label: 'Offer ended — re-offer pending', cls: 'neutral' };
    return catInfo(b).full ? { label: 'Skipped — category full', cls: 'bad' } : { label: 'Not offered', cls: 'neutral' };
  };
  const mutate = async (call, okMsg) => {
    try {
      await call();
      await ctx.refreshAdmin();
      draw();
      if (okMsg) ctx.toast(okMsg);
    } catch (e) { ctx.toast(e.message, true); }
  };

  function approveSheet(b) {
    const ci = catInfo(b);
    ctx.openSheet(`
      <h3 class="sheet-title">Approve wait-listed vendor</h3>
      <p><strong>${esc(b.business || b.name || 'Vendor')}</strong> · ${esc(niceShort(b.date))} · ${esc(b.category || '')}</p>
      <p class="note">This moves them into the normal approval/payment workflow.${ci.full ? ` Their category is currently full (${ci.used}/${ci.lim}) — approving without an exception will be refused by the server.` : ''}</p>
      <form id="v2-wait-approve-form">
        <label class="checkline"><input type="checkbox" name="exception"> Approve a category exception if ${esc(b.category || 'this category')} is already full</label>
        <p class="note">Leave this unchecked unless you are intentionally allowing one additional vendor in this category for this market date.</p>
        <div class="sheet-actions"><button type="button" class="btn" data-sheet-close>Cancel</button><button class="btn primary">Approve vendor</button></div>
      </form>`);
    ctx.sheetEl.querySelector('#v2-wait-approve-form').onsubmit = e => {
      e.preventDefault();
      const exception = new FormData(e.target).get('exception') === 'on';
      ctx.closeSheet();
      mutate(() => api('booking', { id: b.id, status: 'approved', exception }), exception ? 'Wait-listed vendor approved with a category exception.' : 'Wait-listed vendor approved.');
    };
  }

  function cardHtml(b, pos, offers) {
    const ci = catInfo(b);
    const offer = offerState(b, offers);
    const space = normalizeSpace(b.space);
    const loc = (admin().allEvents || []).find(e => String(e.id) === String(b.event_id));
    const locName = loc ? (admin().locations || []).find(l => String(l.id) === String(loc.location_id))?.name : '';
    return `<article class="card vendor">
      <div class="vendor-top">
        <div><h3>${esc(b.business || b.name || 'Vendor')}</h3>
        <div class="contact">${esc(b.name || '')} · #${pos[b.id] || '—'} in line</div></div>
        <span class="badge ${space === 'outdoor' ? 'outside' : 'inside'}">${space === 'outdoor' ? 'OUTSIDE' : 'INSIDE'}</span>
      </div>
      <div class="chips">
        <span class="status neutral">${esc(niceShort(b.date))}${locName ? ' · ' + esc(locName) : ''}</span>
        <span class="status ${ci.full ? 'bad' : 'neutral'}">${esc(b.category || 'Category')} ${ci.used}/${ci.lim ?? '∞'}${ci.full ? ' — full' : ''}</span>
        <span class="status ${offer.cls}">${esc(offer.label)}</span>
      </div>
      <p class="note"><strong>Booking ID:</strong> ${esc(b.id || '—')}<br><strong>Contact:</strong> ${esc(b.email || '')}${b.phone ? ' · ' + esc(b.phone) : ''}</p>
      ${b.decision_reason ? `<p class="note"><strong>Wait-list reason:</strong> ${esc(b.decision_reason)}</p>` : ''}
      ${b.description ? `<p class="note"><strong>What they sell:</strong> ${esc(b.description)}</p>` : ''}
      ${(b.exception_request || b.exception_reason) ? `<p class="note"><strong>Exception request:</strong> ${esc(b.exception_request || b.exception_reason)}</p>` : ''}
      <div class="vendor-actions">
        <button class="btn primary small" data-act="offer" data-id="${esc(b.id)}">Offer anyway</button>
        <button class="btn small" data-act="approve" data-id="${esc(b.id)}">Approve from wait-list</button>
        ${b.email ? `<a class="btn small ghost" href="mailto:${esc(b.email)}">Email vendor</a>` : ''}
      </div>
    </article>`;
  }

  function draw() {
    root.querySelector('#v2-wait-event').value = view.eventId;
    root.querySelector('#v2-wait-space').value = view.space;
    const pos = queuePos(), offers = offersByBooking();
    const rows = waitlisted()
      .filter(b => (!view.eventId || String(b.event_id) === view.eventId) && (!view.space || String(b.space || '').toLowerCase() === view.space))
      .sort((x, y) => String(x.date).localeCompare(String(y.date)) || String(x.space || '').localeCompare(String(y.space || '')) || String(x.waitlisted_at || x.created_at || '').localeCompare(String(y.waitlisted_at || y.created_at || '')) || String(x.business || x.name || '').localeCompare(String(y.business || y.name || ''), undefined, { sensitivity: 'base' }));
    const list = root.querySelector('#v2-wait-list');
    list.innerHTML = `<p class="note"><strong>${rows.length}</strong> wait-listed vendor${rows.length === 1 ? '' : 's'}${view.eventId ? ' for this date' : ' across all dates'}.</p>`
      + `<div class="vendor-list">${rows.map(b => cardHtml(b, pos, offers)).join('') || '<div class="card empty-card">No vendors match this wait-list filter.</div>'}</div>`;
    list.querySelectorAll('[data-act]').forEach(btn => btn.onclick = () => {
      const b = waitlisted().find(x => String(x.id) === String(btn.dataset.id));
      if (!b) { ctx.toast('That vendor is no longer wait-listed — reloading.', true); ctx.refreshAdmin().then(draw); return; }
      if (btn.dataset.act === 'offer') mutate(() => api('waitlist-offer', { id: b.id }), 'Offer sent — the vendor has 12 hours to accept.');
      else if (btn.dataset.act === 'approve') approveSheet(b);
    });
  }

  root.querySelector('#v2-wait-event').onchange = e => { view.eventId = e.target.value; draw(); };
  root.querySelector('#v2-wait-space').onchange = e => { view.space = e.target.value; draw(); };
  draw();
}
