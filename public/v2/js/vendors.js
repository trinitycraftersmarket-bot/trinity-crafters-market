// Vendor Directory: every vendor with history, payments and receipts,
// the Features B saved profile (view/edit), vendor information edits, and
// the invite-back email. Data comes from the vendor-list action (the same
// payload the legacy Vendors panel uses — it already embeds each vendor's
// profile, market dates and recorded payments). Writes go through
// vendor-profile organizer-save / vendor-save / vendor-payment /
// vendor-receipt, then the list is re-fetched and re-rendered (§1 rule 1).
import { api, fn, esc, money, nice } from './api.js?v=20261023-4';

let rows = null;          // vendor-list payload for this screen session
let creditSources = null; // vendor-credit admin-sources: paid records a credit can be issued from
let view = { q: '', filter: 'all' };
const selected = new Set();  // invite-back selections survive re-renders

const RETURN_SUBJECT = 'We would love to have you back at Trinity Crafters Market';
const RETURN_BODY = `Hi {{name}},

We haven't seen you at Trinity Crafters Market in a while and wanted to check in. We'd love to have {{business}} join us again at an upcoming market.

If you're interested in coming back, please visit our website to see the upcoming dates and availability, or reply to this email if you have any questions.

We hope to see you again soon!

Trinity Crafters Market
trinitycraftersmarket@gmail.com`;

