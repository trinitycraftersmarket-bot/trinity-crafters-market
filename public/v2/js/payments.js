// Payment Log: the ONE canonical payments view (audit §4.3 — the legacy
// app had three payment tables that need not agree). Payments are grouped
// by market date, newest first, each group with a total and method
// subtotals; the summary header answers "how much did we take in?" for the
// active filters and what is still outstanding. Data is the admin
// payload's paymentLog (server-built ledger); search and the date range
// filter it here, grouping/totals come from js/money.js — the same module
// the Invoice Center uses, so the two screens always agree.
import { esc, money, nice, niceShort } from './api.js?v=20261024-28';
import { invoiceRows, invoiceStats, isOverdue, overdueDays, paymentGroups } from './money.js?v=20261024-28';

let view = { q: '', from: '', to: '', method: '', unpaidOnly: false };

const stamp = ts => {
  if (!ts) return '—';
  const d = new Date(ts);
  return d.toLocaleDateString('en-US', { timeZone: 'America/New_York', weekday: 'short', month: 'short', day: 'numeric' })
    + ' · ' + d.toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit' });
};

export function renderPayments(ctx, root) {
  root.innerHTML = `
    <p class="eyebrow">Money</p>
    <h2 class="display">Payment Log</h2>
    <p class="lede">Every recorded payment, grouped by market date with totals — when it was recorded, how it was paid, and which staff login recorded it.</p>
    <div class="stat-grid" id="v2-pay-summary"></div>
    <div class="card filter-card">
      <div class="search"><input id="v2-pay-search" type="search" placeholder="Search vendor, email, reference, method or staff…" autocomplete="off" value="${esc(view.q)}"></div>
      <div class="filters" role="group" aria-label="Date range">
        ${[['', 'All time'], ['month', 'This month'], ['30d', 'Last 30 days'], ['custom', 'Pick dates']].map(([k, t]) => `<button class="chip-btn" data-range="${k}">${t}</button>`).join('')}
        <button class="chip-btn ${view.unpaidOnly ? 'active' : ''}" id="v2-pay-unpaid" aria-pressed="${view.unpaidOnly}">Unpaid only</button>
      </div>
      <div class="filter-row" id="v2-pay-dates" hidden>
        <label class="picker-label">From<input id="v2-pay-from" type="date" class="picker" value="${esc(view.from)}"></label>
        <label class="picker-label">To<input id="v2-pay-to" type="date" class="picker" value="${esc(view.to)}"></label>
        <label class="picker-label">Method<select id="v2-pay-method" class="picker"><option value="">All methods</option></select></label>
      </div>
    </div>
    <div id="v2-pay-list"></div>`;

  const admin = () => ctx.state.admin;
  const presetRange = preset => {
    const today = new Date();
    const key = d => d.toISOString().slice(0, 10);
    if (preset === 'month') return { from: key(new Date(today.getFullYear(), today.getMonth(), 1)), to: key(today) };
    if (preset === '30d') { const d = new Date(today); d.setDate(d.getDate() - 30); return { from: key(d), to: key(today) }; }
    return { from: '', to: '' };
  };
  let preset = '';

  function searched(rows) {
    return rows.filter(x => {
      if (view.method && (x.payment_method || '') !== view.method) return false;
      if (!view.q) return true;
      return [x.vendor, x.email, x.reference, x.recorded_by, x.payment_method, x.source].some(v => String(v || '').toLowerCase().includes(view.q));
    });
  }
  function payRow(x) {
    return `<div class="pay-row">
      <div class="pay-who"><strong>${esc(x.vendor || 'Vendor')}</strong>${x.email ? `<span>${esc(x.email)}</span>` : ''}</div>
      <div class="pay-meta"><span class="status neutral">${esc(x.payment_method || '—')}</span><span class="pay-src">${esc(x.source || '')}</span></div>
      <div class="pay-when">${esc(stamp(x.recorded_at))}<span>by ${esc(x.recorded_by || 'Unknown')}${x.reference ? ' · ref ' + esc(x.reference) : ''}</span></div>
      <div class="pay-amt">${money(x.amount || 0)}</div>
    </div>`;
  }
  function groupHtml(g) {
    return `<section class="pay-group">
      <div class="pay-group-head">
        <div><h3>${g.date ? esc(nice(g.date)) : 'Monthly billing — no market date'}</h3>
        <span>${g.rows.length} payment${g.rows.length === 1 ? '' : 's'} · ${g.methods.map(m => esc(m.method) + ' ' + money(m.total)).join(' · ')}</span></div>
        <div class="pay-group-total">${money(g.total)}</div>
      </div>
      <div class="card pay-card">
        <div class="pay-row pay-head" aria-hidden="true"><div class="pay-who">Vendor</div><div class="pay-meta">Method</div><div class="pay-when">Recorded</div><div class="pay-amt">Amount</div></div>
        ${g.rows.map(payRow).join('')}
      </div>
    </section>`;
  }
  function unpaidHtml() {
    const rows = invoiceRows(admin()).filter(x => x.paystatus !== 'paid')
      .sort((a, b) => String(a.due || '9999').localeCompare(String(b.due || '9999')));
    return `<p class="note">Unpaid only is on — showing what's still owed instead of payments received. Full invoice actions live in the Invoice Center.</p>
      <div class="vendor-list">${rows.map(x => `<article class="card vendor">
        <div class="vendor-top"><div><h3>${esc(x.business || x.name || x.vendor_name || 'Vendor')}</h3>
        <div class="contact">${esc(x.email || x.vendor_email || '')}${x.event ? ' · ' + esc(niceShort(x.event.date)) : x.kind === 'monthly' ? ' · Monthly billing' : ''}</div></div>
        <strong class="amount-due">${money(x.amount)}</strong></div>
        <div class="chips">${isOverdue(x) ? `<span class="status bad">OVERDUE — ${overdueDays(x)} DAYS</span>` : '<span class="status warn">Unpaid</span>'}${x.due ? `<span class="status neutral">Due ${esc(niceShort(x.due))}</span>` : ''}<span class="status neutral">${esc(x.kind)}</span></div>
      </article>`).join('') || '<div class="card empty-card">Nothing outstanding — everyone is paid up.</div>'}</div>
      <div class="vendor-actions"><button class="btn primary small" id="v2-pay-to-invoices">Open Invoice Center</button></div>`;
  }

  function draw() {
    const a = admin();
    const stats = invoiceStats(invoiceRows(a));
    const range = { from: view.from, to: view.to };
    const filtered = searched(a.paymentLog || []);
    const groups = paymentGroups(filtered, range);
    const collected = groups.reduce((s, g) => s + g.total, 0);
    const count = groups.reduce((s, g) => s + g.rows.length, 0);
    root.querySelector('#v2-pay-summary').innerHTML = `
      <div class="stat"><b>${money(collected)}</b><span>Collected in the current view (${count} payments)</span></div>
      <button class="stat stat-btn ${stats.outstandingCount ? 'warn' : ''}" id="v2-pay-outstanding"><b>${money(stats.outstanding)}</b><span>${stats.outstandingCount} invoices still outstanding — open Invoice Center</span></button>
      <div class="stat ${stats.overdueCount ? 'warn' : ''}"><b>${money(stats.overdue)}</b><span>Overdue across ${stats.overdueCount} invoices</span></div>
      <div class="stat"><b>${money(stats.paidMonth)}</b><span>Paid this month, all sources</span></div>`;
    root.querySelector('#v2-pay-outstanding').onclick = () => ctx.navigate('invoices');
    const methodSel = root.querySelector('#v2-pay-method');
    const methods = [...new Set((a.paymentLog || []).map(x => x.payment_method).filter(Boolean))].sort();
    methodSel.innerHTML = '<option value="">All methods</option>' + methods.map(m => `<option value="${esc(m)}">${esc(m)}</option>`).join('');
    methodSel.value = view.method;
    root.querySelector('#v2-pay-dates').hidden = !(preset || view.from || view.to);
    root.querySelectorAll('[data-range]').forEach(b => b.classList.toggle('active', b.dataset.range === preset || (b.dataset.range === '' && !preset && !view.from && !view.to)));
    const list = root.querySelector('#v2-pay-list');
    if (view.unpaidOnly) {
      list.innerHTML = unpaidHtml();
      const go = root.querySelector('#v2-pay-to-invoices');
      if (go) go.onclick = () => ctx.navigate('invoices');
    } else {
      list.innerHTML = groups.map(groupHtml).join('') || '<div class="card empty-card">No payments match these filters.</div>';
    }
  }

  root.querySelector('#v2-pay-search').oninput = e => { view.q = e.target.value.trim().toLowerCase(); draw(); };
  root.querySelectorAll('[data-range]').forEach(b => b.onclick = () => {
    preset = b.dataset.range;
    if (preset === 'custom') { root.querySelector('#v2-pay-dates').hidden = false; }
    else { const r = presetRange(preset); view.from = r.from; view.to = r.to; root.querySelector('#v2-pay-from').value = view.from; root.querySelector('#v2-pay-to').value = view.to; }
    draw();
  });
  root.querySelector('#v2-pay-from').onchange = e => { view.from = e.target.value; preset = 'custom'; draw(); };
  root.querySelector('#v2-pay-to').onchange = e => { view.to = e.target.value; preset = 'custom'; draw(); };
  root.querySelector('#v2-pay-method').onchange = e => { view.method = e.target.value; draw(); };
  root.querySelector('#v2-pay-unpaid').onclick = e => {
    view.unpaidOnly = !view.unpaidOnly;
    e.currentTarget.classList.toggle('active', view.unpaidOnly);
    e.currentTarget.setAttribute('aria-pressed', String(view.unpaidOnly));
    draw();
  };

  draw();
}
