// Expenses: the expense log (add / delete) plus the two printable
// reports the classic Expenses tab carries — the Tumbler Credit Report
// (Ashley / Salty Luna Co reconciliation) and the Itemized Expense
// Report with CSV export. Native v2 port of the classic expensePanel +
// expense-reports sections: same admin-payload rows, same 'expense'
// action, same tumbler detection (category "tumbler credit" or the
// description mentioning it), same filter/sort math, same print
// documents. Vendor cancellation credits are intentionally excluded —
// they are not expenses.
import { api, esc, nice, todayKey } from './api.js?v=20261023-10';
import { printExpenseReport } from './print.js?v=20261023-10';

const usd = n => '$' + (Number(n || 0) / 100).toFixed(2);
const dateKey = v => String(v || '').slice(0, 10);
const fmtDate = v => v ? nice(v) : '—';
export const isTumblerRow = r => String(r.category || '').toLowerCase() === 'tumbler credit' || String(r.description || '').toLowerCase().includes('tumbler credit');

let view = { kind: 'all', market: '', from: '', to: '' };

export function expenseRows(admin) {
  const events = new Map((admin.allEvents || []).map(e => [String(e.id), e]));
  const locations = new Map((admin.locations || []).map(l => [String(l.id), l]));
  return (admin.expenses || []).map(r => {
    const event = events.get(String(r.event_id)) || {};
    const location = locations.get(String(event.location_id)) || {};
    const tumbler = isTumblerRow(r);
    return {
      ...r,
      market: event.title ? (location.market_name || event.title) : 'General / Not assigned',
      quantity: tumbler ? Number(r.tumbler_quantity || 0) : 0
    };
  });
}

function csvDownload(rows) {
  const header = ['Expense date', 'Market date', 'Market', 'Category', 'Description', 'Payee', 'Tumblers', 'Amount ($)', 'Notes'];
  const guard = v => { const s = String(v ?? ''); return /^[=+@-]/.test(s) ? ("'" + s) : s; };
  const quote = v => '"' + guard(v).replace(/"/g, '""') + '"';
  const csv = [header, ...rows.map(r => [dateKey(r.expense_date), dateKey(r.event_date), r.market, r.category, r.description, r.payee, r.quantity, (Number(r.amount) / 100).toFixed(2), r.notes])].map(row => row.map(quote).join(',')).join('\r\n');
  const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8' });
  const anchor = document.createElement('a');
  anchor.href = URL.createObjectURL(blob);
  anchor.download = 'trinity-expenses-' + new Date().toISOString().slice(0, 10) + '.csv';
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(anchor.href), 1500);
}