export function renderVendors(ctx, root) {
  const year = new Date().getFullYear();
  root.innerHTML = `
    <p class="eyebrow">Vendors</p>
    <h2 class="display">Vendor Directory</h2>
    <p class="lede">Search every vendor, review their history and payments, record cash payments, send receipts, and keep their saved profile current — it's what pre-fills their next application.</p>
    <div class="filter-row">
      <div class="search grow"><input id="v2-vendor-search" type="search" placeholder="Business, name, email, phone or category…" autocomplete="off" value="${esc(view.q)}"></div>
      <label class="picker-label">Show<select id="v2-vendor-filter" class="picker">
        <option value="all">All vendors</option><option value="regular">Regular vendors only</option>
        <option value="inactive">Haven't attended recently</option><option value="pdf">PDF imported vendors</option>
      </select></label>
    </div>
    <div class="card invite-card">
      <h3 class="section-title first">Invite vendors back</h3>
      <p class="note">Tick vendors in the list below, then send them a friendly invitation to return.</p>
      <label class="sheet-field">Subject<input id="v2-return-subject" value="${esc(RETURN_SUBJECT)}"></label>
      <label class="sheet-field">Message<textarea id="v2-return-body" rows="6">${esc(RETURN_BODY)}</textarea></label>
      <div class="vendor-actions"><button class="btn primary small" id="v2-return-send">Email selected vendors</button><span class="note" id="v2-return-count"></span></div>
    </div>
    <div id="v2-vendor-list"><div class="card empty-card">Loading vendors…</div></div>`;

  const findVendor = id => (rows || []).find(v => String(v.id) === String(id));
  const refresh = async () => {
    rows = await api('vendor-list');
    // Credit sources ride along best-effort: a failure hides the credit
    // section, it never takes the directory down.
    try { creditSources = (await fn('vendor-credit', { action: 'admin-sources' })).sources || []; }
    catch { creditSources = []; }
    draw();
  };
  // A vendor's creditable records (legacy vendor-credit matching): by
  // email when the vendor has one; otherwise by record id — application
  // id for booking sources, the row id itself for imported records.
  const creditRowsFor = v => {
    if (!creditSources) return [];
    const email = String(v.email || '').replace(/,+\s*$/, '').trim().toLowerCase();
    return creditSources.filter(x => email
      ? String(x.email || '').trim().toLowerCase() === email
      : (x.imported ? String(x.id) === String(v.id) : String(x.application_id) === String(v.id)));
  };
  const mutate = async (call, okMsg) => {
    try {
      await call();
      await refresh();
      if (okMsg) ctx.toast(okMsg);
    } catch (e) { ctx.toast(e.message, true); }
  };

  function historyLine(x) {
    const amount = x.amount_recorded ? money(x.amount) : 'amount not recorded';
    const sub = [x.reference ? 'Ref ' + x.reference : '', x.note && x.note !== x.label ? x.note : ''].filter(Boolean).join(' · ');
    return `<div class="mini-row"><span>${esc(x.label)}${sub ? `<br><span class="muted">${esc(sub)}</span>` : ''}</span><span>${amount}${x.method ? ' · ' + esc(x.method) : ''} · ${esc(x.kind)}${x.payment_id ? ` <button class="btn small" data-receipt="${esc(x.payment_id)}">${x.receipt_sent_at ? 'Resend receipt' : 'Email receipt'}</button>` : ''}</span></div>`;
  }
  function profileSummary(v) {
    const p = v.profile;
    if (!p) return '<p class="note"><strong>Saved profile:</strong> none yet — it starts the first time they apply or you save one here.</p>';
    const pref = p.space_preference === 'indoor' ? 'Indoor' : p.space_preference === 'outdoor' ? 'Outdoor' : p.space_preference === 'none' ? 'No preference' : 'Not set';
    return `<p class="note"><strong>Saved profile</strong> · Space preference: ${esc(pref)}<br>Website: ${esc(p.website || '—')} · Social: ${esc(p.social_links || '—')}<br>Pre-fills as: ${esc(p.business || v.business || '—')} · ${esc(p.phone || v.phone || '—')}${p.description ? '<br>' + esc(p.description) : ''}</p>`;
  }
  function cardHtml(v) {
    const paid = (v.dates || []).filter(x => x.status === 'paid');
    const email = String(v.email || '').replace(/,+\s*$/, '').trim();
    return `<article class="card vendor">
      <div class="vendor-top">
        <div><h3>${esc(v.business || v.name || 'Vendor')}</h3>
        <div class="contact">${esc(v.name || '')} · ${esc(email)}${v.phone ? ' · ' + esc(v.phone) : ''}</div></div>
        <span class="status neutral">${v.source === 'pdf' ? 'PDF imported' : v.regular_vendor ? 'Regular vendor' : 'Vendor'}</span>
      </div>
      <p class="note"><strong>${v.shows || 0}</strong> paid shows · <strong>${money(v.booking_spend || 0)}</strong> recorded booking spend · <strong>${money(v.recorded_payments || 0)}</strong> in recorded payments${v.category ? `<br><strong>Category:</strong> ${esc(v.category)}` : ''}</p>
      ${profileSummary(v)}
      <details class="vdetails">
        <summary>Full history — ${paid.length} paid date${paid.length === 1 ? '' : 's'}, ${(v.payments || []).length} recorded payment${(v.payments || []).length === 1 ? '' : 's'}</summary>
        ${v.billing_address ? `<p class="note"><strong>Billing address:</strong> ${esc(v.billing_address)}</p>` : ''}
        ${v.description ? `<p class="note"><strong>What they sell:</strong> ${esc(v.description)}</p>` : ''}
        ${v.referral_source ? `<p class="note"><strong>Referral:</strong> ${esc(v.referral_source)}${v.referral_group ? ' — ' + esc(v.referral_group) : ''}</p>` : ''}
        <h4 class="mini-title">Market dates</h4>
        ${(v.dates || []).map(x => `<div class="mini-row"><span>${esc(nice(x.date))} · ${esc(x.space || '')}</span><span>${esc(x.status || '')} · ${money(x.price || 0)}${x.payment_method ? ' · ' + esc(x.payment_method) : ''}</span></div>`).join('') || '<p class="note">No market history.</p>'}
        <h4 class="mini-title">Payment history — all records</h4>
        ${(v.payment_history || []).map(historyLine).join('') || '<p class="note">No payments on record.</p>'}
        <h4 class="mini-title">Recorded payments / receipts</h4>
        ${(v.payments || []).map(x => `<div class="mini-row"><span>${esc(new Date(x.paid_at).toLocaleDateString('en-US', { timeZone: 'America/New_York' }))} · ${money(x.amount)} · ${esc(x.payment_method || '')}</span><span>${x.receipt_sent_at ? 'Receipt sent ' + esc(new Date(x.receipt_sent_at).toLocaleDateString('en-US')) + ' ' : ''}<button class="btn small" data-receipt="${esc(x.id)}">${x.receipt_sent_at ? 'Resend receipt' : 'Email receipt'}</button></span></div>`).join('') || '<p class="note">No separately recorded payments.</p>'}
        ${creditSectionHtml(v)}
      </details>
      <div class="vendor-actions">
        ${email ? `<button class="btn small" data-act="profile" data-id="${esc(v.id)}">Vendor profile</button>` : ''}
        <button class="btn small" data-act="edit" data-id="${esc(v.id)}">Edit information</button>
        <button class="btn primary small" data-act="pay" data-id="${esc(v.id)}">Record payment</button>
        ${v.source === 'application' ? `<button class="btn small ghost" data-act="statement" data-id="${esc(v.id)}">Email ${year} statement</button>` : ''}
        <label class="checkline select-line"><input type="checkbox" data-select="${esc(v.id)}" ${selected.has(String(v.id)) ? 'checked' : ''}> Invite back</label>
      </div>
    </article>`;
  }

  // Cancellation credits (full-port Stage B): issue a reusable credit
  // from any paid record — including one already cancelled, whose paid
  // evidence the server preserves. Issuing cancels/releases the original
  // spot (a no-op when it was already cancelled) and emails the vendor.
  function creditSectionHtml(v) {
    const list = creditRowsFor(v);
    if (!list.length) return '';
    return `<h4 class="mini-title">Cancellation credits</h4>
      <p class="note">Issue a reusable credit from a paid booking. Issuing it also cancels and releases that original spot. Credits never expire and stay tied to the vendor's category.</p>
      ${list.map(x => `<div class="mini-row"><span>${esc(nice(x.event_date))} · ${esc(x.space || '')} · ${Number(x.amount) > 0 ? money(x.amount) + ' paid' : 'Amount not recorded'} · ${esc(x.status || '')}</span><span>${x.credit_id
        ? `<span class="status neutral">Credit issued · ${money(x.remaining_amount)} left</span>`
        : `<button class="btn small" data-issue="${esc(x.id)}" data-imported="${x.imported ? '1' : '0'}">Issue Credit${Number(x.amount) > 0 ? ' ' + money(x.amount) : ''}</button>`}</span></div>`).join('')}`;
  }
  function issueSheet(x) {
    // Preview first (the legacy flow): the stored paid amount decides
    // whether the organizer must type the amount actually paid.
    fn('vendor-credit', { action: 'preview', id: x.id, imported: x.imported }).then(r => {
      const src = r.source || {};
      const stored = Number(src.paid_amount || 0);
      ctx.openSheet(`
        <h3 class="sheet-title">Issue cancellation credit</h3>
        <p><strong>${esc(src.business || src.name || 'Vendor')}</strong> · ${esc(nice(src.event_date))} · ${esc(src.space || '')}</p>
        <form id="v2-issue-credit-form">
          ${stored > 0
            ? `<p class="note">Issue a <strong>${money(stored)}</strong> credit and cancel/release this market spot?<br>The vendor will be able to choose another available date online. The credit never expires.</p>`
            : `<p class="note">No paid amount is stored for this booking. Enter the amount actually paid — it becomes the credit, and this market spot is cancelled/released.</p>
               <label class="sheet-field">Amount actually paid ($)<input name="amount" type="number" min="0.01" step="0.01" required></label>`}
          <div class="sheet-actions"><button type="button" class="btn" data-sheet-close>Cancel</button><button class="btn primary">Issue credit &amp; release spot</button></div>
        </form>`);
      ctx.sheetEl.querySelector('#v2-issue-credit-form').onsubmit = e => {
        e.preventDefault();
        const f = new FormData(e.target);
        const extra = stored > 0 ? {} : { amount: Math.round(Number(f.get('amount')) * 100) };
        if (stored <= 0 && (!Number.isFinite(extra.amount) || extra.amount <= 0)) { ctx.toast('Enter a valid paid amount.', true); return; }
        ctx.closeSheet();
        mutate(() => fn('vendor-credit', { action: 'issue', id: x.id, imported: x.imported, ...extra }),
          'Credit issued. The old spot and category were released, and the vendor can apply the credit from My Bookings.');
      };
    }).catch(e => ctx.toast(e.message, true));
  }

  function profileSheet(v) {
    const p = v.profile || {};
    const cats = ctx.state.admin.categories || [];
    ctx.openSheet(`
      <h3 class="sheet-title">Vendor profile</h3>
      <p class="note">${esc(v.business || v.name || 'Vendor')} · pre-fills their applications (§13.7 profile — the same record the vendor edits in My Profile).</p>
      <form id="v2-profile-form">
        <label class="sheet-field">Business<input name="business" value="${esc(p.business || v.business || '')}"></label>
        <label class="sheet-field">Contact name<input name="name" value="${esc(p.name || v.name || '')}"></label>
        <label class="sheet-field">Phone<input name="phone" value="${esc(p.phone || v.phone || '')}"></label>
        <label class="sheet-field">Address<textarea name="address" rows="2">${esc(p.address || v.billing_address || '')}</textarea></label>
        <label class="sheet-field">Category<select name="category_id"><option value="">No category</option>${cats.map(c => `<option value="${esc(c.id)}" ${String(p.category_id || '') === String(c.id) ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select></label>
        <label class="sheet-field">Space preference<select name="space_preference">
          <option value="" ${!p.space_preference ? 'selected' : ''}>Not set</option>
          <option value="indoor" ${p.space_preference === 'indoor' ? 'selected' : ''}>Indoor</option>
          <option value="outdoor" ${p.space_preference === 'outdoor' ? 'selected' : ''}>Outdoor</option>
          <option value="none" ${p.space_preference === 'none' ? 'selected' : ''}>No preference</option>
        </select></label>
        <label class="sheet-field">Website<input name="website" value="${esc(p.website || '')}"></label>
        <label class="sheet-field">Social links<input name="social_links" value="${esc(p.social_links || '')}"></label>
        <label class="sheet-field">Products / description<textarea name="description" rows="3">${esc(p.description || v.description || '')}</textarea></label>
        <div class="sheet-actions"><button type="button" class="btn" data-sheet-close>Cancel</button><button class="btn primary">Save vendor profile</button></div>
      </form>`);
    ctx.sheetEl.querySelector('#v2-profile-form').onsubmit = e => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const body = { action: 'organizer-save', email: v.email };
      for (const k of ['name', 'business', 'phone', 'address', 'description', 'website', 'social_links', 'space_preference', 'category_id']) {
        const val = fd.get(k);
        if (val !== null) body[k] = val;
      }
      ctx.closeSheet();
      mutate(() => fn('vendor-profile', body), 'Vendor profile saved.');
    };
  }
  function editSheet(v) {
    ctx.openSheet(`
      <h3 class="sheet-title">Edit vendor information</h3>
      <p><strong>${esc(v.business || v.name || 'Vendor')}</strong></p>
      <form id="v2-vendor-edit-form">
        <label class="sheet-field">Name<input name="name" value="${esc(v.name || '')}" required></label>
        <label class="sheet-field">Business<input name="business" value="${esc(v.business || '')}" required></label>
        <label class="sheet-field">Email<input name="email" type="email" value="${esc(String(v.email || '').replace(/,+\s*$/, '').trim())}" required></label>
        <label class="sheet-field">Phone<input name="phone" value="${esc(v.phone || '')}"></label>
        <label class="sheet-field">Category<input name="category" value="${esc(v.category || '')}" ${v.source === 'pdf' ? '' : 'readonly'}></label>
        <label class="checkline"><input type="checkbox" name="regular_vendor" ${v.regular_vendor ? 'checked' : ''}> Regular Vendor</label>
        <label class="sheet-field">Monthly billing amount ($)<input name="monthly_amount" type="number" min="0" step="0.01" value="${v.monthly_billing_amount == null ? '' : (v.monthly_billing_amount / 100).toFixed(2)}"></label>
        <div class="sheet-actions"><button type="button" class="btn" data-sheet-close>Cancel</button><button class="btn primary">Save vendor information</button></div>
      </form>`);
    ctx.sheetEl.querySelector('#v2-vendor-edit-form').onsubmit = e => {
      e.preventDefault();
      const f = new FormData(e.target);
      const raw = String(f.get('monthly_amount') || '').trim();
      ctx.closeSheet();
      mutate(() => api('vendor-save', {
        id: v.id, source: v.source,
        name: String(f.get('name')).trim(), business: String(f.get('business')).trim(),
        email: String(f.get('email')).trim(), phone: String(f.get('phone')).trim(),
        category: String(f.get('category')).trim(),
        regular_vendor: f.get('regular_vendor') === 'on',
        monthly_billing_amount: raw === '' ? null : Math.round(Number(raw) * 100)
      }), 'Vendor information saved.');
    };
  }
  function paySheet(v) {
    const dates = [...(v.dates || [])].sort((a, b) => String(b.date).localeCompare(String(a.date)));
    const events = [...(ctx.state.admin?.events || [])].sort((a, b) => String(b.date).localeCompare(String(a.date)));
    const today = new Date().toLocaleDateString('en-CA');
    ctx.openSheet(`
      <h3 class="sheet-title">Record payment</h3>
      <p><strong>${esc(v.business || v.name || 'Vendor')}</strong></p>
      <form id="v2-vendor-pay-form">
        ${v.source === 'pdf' ? `<label class="sheet-field">Market date<select name="imported_attendee_id" required>${dates.map(x => `<option value="${esc(x.id)}">${esc(nice(x.date))} — ${esc(x.space || '')} — ${esc(x.status || '')}</option>`).join('')}</select></label>` : ''}
        <label class="sheet-field">Amount ($)<input name="amount" type="number" min="0.01" step="0.01" required></label>
        <label class="sheet-field">Date paid<input name="paid_at" type="date" value="${today}" required></label>
        <label class="sheet-field">Method<select name="method"><option>cash</option><option>check</option><option>GoDaddy Payments</option><option>PayPal</option><option>other</option></select></label>
        <label class="checkline"><input type="checkbox" name="manual"> Manual entry — a past payment that isn't tied to ${v.source === 'pdf' ? 'a market date above' : 'a booking'} (no booking needed)</label>
        <label class="sheet-field">Market date for the manual entry (optional)<select name="event_id"><option value="">No specific market date</option>${events.map(x => `<option value="${esc(x.id)}">${esc(nice(x.date))}${x.title || x.location ? ' — ' + esc(x.title || x.location) : ''}</option>`).join('')}</select></label>
        <label class="sheet-field">What was it for / note<input name="note" placeholder="e.g. Booth fee, October market — paid cash at the door"></label>
        <div class="sheet-actions"><button type="button" class="btn" data-sheet-close>Cancel</button><button class="btn primary">Record payment</button></div>
      </form>`);
    const form = ctx.sheetEl.querySelector('#v2-vendor-pay-form');
    const manualBox = form.querySelector('[name="manual"]');
    const dateSelect = form.querySelector('[name="imported_attendee_id"]');
    const syncManual = () => { if (dateSelect) { dateSelect.disabled = manualBox.checked; dateSelect.required = !manualBox.checked; } };
    manualBox.onchange = syncManual; syncManual();
    form.onsubmit = e => {
      e.preventDefault();
      const f = new FormData(e.target);
      const paidDate = String(f.get('paid_at') || today);
      ctx.closeSheet();
      if (f.get('manual') === 'on') {
        mutate(() => api('vendor-payment-manual', {
          application_id: v.source === 'pdf' ? null : v.id,
          imported_attendee_id: v.source === 'pdf' ? v.id : null,
          amount: f.get('amount'),
          paid_at: paidDate,
          payment_method: f.get('method'),
          event_id: f.get('event_id') || null,
          note: f.get('note')
        }), 'Past payment recorded in the vendor history.');
      } else {
        mutate(() => api('vendor-payment', {
          application_id: v.id,
          source: v.source,
          imported_attendee_id: v.source === 'pdf' ? f.get('imported_attendee_id') : null,
          amount: f.get('amount'),
          paid_at: new Date(paidDate + 'T16:00:00').toISOString(),
          payment_method: f.get('method'),
          note: f.get('note')
        }), 'Payment recorded. You can now email the receipt.');
      }
    };
  }

  function draw() {
    const listEl = root.querySelector('#v2-vendor-list');
    if (!rows) { listEl.innerHTML = '<div class="card empty-card">Loading vendors…</div>'; return; }
    const q = view.q;
    const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - 90);
    const shown = rows.filter(v => {
      const matchesSearch = !q || [v.business, v.name, v.email, v.phone, v.category].some(x => String(x || '').toLowerCase().includes(q));
      if (!matchesSearch) return false;
      if (view.filter === 'regular') return !!v.regular_vendor;
      if (view.filter === 'pdf') return v.source === 'pdf';
      if (view.filter === 'inactive') {
        const last = (v.dates || []).map(x => new Date(String(x.date).slice(0, 10) + 'T12:00:00')).sort((a, b) => b - a)[0];
        return !last || last < cutoff;
      }
      return true;
    });
    root.querySelector('#v2-return-count').textContent = selected.size ? selected.size + ' selected' : '';
    listEl.innerHTML = `<p class="note">${shown.length} of ${rows.length} vendors shown.</p><div class="vendor-list">${shown.map(cardHtml).join('') || '<div class="card empty-card">No matching vendors.</div>'}</div>`;
    listEl.querySelectorAll('[data-act]').forEach(btn => btn.onclick = () => {
      const v = findVendor(btn.dataset.id);
      if (!v) { ctx.toast('That vendor is no longer in the list — reloading.', true); refresh().catch(e => ctx.toast(e.message, true)); return; }
      if (btn.dataset.act === 'profile') profileSheet(v);
      else if (btn.dataset.act === 'edit') editSheet(v);
      else if (btn.dataset.act === 'pay') paySheet(v);
      else if (btn.dataset.act === 'statement') mutate(() => api('vendor-statement-email', { application_id: v.id, source: v.source, year }), year + ' statement emailed to vendor and organizer copy sent.');
    });
    listEl.querySelectorAll('[data-receipt]').forEach(btn => btn.onclick = () =>
      mutate(() => api('vendor-receipt', { payment_id: btn.dataset.receipt }), 'Receipt emailed to vendor and organizer copy sent.'));
    listEl.querySelectorAll('[data-issue]').forEach(btn => btn.onclick = () => {
      const x = (creditSources || []).find(s => String(s.id) === String(btn.dataset.issue) && s.imported === (btn.dataset.imported === '1'));
      if (!x) { ctx.toast('That record is no longer available — reloading.', true); refresh().catch(e => ctx.toast(e.message, true)); return; }
      issueSheet(x);
    });
    listEl.querySelectorAll('[data-select]').forEach(box => box.onchange = () => {
      if (box.checked) selected.add(String(box.dataset.select)); else selected.delete(String(box.dataset.select));
      root.querySelector('#v2-return-count').textContent = selected.size ? selected.size + ' selected' : '';
    });
  }

  root.querySelector('#v2-vendor-filter').value = view.filter;
  root.querySelector('#v2-vendor-search').oninput = e => { view.q = e.target.value.toLowerCase().trim(); draw(); };
  root.querySelector('#v2-vendor-filter').onchange = e => { view.filter = e.target.value; draw(); };
  root.querySelector('#v2-return-send').onclick = () => {
    const ids = [...selected];
    if (!ids.length) { ctx.toast('Select at least one vendor first.', true); return; }
    mutate(() => api('vendor-reengage', { ids, subject: root.querySelector('#v2-return-subject').value, body: root.querySelector('#v2-return-body').value }),
      'Return invitation emailed to the selected vendor(s).');
  };

  draw();
  refresh().catch(e => {
    root.querySelector('#v2-vendor-list').innerHTML = `<div class="card empty-card"><p><strong>Vendors couldn't load.</strong></p><p class="muted">${esc(e.message)}</p></div>`;
  });
}
