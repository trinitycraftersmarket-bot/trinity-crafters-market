// Monthly Billing: vendor monthly invoices — add bills, track balances,
// edit charges, mark GoDaddy invoices sent, print and email. Native v2
// port of the classic Monthly Billing panel (organizer-tools): same
// monthly-invoices function, same actions (list / add-bill / update /
// cancel / edit-item / delete-item / email / godaddy-sent / print), same due math
// (amount − discount + late fee; cancelled invoices are due $0). The
// classic filters only show/hide invoice cards — here they re-render
// just the list, so the Add Bill form is never disturbed.
// §49 adds partial payments: record-payment / delete-payment /
// email-receipt against the shared vendor_payments ledger. Due is the
// BALANCE (total − paid_total, which the list attaches per invoice); a
// partially covered invoice carries the stored status 'partial'.
import { api, esc, getToken, nice } from './api.js?v=20261024-36';
import { monthlyRoster, rosterPrefill, cleanEmail } from './roster.js?v=20261024-36';

const usd = n => '$' + (Number(n || 0) / 100).toFixed(2);
const DISCOUNT_REASONS = ['Barter', 'Free day', 'Credit applied', 'Rate adjustment', 'Tumbler credit', 'Other'];
const monthLabel = m => new Date(m + '-01T12:00:00').toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
const dueOf = i => i.status === 'cancelled' ? 0 : Math.max(0, Number(i.amount || 0) - Number(i.discount || 0) + Number(i.late_fee || 0) - Number(i.paid_total || 0));
const PAY_METHODS = ['Cash', 'Credit Card', 'GoDaddy Payments', 'GoDaddy Invoice', 'PayPal', 'Check', 'Other'];

