// Reports: the financial half of the classic Reports tab — the
// per-event financial summary, Profit & Loss and A/R (money owed) print
// reports, and the Payment Report with CSV export. Native v2 port of
// the classic financialReportPanel: same admin-payload sources, same
// math (paid bookings + paid imports as income; expenses matched by
// event or by expense date; monthly invoices at amount − discount +
// late fee), same printed documents via the shared printTable builder.
// The per-date vendor/event report itself lives in Attendees — one
// place per job, as everywhere else in v2.
import { esc, nice, marketName } from './api.js?v=20261023-18';
import { printTable } from './print.js?v=20261023-18';

// The classic reports format money with cents; keep that exact format.
const usd = n => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format((Number(n) || 0) / 100);

let view = { eventId: '', method: '', q: '' };

export function plRows(admin) {
  return (admin.allEvents || []).map(e => {
    const paid = (admin.applications || []).filter(b => b.event_id === e.id && b.status === 'paid').reduce((n, b) => n + Number(b.price || 0), 0);
    const imported = (admin.importedAttendees || []).filter(x => x.event_id === e.id && !x.cancelled && x.payment_status === 'paid').reduce((n, x) => n + Number(x.invoice_amount || 0), 0);
    const expenses = (admin.expenses || []).filter(x => x.event_id === e.id || (!x.event_id && x.expense_date === String(e.date).slice(0, 10))).reduce((n, x) => n + Number(x.amount || 0), 0);
    return { date: String(e.date).slice(0, 10), market: marketName(e), income: paid + imported, expenses, pnl: paid + imported - expenses };
  }).sort((x, y) => String(y.date).localeCompare(String(x.date)));
}

export function arRows(admin) {
  const rows = [];
  (admin.applications || []).filter(x => ['approved', 'held'].includes(x.status)).forEach(x =>
    rows.push({ vendor: x.business || x.name, email: x.email || '', when: nice(x.date), amount: Number(x.price || 0), due: x.hold_until ? new Date(x.hold_until).toLocaleDateString('en-US', { timeZone: 'America/New_York' }) : 'Due now' }));
  (admin.importedAttendees || []).filter(x => !x.cancelled && x.payment_status === 'unpaid' && Number(x.invoice_amount || 0) > 0 && String(x.payment_method || '').toLowerCase() !== 'monthly billing').forEach(x => {
    const e = (admin.allEvents || []).find(ev => ev.id === x.event_id);
    rows.push({ vendor: x.business || x.name, email: x.email || '', when: e ? nice(e.date) : '', amount: Number(x.invoice_amount), due: x.invoice_due_date ? nice(x.invoice_due_date) : 'Due now' });
  });
  (admin.monthlyInvoices || []).filter(x => x.status !== 'paid').forEach(x => {
    const due = Math.max(0, Number(x.amount || 0) - Number(x.discount || 0) + Number(x.late_fee || 0));
    if (due) rows.push({ vendor: x.business || x.vendor_name || '', email: x.vendor_email || '', when: x.billing_period || '', amount: due, due: x.due_date ? nice(x.due_date) : 'Due now' });
  });
  return rows;
}

