// Monthly Billing: vendor monthly invoices — add bills, track balances,
// edit charges, mark GoDaddy invoices sent, print and email. Native v2
// port of the classic Monthly Billing panel (organizer-tools): same
// monthly-invoices function, same actions (list / add-bill / update /
// cancel / edit-item / email / godaddy-sent / print), same due math
// (amount − discount + late fee; cancelled invoices are due $0). The
// classic filters only show/hide invoice cards — here they re-render
// just the list, so the Add Bill form is never disturbed.
import { api, esc, getToken, nice } from './api.js?v=20261023-19';

const usd = n => '$' + (Number(n || 0) / 100).toFixed(2);
const monthLabel = m => new Date(m + '-01T12:00:00').toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
const dueOf = i => i.status === 'cancelled' ? 0 : Math.max(0, Number(i.amount || 0) - Number(i.discount || 0) + Number(i.late_fee || 0));

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
        <span class="status ${i.status === 'paid' ? 'ok' : i.status === 'cancelled' ? 'bad' : 'warn'}">${esc(i.status || 'draft')}</span>
      </div>
      <p class="note">Subtotal: ${usd(i.amount)} · Discount: ${usd(i.discount || 0)} · <strong>Due: ${usd(dueOf(i))}</strong></p>
      <label class="sheet-field">Discount ($)<input type="number" min="0" step="0.01" data-f="discount" value="${esc(fVal('discount', (Number(i.discount || 0) / 100).toFixed(2)))}"></label>
      <label class="sheet-field">Comments<textarea data-f="comment" rows="2">${esc(fVal('comment', i.payment_comment || ''))}</textarea></label>
      <label class="sheet-field">Status<select data-f="status">
        ${[['draft', 'Draft / Unpaid'], ['emailed', 'Emailed / Outstanding'], ['paid', 'Paid'], ['cancelled', 'Cancelled']].map(([v, t]) => `<option value="${v}" ${fVal('status', i.status || 'draft') === v ? 'selected' : ''}>${t}</option>`).join('')}
      </select></label>
      <label class="sheet-field">Payment method<select data-f="method">
        <option value="">Choose method</option>
        ${['Cash', 'Credit Card', 'GoDaddy Invoice'].map(m => `<option ${fVal('method', i.payment_method || '') === m ? 'selected' : ''}>${m}</option>`).join('')}
      </select></label>
      <p class="note"><strong>GoDaddy invoice:</strong> ${i.godaddy_invoice_sent_count ? 'Sent ' + i.godaddy_invoice_sent_count + ' time' + (i.godaddy_invoice_sent_count === 1 ? '' : 's') + ' · First ' + esc(new Date(i.godaddy_invoice_first_sent_at).toLocaleString('en-US', { timeZone: 'America/New_York' })) + ' · Last ' + esc(new Date(i.godaddy_invoice_last_sent_at).toLocaleString('en-US', { timeZone: 'America/New_York' })) : 'Not marked sent yet'}</p>
      ${i.status === 'cancelled' && i.cancel_reason ? `<p class="note"><strong>Cancellation:</strong> ${esc(i.cancel_reason)}</p>` : ''}
      <div class="vendor-actions">
        <button class="btn primary small" data-bill-act="save">Save Changes</button>
        <button class="btn small" data-bill-act="godaddy">Mark GoDaddy Invoice Sent</button>
        <button class="btn small" data-bill-act="edit">Edit Charges</button>
        <button class="btn small" data-bill-act="print">Print</button>
        <button class="btn small" data-bill-act="email">Email</button>
        ${i.status !== 'paid' && i.status !== 'cancelled' ? '<button class="btn small ghost" data-bill-act="cancel">Cancel Invoice</button>' : ''}
      </div>
    </article>`;
  }

  function editChargesSheet(i) {
    const items = i.items || [];
    ctx.openSheet(`
      <h3 class="sheet-title">Edit charges</h3>
      <p><strong>${esc(i.business || i.vendor_name || 'Vendor')}</strong> · ${esc(i.billing_period || '')}</p>
      ${items.map((it, n) => `
        <div class="bill-item-edit">
          <label class="sheet-field">Charge ${n + 1} — description<input data-item-desc="${n}" value="${esc(it.description || it.space || 'Charge')}"></label>
          <label class="sheet-field">Amount ($)<input data-item-amount="${n}" type="number" min="0" step="0.01" value="${(Number(it.amount || 0) / 100).toFixed(2)}"></label>
          <div class="vendor-actions"><button class="btn small" data-item-save="${n}">Save charge ${n + 1}</button></div>
        </div>`).join('') || '<p class="note">This invoice has no charge lines.</p>'}
      <div class="sheet-actions"><button class="btn" data-sheet-close>Done</button></div>`);
    ctx.sheetEl.querySelectorAll('[data-item-save]').forEach(btn => btn.onclick = () => {
      const n = btn.dataset.itemSave;
      const description = ctx.sheetEl.querySelector('[data-item-desc="' + n + '"]').value;
      const amount = ctx.sheetEl.querySelector('[data-item-amount="' + n + '"]').value;
      ctx.closeSheet();
      mutate(() => miCall('edit-item', { id: i.id, index: Number(n), description, amount }), 'Invoice charge updated.');
    });
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
        else if (act === 'edit') editChargesSheet(inv);
        else if (act === 'print') window.open(printUrl(inv.id), '_blank');
        else if (act === 'email') mutate(() => miCall('email', { id: inv.id }), 'Invoice emailed.');
        else if (act === 'cancel') cancelSheet(inv);
      });
    });
  }

  function drawShell() {
    const periods = [...new Set(invoices.map(i => String(i.billing_period || '')).filter(Boolean))].sort().reverse();
    slot.innerHTML = `
      ${addBillCard()}
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
    slot.querySelector('#v2-bill-fmonth').onchange = e => { view.month = e.target.value; drawList(); };
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
    drawList();
  }

  load().catch(e => {
    slot.innerHTML = `<div class="card empty-card"><p><strong>Monthly Billing couldn't load.</strong></p><p class="muted">${esc(e.message)}</p></div>`;
  });
}