// Transport for the monthly-invoices function, exactly the classic calls:
// GET (no action) lists; POSTs carry ?action= with a JSON body.
async function miCall(action, body) {
  const r = await fetch('/.netlify/functions/monthly-invoices' + (action ? '?action=' + encodeURIComponent(action) : ''), {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Authorization: 'Bearer ' + getToken(), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const v = await r.json().catch(() => ({}));
  if (!r.ok) throw Error(v.error || 'Invoice request failed.');
  return v;
}
const printUrl = id => '/.netlify/functions/monthly-invoices?action=print&id=' + encodeURIComponent(id) + '&token=' + encodeURIComponent(id);

let view = { month: null, status: '', q: '' };

export function renderBilling(ctx, root) {
  root.innerHTML = `
    <p class="eyebrow">Money</p>
    <h2 class="display">Monthly Billing</h2>
    <p class="lede">Add vendor charges, track outstanding balances, and print or email invoices.</p>
    <div id="v2-bill-slot"><div class="card empty-card">Loading invoices…</div></div>`;

  const slot = root.querySelector('#v2-bill-slot');
  let invoices = [], vendors = [];
  const drafts = new Map(); // unsaved per-card field edits, kept across list re-renders
  const events = ctx.state.admin?.events || [];
  const selectedEvents = new Set();
  const currentMonth = new Date().toISOString().slice(0, 7);

  const load = async () => {
    const [inv, vend] = await Promise.all([
      miCall(null),
      api('vendor-list').catch(() => [])
    ]);
    invoices = inv.invoices || [];
    vendors = vend || [];
    drafts.clear();
    if (view.month === null) {
      const periods = [...new Set(invoices.map(i => String(i.billing_period || '')).filter(Boolean))];
      view.month = periods.includes(currentMonth) ? currentMonth : '';
    }
    drawShell();
  };
  const mutate = async (call, okMsg) => {
    try {
      await call();
      await load();
      if (okMsg) ctx.toast(okMsg);
    } catch (e) { ctx.toast(e.message, true); }
  };

  function addBillCard() {
    const months = [...new Set(events.map(e => String(e.date || '').slice(0, 7)).filter(Boolean))].sort();
    return `<section class="card">
      <h3 class="section-title first">Add Bill</h3>
      <form id="v2-bill-add-form">
        <label class="sheet-field">Vendor search<input id="v2-bill-vsearch" type="search" placeholder="Search name, business, email or phone" autocomplete="off"></label>
        <label class="sheet-field">Vendor<select id="v2-bill-vendor"><option value="">Choose vendor</option></select></label>
        <label class="sheet-field">Description<input id="v2-bill-desc" placeholder="Example: October market booth"></label>
        <label class="sheet-field">Amount ($)<input id="v2-bill-amount" type="number" min="0.01" step="0.01"></label>
        <label class="sheet-field">Billing month<input id="v2-bill-period" type="month" value="${currentMonth}"></label>
        <label class="sheet-field">Due date<input id="v2-bill-due" type="date"></label>
        <label class="sheet-field">Show market dates for<select id="v2-bill-event-month"><option value="">All months</option>${months.map(m => `<option value="${esc(m)}">${esc(monthLabel(m))}</option>`).join('')}</select></label>
        <div class="mb-list bill-events">${events.map(e => `
          <label class="checkline bill-event-row" data-month="${esc(String(e.date || '').slice(0, 7))}"><input type="checkbox" class="bill-event-check" value="${esc(e.id)}" ${selectedEvents.has(String(e.id)) ? 'checked' : ''}> ${esc(nice(e.date))} — ${esc(e.location || '')}</label>`).join('') || '<p class="note">No upcoming market dates.</p>'}
        </div>
        <p class="note">Select every market date this bill covers. Changing the month filter will not clear dates you already selected.</p>
        <div class="sheet-actions"><button class="btn primary">Add Bill</button></div>
      </form>
    </section>`;
  }

  function invoiceCard(i) {
    const draft = drafts.get(String(i.id)) || {};
    const fVal = (key, fallback) => draft[key] !== undefined ? draft[key] : fallback;
    return `<article class="card vendor" data-bill-card="${esc(i.id)}">
      <div class="vendor-top">
        <div><h3>${esc(i.business || i.vendor_name || 'Vendor')}</h3>
        <div class="contact">${esc(i.billing_period || '')}${i.vendor_email ? ' · ' + esc(i.vendor_email) : ''}</div></div>
        <span class="status ${i.status === 'paid' ? 'ok' : i.status === 'cancelled' ? 'bad' : 'warn'}">${esc(i.status === 'partial' ? 'partially paid' : (i.status || 'draft'))}</span>
      </div>
      <p class="note">Subtotal: ${usd(i.amount)} · Discount: ${usd(i.discount || 0)}${Number(i.paid_total || 0) ? ` · Paid: ${usd(i.paid_total)}` : ''} · <strong>${Number(i.paid_total || 0) ? 'Balance' : 'Due'}: ${usd(dueOf(i))}</strong></p>
      <label class="sheet-field">Discount ($)<input type="number" min="0" step="0.01" data-f="discount" value="${esc(fVal('discount', (Number(i.discount || 0) / 100).toFixed(2)))}"></label>
      ${i.discount_reason ? `<p class="note">Discount reason: ${esc(i.discount_reason)}${i.discount_note ? ' — ' + esc(i.discount_note) : ''}</p>` : ''}
      <label class="sheet-field">Comments<textarea data-f="comment" rows="2">${esc(fVal('comment', i.payment_comment || ''))}</textarea></label>
      <label class="sheet-field">Status<select data-f="status">
        ${[['draft', 'Draft / Unpaid'], ['emailed', 'Emailed / Outstanding'], ...(i.status === 'partial' ? [['partial', 'Partially paid']] : []), ['paid', 'Paid'], ['cancelled', 'Cancelled']].map(([v, t]) => `<option value="${v}" ${fVal('status', i.status || 'draft') === v ? 'selected' : ''}>${t}</option>`).join('')}
      </select></label>
      <label class="sheet-field">Payment method<select data-f="method">
        <option value="">Choose method</option>
        ${['Cash', 'Credit Card', 'GoDaddy Invoice'].map(m => `<option ${fVal('method', i.payment_method || '') === m ? 'selected' : ''}>${m}</option>`).join('')}
      </select></label>
      <p class="note"><strong>GoDaddy invoice:</strong> ${i.godaddy_invoice_sent_count ? 'Sent ' + i.godaddy_invoice_sent_count + ' time' + (i.godaddy_invoice_sent_count === 1 ? '' : 's') + ' · First ' + esc(new Date(i.godaddy_invoice_first_sent_at).toLocaleString('en-US', { timeZone: 'America/New_York' })) + ' · Last ' + esc(new Date(i.godaddy_invoice_last_sent_at).toLocaleString('en-US', { timeZone: 'America/New_York' })) : 'Not marked sent yet'}</p>
      ${i.sent_at ? `<p class="note"><strong>Invoice email:</strong> Emailed · Last ${esc(new Date(i.sent_at).toLocaleString('en-US', { timeZone: 'America/New_York' }))} · to ${esc(i.vendor_email || '')}</p>` : ''}
      ${i.status === 'cancelled' && i.cancel_reason ? `<p class="note"><strong>Cancellation:</strong> ${esc(i.cancel_reason)}</p>` : ''}
      ${(i.payments || []).length ? `<div class="bill-payments"><h4 class="mini-title">Payments</h4>${(i.payments || []).map(p => `
        <p class="note">${esc(new Date(p.paid_at || p.created_at).toLocaleDateString('en-US', { timeZone: 'America/New_York' }))} · <strong>${usd(p.amount)}</strong> · ${esc(p.payment_method || '')}${p.note ? ' · ' + esc(p.note) : ''}${p.recorded_by ? ' · recorded by ' + esc(p.recorded_by) : ''}${p.receipt_sent_at ? ' · Receipt sent ' + esc(new Date(p.receipt_sent_at).toLocaleDateString('en-US', { timeZone: 'America/New_York' })) : ''}<br>
        <button class="btn small" data-pay-receipt="${esc(p.id)}">${p.receipt_sent_at ? 'Resend receipt' : 'Email receipt'}</button>
        <button class="btn small ghost" data-pay-delete="${esc(p.id)}">Delete payment</button></p>`).join('')}</div>` : ''}
      <div class="vendor-actions">
        <button class="btn primary small" data-bill-act="save">Save Changes</button>
        ${i.status !== 'paid' && i.status !== 'cancelled' ? '<button class="btn small" data-bill-act="record-payment">Record payment</button>' : ''}
        <button class="btn small" data-bill-act="godaddy">Mark GoDaddy Invoice Sent</button>
        <button class="btn small" data-bill-act="edit">Edit Charges</button>
        <button class="btn small" data-bill-act="print">Print</button>
        <button class="btn small" data-bill-act="email">Email</button>
        ${i.status !== 'paid' && i.status !== 'cancelled' ? '<button class="btn small ghost" data-bill-act="cancel">Cancel Invoice</button>' : ''}
      </div>
    </article>`;
  }

  // Confirm before a destructive charge delete (the vendors.js sheet pattern).
  const confirmSheet = (title, text, confirmLabel) => new Promise(resolve => {
    ctx.openSheet(`
      <h3 class="sheet-title">${esc(title)}</h3>
      <p class="note">${esc(text)}</p>
      <div class="sheet-actions">
        <button class="btn" id="v2-bill-cf-no">Cancel</button>
        <button class="btn danger" id="v2-bill-cf-yes">${esc(confirmLabel)}</button>
      </div>`);
    ctx.sheetEl.querySelector('#v2-bill-cf-no').onclick = () => resolve(false);
    ctx.sheetEl.querySelector('#v2-bill-cf-yes').onclick = () => resolve(true);
  });

  // The Edit Charges sheet holds unsaved per-field edits (per-charge Save
  // model). A delete re-renders the sheet from the server invoice, so the
  // current field values are snapshotted first: restored when a delete is
  // cancelled, and used to warn when unsaved edits would be discarded.
  // §41: per-date amounts. An entry's own amount (cents) wins when the
  // key exists and is finite — $0 included (a free date); otherwise the
  // sheet previews the legacy even split the printout shows today.
  const splitPreview = it => (Math.round(Number(it.amount || 0) / ((it.market_dates || []).length || 1)) / 100).toFixed(2);
  const entryVal = (it, m) => m && m.amount !== undefined && m.amount !== null && m.amount !== '' && Number.isFinite(Number(m.amount)) ? (Number(m.amount) / 100).toFixed(2) : splitPreview(it);
  function snapshotSheet() {
    const snap = { charges: {}, discount: undefined };
    if (!ctx.sheetEl) return snap;
    ctx.sheetEl.querySelectorAll('[data-item-desc]').forEach(el => { (snap.charges[el.dataset.itemDesc] = snap.charges[el.dataset.itemDesc] || {}).desc = el.value; });
    ctx.sheetEl.querySelectorAll('[data-item-amount]').forEach(el => { (snap.charges[el.dataset.itemAmount] = snap.charges[el.dataset.itemAmount] || {}).amount = el.value; });
    ctx.sheetEl.querySelectorAll('[data-item-date-amount]').forEach(el => { const c = (snap.charges[el.dataset.itemDateAmount] = snap.charges[el.dataset.itemDateAmount] || {}); (c.dates = c.dates || {})[el.dataset.dateIdx] = el.value; });
    const d = ctx.sheetEl.querySelector('[data-invoice-discount]');
    if (d) snap.discount = d.value;
    const dr = ctx.sheetEl.querySelector('[data-discount-reason]');
    if (dr) snap.discountReason = dr.value;
    const dn = ctx.sheetEl.querySelector('[data-discount-note]');
    if (dn) snap.discountNote = dn.value;
    return snap;
  }
  function sheetDirty(i, snap, skipIdx) {
    const items = i.items || [];
    for (const [n, c] of Object.entries(snap.charges || {})) {
      if (Number(n) === skipIdx) continue;
      const it = items[Number(n)];
      if (!it) continue;
      if (c.desc !== undefined && c.desc !== (it.description || it.space || 'Charge')) return true;
      if (c.amount !== undefined && c.amount !== (Number(it.amount || 0) / 100).toFixed(2)) return true;
      if (c.dates) { const dates = Array.isArray(it.market_dates) ? it.market_dates : []; for (const [k, v] of Object.entries(c.dates)) { const m = dates[Number(k)]; if (m && v !== entryVal(it, m)) return true; } }
    }
    if (snap.discount !== undefined && snap.discount !== (Number(i.discount || 0) / 100).toFixed(2)) return true;
    if (snap.discountReason !== undefined && snap.discountReason !== (i.discount_reason || '')) return true;
    if (snap.discountNote !== undefined && snap.discountNote !== (i.discount_note || '')) return true;
    return false;
  }

  function editChargesSheet(i, edits) {
    const items = i.items || [];
    const chargeVal = (n, key, saved) => edits && edits.charges && edits.charges[n] && edits.charges[n][key] !== undefined ? edits.charges[n][key] : saved;
    const discountVal = edits && edits.discount !== undefined ? edits.discount : (Number(i.discount || 0) / 100).toFixed(2);
    const reasonVal = edits && edits.discountReason !== undefined ? edits.discountReason : (i.discount_reason || '');
    const noteVal = edits && edits.discountNote !== undefined ? edits.discountNote : (i.discount_note || '');
    // §41: one amount input per market date under a multi-date charge's
    // Amount field, labelled with the date + location. On save the
    // per-date values win — the server stamps them and the charge
    // amount becomes their sum.
    const dateVal = (n, k, saved) => edits && edits.charges && edits.charges[n] && edits.charges[n].dates && edits.charges[n].dates[k] !== undefined ? edits.charges[n].dates[k] : saved;
    const dateInputs = (it, n) => (Array.isArray(it.market_dates) && it.market_dates.length > 1) ? `
          <div class="bill-item-dates">
            <p class="note">Amount per market date — saving makes the charge total the sum of these dates.</p>
            ${it.market_dates.map((m, k) => `<label class="sheet-field">${esc(nice(m.date))} — ${esc(m.location || m.market_name || 'Trinity Crafters Market')}${entryVal(it, m) === '0.00' ? ' (free)' : ''}<input data-item-date-amount="${n}" data-date-idx="${k}" type="number" min="0" step="0.01" value="${esc(dateVal(n, k, entryVal(it, m)))}"></label>`).join('')}
          </div>` : '';
    ctx.openSheet(`
      <h3 class="sheet-title">Edit charges</h3>
      <p><strong>${esc(i.business || i.vendor_name || 'Vendor')}</strong> · ${esc(i.billing_period || '')}</p>
      ${items.map((it, n) => `
        <div class="bill-item-edit">
          <label class="sheet-field">Charge ${n + 1} — description<input data-item-desc="${n}" value="${esc(chargeVal(n, 'desc', it.description || it.space || 'Charge'))}"></label>
          <label class="sheet-field">Amount ($)<input data-item-amount="${n}" type="number" min="0" step="0.01" value="${esc(chargeVal(n, 'amount', (Number(it.amount || 0) / 100).toFixed(2)))}"></label>${dateInputs(it, n)}
          <div class="vendor-actions"><button class="btn small" data-item-save="${n}">Save charge ${n + 1}</button><button class="btn small ghost" data-item-delete="${n}">Delete charge ${n + 1}</button></div>
        </div>`).join('') || '<p class="note">This invoice has no charge lines.</p>'}
      <div class="bill-item-edit">
        <h4 class="mini-title">Discount</h4>
        <p class="note">Charges subtotal: ${usd(i.amount)}</p>
        <label class="sheet-field">Discount ($)<input data-invoice-discount type="number" min="0" step="0.01" value="${esc(discountVal)}"></label>
        <label class="sheet-field">Reason<select data-discount-reason>
          <option value="" ${reasonVal === '' ? 'selected' : ''}>No reason</option>
          ${DISCOUNT_REASONS.map(r => `<option value="${esc(r)}" ${reasonVal === r ? 'selected' : ''}>${esc(r)}</option>`).join('')}
        </select></label>
        <label class="sheet-field">Note<textarea data-discount-note rows="2">${esc(noteVal)}</textarea></label>
        ${Number(i.late_fee || 0) ? `<p class="note">Late fee: ${usd(i.late_fee)}</p>` : ''}
        <p class="note"><strong>Total due: ${usd(dueOf(i))}</strong></p>
        <div class="vendor-actions"><button class="btn small" data-discount-save>Save discount</button></div>
      </div>
      <div class="sheet-actions"><button class="btn" data-sheet-close>Done</button></div>`);
    ctx.sheetEl.querySelectorAll('[data-item-save]').forEach(btn => btn.onclick = () => {
      const n = btn.dataset.itemSave;
      const description = ctx.sheetEl.querySelector('[data-item-desc="' + n + '"]').value;
      const amount = ctx.sheetEl.querySelector('[data-item-amount="' + n + '"]').value;
      const payload = { id: i.id, index: Number(n), description, amount };
      // §41: per-date inputs ride along (dollars, index-aligned); the
      // server stamps them and replaces the lump amount with their sum.
      const dateEls = [...ctx.sheetEl.querySelectorAll('[data-item-date-amount="' + n + '"]')].sort((a, b) => Number(a.dataset.dateIdx) - Number(b.dataset.dateIdx));
      if (dateEls.length) payload.date_amounts = dateEls.map(el => Number(el.value || 0));
      ctx.closeSheet();
      mutate(() => miCall('edit-item', payload), 'Invoice charge updated.');
    });
    ctx.sheetEl.querySelectorAll('[data-item-delete]').forEach(btn => btn.onclick = async () => {
      const n = Number(btn.dataset.itemDelete);
      const it = items[n];
      if (!it) return;
      const snap = snapshotSheet();
      const remaining = items.reduce((a, x, k) => k === n ? a : a + Number(x.amount || 0), 0);
      const newDue = dueOf({ ...i, amount: remaining });
      const desc = it.description || it.space || 'Charge';
      let text = `Delete "${desc}" (${usd(it.amount)}) from this invoice? The total due will become ${usd(newDue)}.`;
      if (sheetDirty(i, snap, n)) text += ' Unsaved edits to other charges will be lost.';
      const ok = await confirmSheet(`Delete charge ${n + 1}?`, text, 'Delete charge');
      if (!ok) { editChargesSheet(i, snap); return; }
      ctx.closeSheet();
      mutate(async () => {
        const v = await miCall('delete-item', { id: i.id, index: n });
        if (v.invoice) editChargesSheet(v.invoice);
      }, 'Charge deleted.');
    });
    const discBtn = ctx.sheetEl.querySelector('[data-discount-save]');
    if (discBtn) discBtn.onclick = async () => {
      const discount = ctx.sheetEl.querySelector('[data-invoice-discount]').value;
      const discountReason = ctx.sheetEl.querySelector('[data-discount-reason]').value;
      const discountNote = ctx.sheetEl.querySelector('[data-discount-note]').value;
      const snap = snapshotSheet();
      // The update action also writes status, payment_method and
      // payment_comment — pass the invoice's current values for all three
      // so saving a discount never silently resets them. Reason + note ride
      // along (the server preserves stored values only when keys are absent;
      // the billing card's Save Changes omits them on purpose).
      await mutate(() => miCall('update', {
        id: i.id,
        discount,
        discount_reason: discountReason,
        discount_note: discountNote,
        comment: i.payment_comment || '',
        status: i.status || 'draft',
        payment_method: i.payment_method || ''
      }), 'Discount saved.');
      const fresh = invoices.find(x => String(x.id) === String(i.id));
      if (fresh) editChargesSheet(fresh, { charges: snap.charges });
    };
  }
  function cancelSheet(i) {
    ctx.openSheet(`
      <h3 class="sheet-title">Cancel invoice</h3>
      <p><strong>${esc(i.business || i.vendor_name || 'Vendor')}</strong> · ${esc(i.billing_period || '')} · ${usd(dueOf(i))} due</p>
      <form id="v2-bill-cancel-form">
        <label class="sheet-field">Why is this invoice being cancelled?<input name="reason" value="Vendor cancelled" required></label>
        <p class="note">Cancel this invoice? It will remain in history, show as CANCELLED, and the amount due will be $0.00.</p>
        <div class="sheet-actions"><button type="button" class="btn" data-sheet-close>Keep invoice</button><button class="btn danger">Cancel invoice</button></div>
      </form>`);
    ctx.sheetEl.querySelector('#v2-bill-cancel-form').onsubmit = e => {
      e.preventDefault();
      const reason = String(new FormData(e.target).get('reason') || '').trim();
      if (!reason) { ctx.toast('Enter a cancellation reason.', true); return; }
      ctx.closeSheet();
      mutate(() => miCall('cancel', { id: i.id, reason }), 'Invoice cancelled.');
    };
  }
  // §49 — record a (partial) payment against the invoice balance. The
  // amount prefills with the full balance; Scott edits it down to what
  // the vendor actually handed over (Ken's $45-at-a-time flow).
  function recordPaymentSheet(i) {
    ctx.openSheet(`
      <h3 class="sheet-title">Record payment</h3>
      <p><strong>${esc(i.business || i.vendor_name || 'Vendor')}</strong> · ${esc(i.billing_period || '')} · Balance due: ${usd(dueOf(i))}</p>
      <form id="v2-bill-pay-form">
        <label class="sheet-field">Amount ($)<input name="amount" type="number" min="0.01" step="0.01" value="${(dueOf(i) / 100).toFixed(2)}" required></label>
        <label class="sheet-field">Payment method<select name="payment_method">${PAY_METHODS.map(m => `<option>${m}</option>`).join('')}</select></label>
        <label class="sheet-field">Comment<input name="comment" placeholder="Optional note (e.g. paid at the market)"></label>
        <div class="sheet-actions"><button type="button" class="btn" data-sheet-close>Cancel</button><button class="btn primary">Record payment</button></div>
      </form>`);
    ctx.sheetEl.querySelector('#v2-bill-pay-form').onsubmit = e => {
      e.preventDefault();
      const f = new FormData(e.target);
      ctx.closeSheet();
      mutate(() => miCall('record-payment', { id: i.id, amount: Number(f.get('amount')), payment_method: f.get('payment_method'), comment: f.get('comment') }), 'Payment recorded.');
    };
  }
  function godaddySheet(i) {
    ctx.openSheet(`
      <h3 class="sheet-title">Mark GoDaddy invoice sent</h3>
      <p><strong>${esc(i.business || i.vendor_name || 'Vendor')}</strong> · ${esc(i.billing_period || '')}</p>
      <p class="note">Mark this GoDaddy invoice as sent now? The send count and timestamps on the invoice are updated.</p>
      <div class="sheet-actions"><button class="btn" data-sheet-close>Cancel</button><button class="btn primary" id="v2-bill-godaddy-go">Mark sent</button></div>`);
    ctx.sheetEl.querySelector('#v2-bill-godaddy-go').onclick = () => {
      ctx.closeSheet();
      mutate(() => miCall('godaddy-sent', { id: i.id }), 'GoDaddy invoice sent recorded.');
    };
  }

  function shownInvoices() {
    return invoices.filter(i => {
      const st = String(i.status || 'draft').toLowerCase();
      if (view.month && String(i.billing_period || '') !== view.month) return false;
      if (view.status === 'paid' && st !== 'paid') return false;
      if (view.status === 'cancelled' && st !== 'cancelled') return false;
      if (view.status === 'outstanding' && (st === 'paid' || st === 'cancelled')) return false;
      if (view.q) {
        const hay = [i.business, i.vendor_name, i.vendor_email, ...(i.items || []).map(x => x.description || '')].join(' ').toLowerCase();
        if (!hay.includes(view.q)) return false;
      }
      return true;
    });
  }

  function drawList() {
    const listEl = slot.querySelector('#v2-bill-list');
    if (!listEl) return;
    const shown = shownInvoices();
    slot.querySelector('#v2-bill-summary').textContent = 'Showing ' + shown.length + ' of ' + invoices.length + ' invoice' + (invoices.length === 1 ? '' : 's') + (view.month ? ' for ' + monthLabel(view.month) : '') + '.';
    listEl.innerHTML = shown.map(invoiceCard).join('') || '<div class="card empty-card">No monthly invoices match.</div>';
    listEl.oninput = e => {
      const card = e.target.closest('[data-bill-card]');
      if (!card || !e.target.dataset.f) return;
      const d = drafts.get(card.dataset.billCard) || {};
      d[e.target.dataset.f] = e.target.value;
      drafts.set(card.dataset.billCard, d);
    };
    listEl.querySelectorAll('[data-bill-card]').forEach(card => {
      const inv = invoices.find(x => String(x.id) === String(card.dataset.billCard));
      if (!inv) return;
      card.querySelectorAll('[data-bill-act]').forEach(btn => btn.onclick = () => {
        const act = btn.dataset.billAct;
        if (act === 'save') mutate(() => miCall('update', {
          id: inv.id,
          discount: card.querySelector('[data-f="discount"]').value || 0,
          comment: card.querySelector('[data-f="comment"]').value || '',
          status: card.querySelector('[data-f="status"]').value || 'draft',
          payment_method: card.querySelector('[data-f="method"]').value || ''
        }), 'Invoice updated.');
        else if (act === 'godaddy') godaddySheet(inv);
        else if (act === 'record-payment') recordPaymentSheet(inv);
        else if (act === 'edit') editChargesSheet(inv);
        else if (act === 'print') window.open(printUrl(inv.id), '_blank');
        else if (act === 'email') mutate(() => miCall('email', { id: inv.id }), 'Invoice emailed to ' + (inv.vendor_email || 'the vendor') + '.');
        else if (act === 'cancel') cancelSheet(inv);
      });
      card.querySelectorAll('[data-pay-receipt]').forEach(btn => btn.onclick = () => {
        const pay = (inv.payments || []).find(x => String(x.id) === String(btn.dataset.payReceipt));
        if (pay) mutate(() => miCall('email-receipt', { id: inv.id, payment_id: pay.id }), 'Receipt emailed to ' + (inv.vendor_email || 'the vendor') + '.');
      });
      card.querySelectorAll('[data-pay-delete]').forEach(btn => btn.onclick = async () => {
        const pay = (inv.payments || []).find(x => String(x.id) === String(btn.dataset.payDelete));
        if (!pay) return;
        const ok = await confirmSheet('Delete this payment?', `Delete the ${usd(pay.amount)} ${pay.payment_method || ''} payment recorded ${new Date(pay.paid_at || pay.created_at).toLocaleDateString('en-US', { timeZone: 'America/New_York' })}? The invoice balance will go back up by that amount.`, 'Delete payment');
        if (!ok) return;
        mutate(() => miCall('delete-payment', { id: inv.id, payment_id: pay.id }), 'Payment deleted.');
      });
    });
  }

  function drawShell() {
    const periods = [...new Set(invoices.map(i => String(i.billing_period || '')).filter(Boolean))].sort().reverse();
    slot.innerHTML = `
      ${addBillCard()}
      <div id="v2-bill-roster-slot"></div>
      <section>
        <h3 class="section-title">Invoices</h3>
        <div class="card filter-card">
          <div class="filter-row">
            <label class="picker-label">Billing month<select id="v2-bill-fmonth" class="picker"><option value="">All months</option>${periods.map(m => `<option value="${esc(m)}">${esc(monthLabel(m))}</option>`).join('')}</select></label>
            <label class="picker-label">Status<select id="v2-bill-fstatus" class="picker"><option value="">All statuses</option><option value="outstanding">Outstanding</option><option value="paid">Paid</option><option value="cancelled">Cancelled</option></select></label>
          </div>
          <div class="search"><input id="v2-bill-find" type="search" placeholder="Vendor, business, email or description" autocomplete="off" value="${esc(view.q)}"></div>
          <p class="note" id="v2-bill-summary"></p>
        </div>
        <div class="vendor-list" id="v2-bill-list"></div>
      </section>`;
    slot.querySelector('#v2-bill-fmonth').value = view.month;
    slot.querySelector('#v2-bill-fstatus').value = view.status;
    slot.querySelector('#v2-bill-fmonth').onchange = e => { view.month = e.target.value; drawList(); drawRoster(); };
    slot.querySelector('#v2-bill-fstatus').onchange = e => { view.status = e.target.value; drawList(); };
    slot.querySelector('#v2-bill-find').oninput = e => { view.q = e.target.value.trim().toLowerCase(); drawList(); };

    // Add Bill wiring.
    const vendorSel = slot.querySelector('#v2-bill-vendor');
    const fillVendors = q => {
      const cur = vendorSel.value;
      vendorSel.innerHTML = '<option value="">Choose vendor</option>' + vendors
        .filter(v => v.email && (!q || [v.business, v.name, v.email, v.phone].join(' ').toLowerCase().includes(q)))
        .map(v => `<option value="${esc(String(v.email).replace(/,+\s*$/, '').trim())}" data-name="${esc(v.name || '')}" data-business="${esc(v.business || '')}">${esc(v.business || v.name || '')} — ${esc(String(v.email).replace(/,+\s*$/, '').trim())}</option>`).join('');
      if (cur) vendorSel.value = cur;
    };
    fillVendors('');
    slot.querySelector('#v2-bill-vsearch').oninput = e => fillVendors(e.target.value.trim().toLowerCase());
    const eventMonthSel = slot.querySelector('#v2-bill-event-month');
    const periodInput = slot.querySelector('#v2-bill-period');
    const syncEventRows = () => {
      const m = eventMonthSel.value;
      slot.querySelectorAll('.bill-event-row').forEach(row => { row.style.display = m && row.dataset.month !== m ? 'none' : ''; });
    };
    if ([...eventMonthSel.options].some(o => o.value === periodInput.value)) eventMonthSel.value = periodInput.value;
    eventMonthSel.onchange = syncEventRows;
    periodInput.onchange = () => {
      if ([...eventMonthSel.options].some(o => o.value === periodInput.value)) { eventMonthSel.value = periodInput.value; syncEventRows(); }
    };
    slot.querySelectorAll('.bill-event-check').forEach(box => box.onchange = () => {
      if (box.checked) selectedEvents.add(box.value); else selectedEvents.delete(box.value);
    });
    syncEventRows();
    slot.querySelector('#v2-bill-add-form').onsubmit = e => {
      e.preventDefault();
      const sel = vendorSel.selectedOptions[0];
      const payload = {
        vendor_email: vendorSel.value,
        vendor_name: sel?.dataset.name || '',
        business: sel?.dataset.business || '',
        description: slot.querySelector('#v2-bill-desc').value,
        amount: slot.querySelector('#v2-bill-amount').value,
        billing_period: periodInput.value,
        due_date: slot.querySelector('#v2-bill-due').value,
        event_ids: [...selectedEvents]
      };
      selectedEvents.clear();
      mutate(() => miCall('add-bill', payload), 'Bill added. You can print or email the invoice.');
    };

    // §48 — Monthly billing roster: every regular vendor (the flag set
    // in Vendors → Edit information) for the selected period, each
    // marked Billed / Not billed yet so nobody gets missed. Lives in its
    // own slot and re-renders alone on period changes — the Add Bill
    // form above is never disturbed.
    function drawRoster() {
      const rslot = slot.querySelector('#v2-bill-roster-slot');
      if (!rslot) return;
      const period = view.month || currentMonth;
      const roster = monthlyRoster(vendors, invoices, period);
      if (!roster.length) {
        rslot.innerHTML = `<section class="card">
          <h3 class="section-title first">Monthly billing vendors</h3>
          <p class="note">No regular vendors yet. Mark a vendor as a Regular vendor (Vendors → Edit information) and they'll appear here each month so nobody gets missed.</p>
        </section>`;
        return;
      }
      const billedCount = roster.filter(r => r.billed).length;
      rslot.innerHTML = `<section class="card">
        <h3 class="section-title first">Monthly billing vendors</h3>
        <label class="sheet-field">Bill or open for ${esc(monthLabel(period))}<select id="v2-bill-roster-sel">
          <option value="">Choose vendor — ${billedCount} of ${roster.length} billed</option>
          ${roster.map(r => `<option value="${esc(r.email)}">${esc(r.name)} — ${r.billed ? 'Billed (' + esc(r.status) + ')' : 'Not billed yet' + (r.hasAmount ? '' : ' — no monthly amount set')}</option>`).join('')}
        </select></label>
        <p class="note">${billedCount} of ${roster.length} monthly billing vendors billed for ${esc(monthLabel(period))}. Picking a vendor who isn't billed yet starts their bill in the Add Bill form, prefilled with their monthly amount when one is set.</p>
      </section>`;
      rslot.querySelector('#v2-bill-roster-sel').onchange = e => {
        const entry = roster.find(r => r.email === e.target.value);
        e.target.value = '';
        if (!entry) return;
        if (entry.billed && entry.invoice) openInvoice(entry.invoice);
        else startRosterBill(entry, period);
      };
    }
    // A billed vendor opens their invoice: scroll to its card and flash
    // it (clearing a status/search filter first if it hides the card);
    // if the card still isn't rendered, open the Edit Charges sheet.
    function openInvoice(inv) {
      const findCard = () => [...slot.querySelectorAll('[data-bill-card]')].find(c => c.dataset.billCard === String(inv.id));
      let card = findCard();
      if (!card && (view.status || view.q)) {
        view.status = ''; view.q = '';
        slot.querySelector('#v2-bill-fstatus').value = '';
        slot.querySelector('#v2-bill-find').value = '';
        drawList();
        card = findCard();
      }
      if (!card) { editChargesSheet(inv); return; }
      card.scrollIntoView({ behavior: 'smooth', block: 'center' });
      card.classList.add('roster-flash');
      setTimeout(() => card.classList.remove('roster-flash'), 2000);
    }
    // A not-yet-billed vendor starts their bill in the Add Bill form:
    // vendor and period prefilled, plus the monthly amount when one is
    // set — Scott adds the market dates it covers and submits as usual.
    function startRosterBill(entry, period) {
      const pre = rosterPrefill(entry, period);
      const search = slot.querySelector('#v2-bill-vsearch');
      if (search) search.value = '';
      fillVendors('');
      const opt = [...vendorSel.options].find(o => cleanEmail(o.value) === entry.email);
      if (opt) vendorSel.value = opt.value;
      slot.querySelector('#v2-bill-amount').value = pre.amount;
      periodInput.value = pre.billing_period;
      if ([...eventMonthSel.options].some(o => o.value === periodInput.value)) { eventMonthSel.value = periodInput.value; syncEventRows(); }
      const desc = slot.querySelector('#v2-bill-desc');
      if (desc && !desc.value) desc.value = 'Monthly billing — ' + monthLabel(period);
      slot.querySelector('#v2-bill-add-form').scrollIntoView({ behavior: 'smooth', block: 'start' });
      ctx.toast(entry.hasAmount
        ? entry.name + ' — bill started in the Add Bill form with their monthly amount. Tick the market dates it covers, then Add Bill.'
        : entry.name + ' — bill started in the Add Bill form. Enter the amount, tick the market dates it covers, then Add Bill.');
    }
    drawRoster();
    drawList();
  }

  load().catch(e => {
    slot.innerHTML = `<div class="card empty-card"><p><strong>Monthly Billing couldn't load.</strong></p><p class="muted">${esc(e.message)}</p></div>`;
  });
}