export function renderReports(ctx, root) {
  const admin = () => ctx.state.admin;

  function paymentRows() {
    const method = view.method.toLowerCase(), q = view.q;
    return (admin().importedAttendees || [])
      .filter(x => x.payment_status === 'paid' && Number(x.invoice_amount || 0) > 0 && String(x.payment_method || '').toLowerCase() !== 'monthly billing'
        && (!view.eventId || x.event_id === view.eventId)
        && (!method || String(x.payment_method || '').toLowerCase() === method)
        && (!q || [x.name, x.business, x.email].some(v => String(v || '').toLowerCase().includes(q))))
      .sort((x, y) => String(y.paid_at || y.created_at || '').localeCompare(String(x.paid_at || x.created_at || '')));
  }

  function buildPL() {
    const events = plRows(admin());
    const income = events.reduce((n, r) => n + r.income, 0), expenses = events.reduce((n, r) => n + r.expenses, 0);
    const net = income - expenses;
    const netLabel = net > 0 ? 'NET PROFIT' : net < 0 ? 'NET LOSS' : 'BREAK EVEN';
    const result = n => n > 0 ? 'PROFIT ' + usd(n) : n < 0 ? 'LOSS (' + usd(Math.abs(n)) + ')' : 'BREAK EVEN';
    printTable('Profit & Loss', 'All market dates', ['Date', 'Market', 'Income', 'Expenses', 'Actual P&L'],
      events.map(r => [nice(r.date), r.market, usd(r.income), usd(r.expenses), result(r.pnl)]),
      'TOTAL INCOME ' + usd(income) + ' · TOTAL EXPENSES ' + usd(expenses) + ' · ' + netLabel + ' ' + (net < 0 ? '(' + usd(Math.abs(net)) + ')' : usd(net)));
  }
  function buildAR() {
    const rows = arRows(admin());
    const total = rows.reduce((n, r) => n + r.amount, 0);
    printTable('Accounts Receivable', 'Money owed to Trinity Crafters Market', ['Vendor', 'Email', 'Market / Period', 'Amount Due', 'Due Date'],
      rows.map(r => [r.vendor, r.email, r.when, usd(r.amount), r.due]),
      rows.length + ' outstanding · TOTAL DUE ' + usd(total));
  }

  function draw() {
    const a = admin();
    const id = view.eventId;
    const ev = (a.allEvents || []).find(x => x.id === id);
    const bookings = (a.applications || []).filter(b => ['approved', 'held', 'paid'].includes(b.status) && (!id || b.event_id === id));
    const paid = bookings.filter(b => b.status === 'paid');
    const unpaid = bookings.filter(b => ['approved', 'held'].includes(b.status));
    const expRows = (a.expenses || []).filter(x => !id || x.event_id === id || (ev && x.expense_date === String(ev.date).slice(0, 10)));
    const sales = paid.reduce((n, b) => n + Number(b.price || 0), 0);
    const costs = expRows.reduce((n, x) => n + Number(x.amount || 0), 0);
    const rows = paymentRows();
    const payTotal = rows.reduce((n, x) => n + Number(x.invoice_amount || 0), 0);

    root.innerHTML = `
    <p class="eyebrow">Money</p>
    <h2 class="display">Reports</h2>
    <p class="lede">Accounting and receivables reports for the market. Pick a market date to scope the summary and the payment report, or leave it on all dates.</p>
    <label class="picker-label">Market date<select id="v2-rpt-event" class="picker">
      <option value="">All market dates</option>
      ${(a.allEvents || []).map(e => `<option value="${esc(e.id)}" ${String(e.id) === String(id) ? 'selected' : ''}>${esc(nice(e.date))} — ${esc(marketName(e))}</option>`).join('')}
    </select></label>
    <div class="stat-grid">
      <div class="stat"><b>${usd(sales)}</b><span>Paid sales · ${paid.length} paid vendors</span></div>
      <div class="stat"><b>${unpaid.length} unpaid</b><span>Approved or payment held</span></div>
      <div class="stat"><b>${usd(costs)}</b><span>Expenses · ${expRows.length} logged</span></div>
      <div class="stat"><b>${usd(sales - costs)}</b><span>Net after expenses — paid sales less expenses</span></div>
    </div>
    <section class="card">
      <h3 class="section-title first">Financial Reports</h3>
      <p class="note">Accounting and receivables reports for the market — each opens as a clean printable sheet.</p>
      <div class="vendor-actions">
        <button class="btn primary small" id="v2-rpt-pl">Profit &amp; Loss</button>
        <button class="btn small" id="v2-rpt-ar">A/R — Money Owed</button>
      </div>
    </section>
    <section class="card">
      <h3 class="section-title first">Payment Report</h3>
      <p class="note">Reconcile card, cash, PayPal and other payments. GoDaddy receipt numbers are shown when available.</p>
      <div class="filter-row">
        <label class="picker-label">Payment method<select id="v2-rpt-method" class="picker"><option value="">All methods</option><option>GoDaddy Payments</option><option>cash</option><option>PayPal</option><option>check</option><option>monthly billing</option></select></label>
        <label class="picker-label grow">Vendor search<input id="v2-rpt-search" class="picker" type="search" placeholder="Vendor or business" value="${esc(view.q)}"></label>
      </div>
      <div class="vendor-actions">
        <button class="btn primary small" id="v2-rpt-pay-print">Print payment report</button>
        <button class="btn small" id="v2-rpt-pay-csv">Export payment CSV</button>
      </div>
      <p class="note"><strong>${rows.length}</strong> payments · <strong>${usd(payTotal)}</strong> total</p>
      <div class="tbl-wrap"><table class="tbl"><thead><tr><th>Date/time</th><th>Vendor</th><th>Amount</th><th>Method</th><th>Transaction</th><th>Approval</th><th>Card</th><th>Status</th></tr></thead><tbody>
        ${rows.map(x => `<tr><td>${x.paid_at ? esc(new Date(x.paid_at).toLocaleString('en-US', { timeZone: 'America/New_York' })) : '—'}</td><td>${esc(x.business || x.name || '')}</td><td>${usd(x.invoice_amount)}</td><td>${esc(x.payment_method || '')}</td><td>${esc(x.payment_reference || '—')}</td><td>${esc(x.approval_code || '—')}</td><td>${esc(x.card_last4 ? ((x.card_brand || 'Card') + ' •••• ' + x.card_last4) : '—')}</td><td>${esc(x.payment_processor_status || x.payment_status || '')}</td></tr>`).join('') || '<tr><td colspan="8">No payments match these filters.</td></tr>'}
      </tbody></table></div>
    </section>
    <section class="card">
      <h3 class="section-title first">Event reports</h3>
      <p class="note">The per-date vendor list, spaces and the printable attendance sheet live in Attendees — pick the date there. Money for a single date is in the summary above.</p>
      <div class="vendor-actions"><button class="btn small" id="v2-rpt-go-attendees">Open Attendees</button></div>
    </section>`;

    root.querySelector('#v2-rpt-event').onchange = e => { view.eventId = e.target.value; draw(); };
    root.querySelector('#v2-rpt-method').value = view.method;
    root.querySelector('#v2-rpt-method').onchange = e => { view.method = e.target.value; draw(); };
    const search = root.querySelector('#v2-rpt-search');
    search.oninput = () => { view.q = search.value.toLowerCase().trim(); draw(); const s2 = root.querySelector('#v2-rpt-search'); s2.focus(); s2.setSelectionRange(s2.value.length, s2.value.length); };
    root.querySelector('#v2-rpt-pl').onclick = () => { try { buildPL(); } catch (e) { ctx.toast(e.message, true); } };
    root.querySelector('#v2-rpt-ar').onclick = () => { try { buildAR(); } catch (e) { ctx.toast(e.message, true); } };
    root.querySelector('#v2-rpt-go-attendees').onclick = () => ctx.navigate('attendees', view.eventId ? { event: view.eventId } : {});
    root.querySelector('#v2-rpt-pay-print').onclick = () => {
      const list = paymentRows();
      try {
        printTable('Payment Report', 'Payment reconciliation', ['Date/time', 'Vendor', 'Amount', 'Method', 'Transaction', 'Approval', 'Card', 'Status'],
          list.map(x => [x.paid_at ? new Date(x.paid_at).toLocaleString('en-US', { timeZone: 'America/New_York' }) : '', x.business || x.name, usd(x.invoice_amount), x.payment_method || '', x.payment_reference || '', x.approval_code || '', x.card_last4 ? ((x.card_brand || 'Card') + ' •••• ' + x.card_last4) : '', x.payment_processor_status || x.payment_status || '']),
          list.length + ' payments · ' + usd(list.reduce((n, x) => n + Number(x.invoice_amount || 0), 0)) + ' total');
      } catch (e) { ctx.toast(e.message, true); }
    };
    root.querySelector('#v2-rpt-pay-csv').onclick = () => {
      const list = paymentRows();
      const data = [['Date/time', 'Vendor', 'Name', 'Email', 'Amount', 'Method', 'Transaction ID', 'Approval Code', 'Card Brand', 'Last 4', 'Processor Status'],
        ...list.map(x => [x.paid_at || '', x.business || '', x.name || '', x.email || '', (Number(x.invoice_amount || 0) / 100).toFixed(2), x.payment_method || '', x.payment_reference || '', x.approval_code || '', x.card_brand || '', x.card_last4 || '', x.payment_processor_status || x.payment_status || ''])];
      const csv = data.map(r => r.map(v => '"' + String(v ?? '').replaceAll('"', '""') + '"').join(',')).join('\n');
      const link = document.createElement('a');
      link.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
      link.download = 'payment-report.csv';
      link.click();
      URL.revokeObjectURL(link.href);
    };
  }

  draw();
}