export function renderExpenses(ctx, root) {
  const admin = () => ctx.state.admin;
  const mutate = async (call, okMsg) => {
    try {
      await call();
      await ctx.refreshAdmin();
      drawAll();
      if (okMsg) ctx.toast(okMsg);
    } catch (e) { ctx.toast(e.message, true); }
  };

  function filteredRows(all) {
    return all.filter(r => {
      const expenseDate = dateKey(r.expense_date);
      if (view.kind === 'tumbler' && !isTumblerRow(r)) return false;
      if (view.kind === 'other' && isTumblerRow(r)) return false;
      if (view.market === 'general' && r.event_id) return false;
      if (view.market && view.market !== 'general' && String(r.event_id) !== view.market) return false;
      if (view.from && expenseDate < view.from) return false;
      if (view.to && expenseDate > view.to) return false;
      return true;
    }).sort((a, b) => dateKey(a.event_date || a.expense_date).localeCompare(dateKey(b.event_date || b.expense_date)) || String(a.description).localeCompare(String(b.description)));
  }

  function drawAll() {
    const a = admin();
    const all = expenseRows(a);
    const tumblerRows = all.filter(isTumblerRow).sort((x, y) => dateKey(x.event_date || x.expense_date).localeCompare(dateKey(y.event_date || y.expense_date)));
    const tumblerTotal = tumblerRows.reduce((n, r) => n + Number(r.amount || 0), 0);
    const tumblerCount = tumblerRows.reduce((n, r) => n + Number(r.quantity || 0), 0);
    const shown = filteredRows(all);
    const shownTotal = shown.reduce((n, r) => n + Number(r.amount || 0), 0);
    const shownQty = shown.reduce((n, r) => n + Number(r.quantity || 0), 0);
    const eventOptions = [...(a.allEvents || [])].sort((x, y) => dateKey(y.date).localeCompare(dateKey(x.date)));

    root.innerHTML = `
    <p class="eyebrow">Money</p>
    <h2 class="display">Expenses</h2>
    <p class="lede">Market costs against what you collected — log expenses, reconcile the tumbler credits, and print itemized reports.</p>

    <section class="card">
      <h3 class="section-title first">Tumbler Credit Report — Ashley / Salty Luna Co</h3>
      <p class="note">Dedicated reconciliation of merchandise credits toward Salty Luna Co vendor invoices. Each tumbler is credited at $20. Vendor cancellation credits are excluded.</p>
      <div class="stat-grid">
        <div class="stat"><b>${usd(tumblerTotal)}</b><span>Total tumbler credits</span></div>
        <div class="stat"><b>${tumblerCount}</b><span>Total tumblers</span></div>
        <div class="stat"><b>${tumblerRows.length}</b><span>Market dates</span></div>
      </div>
      <div class="vendor-actions"><button class="btn primary small" id="v2-exp-tumbler-print" ${tumblerRows.length ? '' : 'disabled'}>Print Tumbler Credit Report</button></div>
      <div class="tbl-wrap"><table class="tbl"><thead><tr><th>Market date</th><th>Market</th><th>Tumblers</th><th>Invoice credit</th><th>Notes</th></tr></thead><tbody>
        ${tumblerRows.map(r => `<tr><td>${esc(fmtDate(r.event_date))}</td><td>${esc(r.market)}</td><td>${r.quantity}</td><td><strong>${usd(r.amount)}</strong></td><td>${esc(r.notes || '')}</td></tr>`).join('') || '<tr><td colspan="5">No tumbler credits have been recorded.</td></tr>'}
      </tbody></table></div>
      <p class="note">This report shows recorded credits. Verify that the same amounts are deducted from the corresponding invoices before marking them reconciled.</p>
    </section>

    <section class="card">
      <h3 class="section-title first">Log an expense</h3>
      <form id="v2-exp-form">
        <label class="sheet-field">Date<input name="expense_date" type="date" value="${todayKey()}" required></label>
        <label class="sheet-field">Market date (optional)<select name="event_id"><option value="">General expense</option>${(a.allEvents || []).map(e => `<option value="${esc(e.id)}">${esc(nice(e.date))}</option>`).join('')}</select></label>
        <label class="sheet-field">Description<input name="description" maxlength="300" required placeholder="Table rental, supplies, advertising..."></label>
        <label class="sheet-field">Amount ($)<input name="amount" type="number" min="0.01" step="0.01" required></label>
        <label class="sheet-field">Notes (optional)<textarea name="notes" maxlength="1000" rows="2"></textarea></label>
        <div class="sheet-actions"><button class="btn primary">Save expense</button></div>
      </form>
    </section>

    <section class="card">
      <h3 class="section-title first">Itemized Expense Report</h3>
      <p class="note">Print all expenses or a separate reconciliation for Ashley / Salty Luna Co. Cancellation credits are not included.</p>
      <div class="filter-row">
        <label class="picker-label">Report type<select id="v2-exp-kind" class="picker"><option value="all">All expenses</option><option value="tumbler">Tumbler Credits — Ashley</option><option value="other">Other expenses</option></select></label>
        <label class="picker-label">Market date<select id="v2-exp-market" class="picker"><option value="">All market dates</option><option value="general">General / No market assigned</option>${eventOptions.map(e => `<option value="${esc(e.id)}">${esc(nice(e.date))} — ${esc((a.locations || []).find(l => String(l.id) === String(e.location_id))?.market_name || e.title || 'Market')}</option>`).join('')}</select></label>
        <label class="picker-label">Expense date from<input id="v2-exp-from" class="picker" type="date" value="${esc(view.from)}"></label>
        <label class="picker-label">Expense date through<input id="v2-exp-to" class="picker" type="date" value="${esc(view.to)}"></label>
      </div>
      <div class="vendor-actions">
        <button class="btn primary small" id="v2-exp-print" ${shown.length ? '' : 'disabled'}>Print Expense Report</button>
        <button class="btn small" id="v2-exp-csv" ${shown.length ? '' : 'disabled'}>Export CSV</button>
        <button class="btn small ghost" id="v2-exp-ashley">Ashley Tumbler Credits</button>
      </div>
      <p class="note"><strong>${shown.length}</strong> entries · <strong>${usd(shownTotal)}</strong> total${shownQty ? ' · <strong>' + shownQty + '</strong> tumblers' : ''}</p>
      <div class="tbl-wrap"><table class="tbl"><thead><tr><th>Expense date</th><th>Market date</th><th>Market</th><th>Description / Payee</th><th>Category</th><th>Tumblers</th><th>Amount</th></tr></thead><tbody>
        ${shown.map(r => `<tr><td>${esc(fmtDate(r.expense_date))}</td><td>${esc(fmtDate(r.event_date))}</td><td>${esc(r.market)}</td><td><strong>${esc(r.description)}</strong>${r.payee ? '<br><span class="muted">' + esc(r.payee) + '</span>' : ''}</td><td>${esc(r.category || '')}</td><td>${r.quantity || '—'}</td><td>${usd(r.amount)}</td></tr>`).join('') || '<tr><td colspan="7">No expenses match these filters.</td></tr>'}
      </tbody></table></div>
      <p class="note">Tumbler credits are recorded as non-cash invoice deductions, not as payments made to Ashley. This expense report does not yet prove the invoice itself was adjusted.</p>
    </section>

    <h3 class="section-title">Expense log</h3>
    <div class="vendor-list">
      ${(a.expenses || []).map(x => `
        <article class="card vendor">
          <div class="vendor-top"><div><h3>${esc(x.description)}</h3>
          <div class="contact">${esc(nice(x.expense_date))} · ${x.event_date ? esc(nice(x.event_date)) : 'General expense'} · ${usd(x.amount)}</div></div>
          <button class="btn small danger" data-del-expense="${esc(x.id)}">Delete</button></div>
          ${x.notes ? `<p class="note">${esc(x.notes)}</p>` : ''}
        </article>`).join('') || '<div class="card empty-card">No expenses logged yet.</div>'}
    </div>`;

    root.querySelector('#v2-exp-tumbler-print').onclick = () => {
      try { printExpenseReport(tumblerRows, 'Ashley / Salty Luna Co — tumbler merchandise credits', isTumblerRow); }
      catch (e) { ctx.toast(e.message, true); }
    };
    root.querySelector('#v2-exp-form').onsubmit = e => {
      e.preventDefault();
      const f = new FormData(e.target);
      mutate(() => api('expense', {
        expense_date: f.get('expense_date'),
        event_id: f.get('event_id'),
        description: f.get('description'),
        amount: Math.round(Number(f.get('amount')) * 100),
        notes: f.get('notes')
      }), 'Expense saved.');
    };
    root.querySelector('#v2-exp-kind').value = view.kind;
    root.querySelector('#v2-exp-market').value = view.market;
    root.querySelector('#v2-exp-kind').onchange = e => { view.kind = e.target.value; drawAll(); };
    root.querySelector('#v2-exp-market').onchange = e => { view.market = e.target.value; drawAll(); };
    root.querySelector('#v2-exp-from').onchange = e => { view.from = e.target.value; drawAll(); };
    root.querySelector('#v2-exp-to').onchange = e => { view.to = e.target.value; drawAll(); };
    root.querySelector('#v2-exp-ashley').onclick = () => { view = { kind: 'tumbler', market: '', from: '', to: '' }; drawAll(); };
    root.querySelector('#v2-exp-print').onclick = () => {
      const sel = root.querySelector('#v2-exp-kind');
      try { printExpenseReport(shown, sel.selectedOptions[0]?.textContent || 'All expenses', isTumblerRow); }
      catch (e) { ctx.toast(e.message, true); }
    };
    root.querySelector('#v2-exp-csv').onclick = () => csvDownload(shown);
    root.querySelectorAll('[data-del-expense]').forEach(b => b.onclick = () =>
      mutate(() => api('expense', { id: b.dataset.delExpense }), 'Expense deleted.'));
  }

  drawAll();
}
