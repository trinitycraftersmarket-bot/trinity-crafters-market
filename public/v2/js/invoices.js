// Invoice Center: accounts receivable across regular bookings, imported
// invoices and monthly billing — one list, from the shared invoiceRows()
// builder (js/money.js) so its totals always match the Payment Log.
// Ported from the legacy invoiceCenter(): same stats, same filters, same
// per-kind actions (imported-invoice-status / -update / -email / -void,
// paypal-invoice / paypal-sync), plus the manual-payment sheet
// (vendor-payment) the Attendees panel uses, and a receipts strip fed by
// vendor-list payments (vendor-receipt, with receipt_sent_at shown).
// Mutations re-fetch the admin payload, then re-render (§1 rule 1).
import { api, esc, money, nice, niceShort, marketName } from './api.js?v=20261024-23';
import { invoiceRows, invoiceStats, isOverdue, isDueSoon, overdueDays } from './money.js?v=20261024-23';

let view = { q: '', status: '', eventId: '' };

export function renderInvoices(ctx, root) {
  root.innerHTML = `
    <p class="eyebrow">Money</p>
    <h2 class="display">Invoice Center</h2>
    <p class="lede">Accounts receivable for regular bookings, imported invoices, and Monthly Billing.</p>
    <div class="stat-grid" id="v2-inv-summary"></div>
    <div class="card filter-card">
      <div class="search"><input id="v2-inv-search" type="search" placeholder="Search name, business or email…" autocomplete="off" value="${esc(view.q)}"></div>
      <div class="filter-row">
        <label class="picker-label">Status<select id="v2-inv-status" class="picker">
          <option value="">All invoices</option><option value="unpaid">Unpaid</option><option value="overdue">Overdue</option><option value="paid">Paid</option><option value="monthly">Monthly Billing</option>
        </select></label>
        <label class="picker-label">Market date<select id="v2-inv-event" class="picker"></select></label>
      </div>
    </div>
    <div id="v2-inv-list"></div>
    <h3 class="section-title">Recent recorded payments &amp; receipts</h3>
    <div id="v2-inv-receipts"><div class="card empty-card">Loading recorded payments…</div></div>`;

  const admin = () => ctx.state.admin;
  const findRow = (kind, id) => invoiceRows(admin()).find(x => x.kind === kind && String(x.id) === String(id));
  const mutate = async (call, okMsg) => {
    try {
      await call();
      await ctx.refreshAdmin();
      draw();
      if (okMsg) ctx.toast(okMsg);
    } catch (e) { ctx.toast(e.message, true); }
  };

  function marketLine(x) {
    if (x.kind === 'monthly') return (x.items || []).flatMap(i => i.market_dates || []).map(m => nice(m.date) + ' — ' + (m.location || m.market_name || '')).join(', ');
    return x.event ? nice(x.event.date) + ' — ' + (x.event.location || marketName(x.event)) : '';
  }
  function confirmSheet(title, body, confirmLabel, danger, run) {
    ctx.openSheet(`
      <h3 class="sheet-title">${esc(title)}</h3>
      <p>${body}</p>
      <div class="sheet-actions"><button class="btn" data-sheet-close>Cancel</button><button class="btn ${danger ? 'danger' : 'primary'}" id="v2-confirm-go">${esc(confirmLabel)}</button></div>`);
    ctx.sheetEl.querySelector('#v2-confirm-go').onclick = () => { ctx.closeSheet(); run(); };
  }
  function paySheet(x) {
    ctx.openSheet(`
      <h3 class="sheet-title">Record payment</h3>
      <p><strong>${esc(x.business || x.name || 'Vendor')}</strong>${x.event ? '<br>' + esc(nice(x.event.date)) : ''}</p>
      <form id="v2-inv-pay-form">
        <label class="sheet-field">Amount ($)<input name="amount" type="number" min="0.01" step="0.01" value="${(x.amount / 100).toFixed(2)}" required></label>
        <label class="sheet-field">Payment method<select name="payment_method"><option>GoDaddy Payments</option><option>PayPal</option><option>Cash</option><option>Check</option><option>Other</option></select></label>
        <label class="sheet-field">Note<input name="note" placeholder="Optional note or transaction reference"></label>
        <div class="sheet-actions"><button type="button" class="btn" data-sheet-close>Cancel</button><button class="btn primary">Record payment &amp; mark paid</button></div>
      </form>`);
    ctx.sheetEl.querySelector('#v2-inv-pay-form').onsubmit = e => {
      e.preventDefault();
      const f = new FormData(e.target);
      ctx.closeSheet();
      mutate(() => api('vendor-payment', {
        application_id: x.application_id, source: 'application', booking_id: x.id,
        amount: Number(f.get('amount')), payment_method: f.get('payment_method'), note: f.get('note')
      }), 'Payment recorded and booking marked paid.');
    };
  }
  function editSheet(x) {
    ctx.openSheet(`
      <h3 class="sheet-title">Edit invoice</h3>
      <p><strong>${esc(x.business || x.name || 'Vendor')}</strong></p>
      <form id="v2-inv-edit-form">
        <label class="sheet-field">Amount ($)<input name="amount" type="number" min="0" step="0.01" value="${(x.amount / 100).toFixed(2)}" required></label>
        <label class="sheet-field">Due date<input name="due_date" type="date" value="${x.due ? String(x.due).slice(0, 10) : ''}"></label>
        <div class="sheet-actions"><button type="button" class="btn" data-sheet-close>Cancel</button><button class="btn primary">Save invoice</button></div>
      </form>`);
    ctx.sheetEl.querySelector('#v2-inv-edit-form').onsubmit = e => {
      e.preventDefault();
      const f = new FormData(e.target);
      ctx.closeSheet();
      mutate(() => api('imported-invoice-update', { id: x.id, amount: f.get('amount'), due_date: f.get('due_date') }), 'Invoice saved.');
    };
  }
  function actionsHtml(x) {
    const id = esc(x.id), kind = esc(x.kind);
    if (x.kind === 'imported') return `
      <button class="btn primary small" data-act="imp-status" data-kind="${kind}" data-id="${id}" data-status="${x.paystatus === 'paid' ? 'unpaid' : 'paid'}">${x.paystatus === 'paid' ? 'Mark unpaid' : 'Mark invoice paid'}</button>
      <button class="btn small" data-act="imp-email" data-kind="${kind}" data-id="${id}">Email invoice</button>
      <button class="btn small" data-act="imp-edit" data-kind="${kind}" data-id="${id}">Edit invoice</button>
      <button class="btn small danger" data-act="imp-void" data-kind="${kind}" data-id="${id}">Void invoice</button>`;
    if (x.kind === 'regular') return `
      ${x.status === 'approved' ? `<button class="btn primary small" data-act="pp-invoice" data-kind="${kind}" data-id="${id}">Create &amp; send PayPal invoice</button>` : ''}
      ${x.status === 'held' ? `<button class="btn primary small" data-act="pp-sync" data-kind="${kind}" data-id="${id}">Check PayPal payment</button>` : ''}
      ${x.paystatus !== 'paid' ? `<button class="btn small" data-act="record" data-kind="${kind}" data-id="${id}">Record payment</button>` : ''}`;
    return '<span class="note">Managed in Monthly Billing.</span>';
  }
  function cardHtml(x) {
    const overdue = isOverdue(x);
    return `<article class="card vendor">
      <div class="vendor-top">
        <div><h3>${esc(x.business || x.name || x.vendor_name || 'Vendor')}</h3>
        <div class="contact">${esc(x.name || x.vendor_name || '')} · ${esc(x.email || x.vendor_email || '')}${x.phone ? ' · ' + esc(x.phone) : ''}</div></div>
        <strong class="amount-due">${money(x.amount)}</strong>
      </div>
      <div class="chips">
        ${overdue ? `<span class="status bad">OVERDUE — ${overdueDays(x)} DAYS</span>` : `<span class="status ${x.paystatus === 'paid' ? 'ok' : 'warn'}">${esc(x.paystatus)}</span>`}
        <span class="status neutral">${esc(x.kind)}</span>
        ${isDueSoon(x) ? '<span class="status warn">Due within 7 days</span>' : ''}
      </div>
      <p class="note">${marketLine(x) ? '<strong>Market:</strong> ' + esc(marketLine(x)) + '<br>' : ''}${x.due ? '<strong>Due:</strong> ' + esc(niceShort(x.due)) + '<br>' : ''}${x.payment_method ? '<strong>Payment:</strong> ' + esc(x.payment_method) + '<br>' : ''}${x.sent_at ? '<strong>Sent:</strong> ' + esc(new Date(x.sent_at).toLocaleDateString('en-US', { timeZone: 'America/New_York' })) : ''}</p>
      <div class="vendor-actions">${actionsHtml(x)}</div>
    </article>`;
  }

  function draw() {
    const a = admin();
    const rows = invoiceRows(a);
    const stats = invoiceStats(rows);
    root.querySelector('#v2-inv-summary').innerHTML = `
      <div class="stat ${stats.outstandingCount ? 'warn' : ''}"><b>${money(stats.outstanding)}</b><span>Outstanding · ${stats.outstandingCount} invoices</span></div>
      <div class="stat ${stats.overdueCount ? 'warn' : ''}"><b>${money(stats.overdue)}</b><span>Overdue · ${stats.overdueCount} need attention</span></div>
      <div class="stat"><b>${money(stats.dueSoon)}</b><span>Due within 7 days · ${stats.dueSoonCount} invoices</span></div>
      <div class="stat"><b>${money(stats.paidMonth)}</b><span>Paid this month</span></div>
      <p class="note">Needs attention: <strong>${stats.overdueCount}</strong> overdue · <strong>${stats.monthlyUnsent}</strong> monthly invoices not emailed · <strong>${stats.dueSoonCount}</strong> due within 7 days.</p>`;
    const evSel = root.querySelector('#v2-inv-event');
    const events = a.allEvents || a.events || [];
    evSel.innerHTML = '<option value="">All market dates</option>' + events.map(e => `<option value="${esc(e.id)}">${esc(nice(e.date))} — ${esc((a.locations || []).find(l => String(l.id) === String(e.location_id))?.market_name || marketName(e))}</option>`).join('');
    evSel.value = view.eventId;
    root.querySelector('#v2-inv-status').value = view.status;
    const filtered = rows.filter(x => {
      const who = (x.business || x.name || x.vendor_name || '') + ' ' + (x.email || x.vendor_email || '');
      if (view.q && !who.toLowerCase().includes(view.q)) return false;
      if (view.eventId) {
        if (x.kind === 'monthly') { if (!(x.items || []).flatMap(i => i.event_ids || []).map(String).includes(view.eventId)) return false; }
        else if (String(x.event_id) !== view.eventId) return false;
      }
      if (view.status === 'unpaid' && x.paystatus === 'paid') return false;
      if (view.status === 'paid' && x.paystatus !== 'paid') return false;
      if (view.status === 'overdue' && !isOverdue(x)) return false;
      if (view.status === 'monthly' && x.kind !== 'monthly') return false;
      return true;
    }).sort((x, y) => String(x.business || x.name || x.vendor_name || '').localeCompare(String(y.business || y.name || y.vendor_name || ''), undefined, { sensitivity: 'base' }));
    const unpaidCount = filtered.filter(x => x.paystatus !== 'paid').length;
    const list = root.querySelector('#v2-inv-list');
    list.innerHTML = `<p class="note"><strong>${unpaidCount}</strong> unpaid · <strong>${filtered.length - unpaidCount}</strong> paid · <strong>${money(filtered.filter(x => x.paystatus !== 'paid').reduce((s, x) => s + x.amount, 0))}</strong> due in this view</p>`
      + `<div class="vendor-list">${filtered.map(cardHtml).join('') || '<div class="card empty-card">No invoices match these filters.</div>'}</div>`;
    list.querySelectorAll('[data-act]').forEach(btn => btn.onclick = () => {
      const x = findRow(btn.dataset.kind, btn.dataset.id);
      if (!x) { ctx.toast('That invoice is no longer in the list — reloading.', true); ctx.refreshAdmin().then(draw); return; }
      const act = btn.dataset.act;
      if (act === 'imp-status') mutate(() => api('imported-invoice-status', { id: x.id, status: btn.dataset.status }), 'Invoice updated.');
      else if (act === 'imp-email') confirmSheet('Email this invoice?', `Send the invoice for <strong>${esc(x.business || x.name || 'this vendor')}</strong> (${money(x.amount)}) to ${esc(x.email || 'their email')} now?`, 'Email invoice', false,
        () => mutate(() => api('imported-invoice-email', { id: x.id }), 'Invoice emailed.'));
      else if (act === 'imp-edit') editSheet(x);
      else if (act === 'imp-void') confirmSheet('Void this invoice?', 'This removes the amount due but does not cancel the vendor booking.', 'Void invoice', true,
        () => mutate(() => api('imported-invoice-void', { id: x.id }), 'Invoice voided.'));
      else if (act === 'pp-invoice') confirmSheet('Send a PayPal invoice?', `Create and email <strong>${esc(x.business || x.name || 'this vendor')}</strong> a PayPal invoice now? The 24-hour payment hold starts immediately after PayPal sends it.`, 'Create & send', false,
        () => mutate(async () => { const r = await api('paypal-invoice', { id: x.id }); ctx.toast('PayPal invoice ' + r.invoice_id + ' was sent.'); }, null));
      else if (act === 'pp-sync') mutate(async () => {
        const r = await api('paypal-sync', { id: x.id });
        ctx.toast(['PAID', 'MARKED_AS_PAID', 'PAID_EXTERNAL'].includes(r.status) ? 'Payment confirmed — booking marked paid.' : 'PayPal invoice status: ' + r.status);
      }, null);
      else if (act === 'record') paySheet(x);
    });
  }

  // Receipts strip: vendor-list payments carry receipt_sent_at; resending
  // goes through vendor-receipt exactly like the legacy Vendors panel.
  async function drawReceipts() {
    const box = root.querySelector('#v2-inv-receipts');
    try {
      const vendors = await api('vendor-list');
      const payments = vendors.flatMap(v => (v.payments || []).map(p => ({ ...p, vendor: v.business || v.name || 'Vendor' })))
        .sort((a, b) => String(b.paid_at).localeCompare(String(a.paid_at))).slice(0, 25);
      box.innerHTML = `<div class="vendor-list">${payments.map(p => `<article class="card vendor">
        <div class="vendor-top"><div><h3>${esc(p.vendor)}</h3>
        <div class="contact">${esc(new Date(p.paid_at).toLocaleDateString('en-US', { timeZone: 'America/New_York' }))} · ${esc(p.payment_method || '')}${p.note ? ' · ' + esc(p.note) : ''}</div></div>
        <strong class="amount-due">${money(p.amount)}</strong></div>
        <div class="vendor-actions">
          <span class="status ${p.receipt_sent_at ? 'ok' : 'neutral'}">${p.receipt_sent_at ? 'Receipt sent ' + esc(new Date(p.receipt_sent_at).toLocaleDateString('en-US')) : 'No receipt sent'}</span>
          <button class="btn small" data-receipt="${esc(p.id)}">${p.receipt_sent_at ? 'Resend receipt' : 'Email receipt'}</button>
        </div>
      </article>`).join('') || '<div class="card empty-card">No recorded payments yet.</div>'}</div>`;
      box.querySelectorAll('[data-receipt]').forEach(btn => btn.onclick = async () => {
        try {
          await api('vendor-receipt', { payment_id: btn.dataset.receipt });
          ctx.toast('Receipt emailed to vendor and organizer copy sent.');
          drawReceipts();
        } catch (e) { ctx.toast(e.message, true); }
      });
    } catch (e) {
      box.innerHTML = `<div class="card empty-card"><p class="muted">Recorded payments couldn't load (${esc(e.message)}). Receipts also live on each vendor's card in the Vendor Directory.</p></div>`;
    }
  }

  root.querySelector('#v2-inv-search').oninput = e => { view.q = e.target.value.trim().toLowerCase(); draw(); };
  root.querySelector('#v2-inv-status').onchange = e => { view.status = e.target.value; draw(); };
  root.querySelector('#v2-inv-event').onchange = e => { view.eventId = e.target.value; draw(); };

  draw();
  drawReceipts();
}
