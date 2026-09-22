(() => {
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
  const token = () => sessionStorage.getItem('market-token');
  const notice = (s) => { const n = document.querySelector('#notice'); if (n) n.textContent = s; };
  const severityIcon = (s) => s === 'high' ? '🔴' : s === 'medium' ? '🟠' : '🟡';
  const money = (n) => '$' + (Number(n || 0) / 100).toFixed(2);

  async function request(action, { method = 'GET', body = null, query = {} } = {}) {
    const params = new URLSearchParams({ action, ...query });
    const r = await fetch('/.netlify/functions/system-tools?' + params.toString(), {
      method,
      headers: {
        Authorization: 'Bearer ' + token(),
        ...(body ? { 'Content-Type': 'application/json' } : {})
      },
      body: body ? JSON.stringify(body) : undefined
    });
    const v = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(v.error || 'Request failed.');
    return v;
  }

  function selectTab(tabs, button) {
    tabs.querySelectorAll('button').forEach((x) => x.classList.remove('selected'));
    button.classList.add('selected');
  }

  async function renderHealth(panel, button, tabs) {
    selectTab(tabs, button);
    panel.innerHTML = '<div class="card"><h2>System Health</h2><p>Checking data integrity…</p></div>';
    try {
      const d = await request('dashboard');
      const unsecured = (d.security || []).filter((x) => !x.rls_enabled);
      panel.innerHTML = `
        <section class="card">
          <h2>System Health</h2>
          <div class="stats">
            <div class="card">Needs Attention<strong>${d.attention.length}</strong></div>
            <div class="card">Data Issues<strong>${d.issues.length}</strong></div>
            <div class="card">Security Review<strong>${unsecured.length}</strong></div>
          </div>
          <div class="actions">
            <button id="system-backup">Create Backup Now</button>
            <button id="repair-links" class="secondary">Repair Safe Vendor Links</button>
            <button id="sync-master" class="secondary">Sync Master Vendor Data</button>
          </div>
        </section>
        <section class="card">
          <h3>Needs Attention</h3>
          <div class="list">${d.attention.map((x) => `<div><strong>${severityIcon(x.severity)} ${esc(x.label)}</strong><br><small>${esc(x.detail)}</small></div>`).join('') || '<p>Nothing needs attention right now.</p>'}</div>
        </section>
        <section class="card">
          <h3>Data Integrity</h3>
          <div class="list">${d.issues.map((x) => `<div><strong>${severityIcon(x.severity)} ${esc(x.label)}</strong><br><small>${esc(x.detail)}</small></div>`).join('') || '<p>No integrity issues found.</p>'}</div>
        </section>
        <section class="card">
          <h3>Security</h3>
          <p>${unsecured.length} market table(s) currently have Row Level Security disabled. This is flagged for policy review and has not been switched on automatically because enabling it without matching policies can break the live site.</p>
          <div class="list">${unsecured.map((x) => `<div>${esc(x.table_name)}</div>`).join('') || '<p>All market tables have RLS enabled.</p>'}</div>
        </section>
        <section class="card">
          <h3>Recent Change History</h3>
          <div class="list">${d.history.slice(0, 30).map((x) => `<div><strong>${esc(x.action)}</strong> · ${new Date(x.created_at).toLocaleString()}<br><small>${esc(x.actor)}</small>${x.action === 'master vendor updated' && x.detail?.before ? `<br><button data-undo-vendor="${x.id}">Undo this vendor edit</button>` : ''}</div>`).join('')}</div>
        </section>`;

      panel.querySelector('#system-backup').onclick = async () => {
        try {
          const r = await request('backup', { method: 'POST', body: {} });
          notice('Backup created: ' + r.path);
        } catch (e) { notice(e.message); }
      };
      panel.querySelector('#repair-links').onclick = async () => {
        if (!confirm('Repair only vendor links that have exactly one safe master match?')) return;
        try {
          const r = await request('repair-links', { method: 'POST', body: {} });
          notice(`Repaired ${r.linkedApplications} application links, ${r.linkedImported} imported attendee links, ${r.linkedInvoices || 0} invoice links and ${r.linkedPayments || 0} payment links.`);
          await renderHealth(panel, button, tabs);
        } catch (e) { notice(e.message); }
      };
      panel.querySelector('#sync-master').onclick = async () => {
        if (!confirm('Sync master vendor name, contact information, category and Everything Disclosed to all linked records?')) return;
        try {
          const r = await request('sync-master-data', { method: 'POST', body: {} });
          notice('Master vendor data synchronized across ' + r.updated + ' differing records.');
          await renderHealth(panel, button, tabs);
        } catch (e) { notice(e.message); }
      };
      panel.querySelectorAll('[data-undo-vendor]').forEach((x) => {
        x.onclick = async () => {
          if (!confirm('Undo this vendor edit and restore the previous master vendor information?')) return;
          try {
            await request('undo-vendor', { method: 'POST', body: { audit_id: x.dataset.undoVendor } });
            notice('Vendor edit restored.');
            await renderHealth(panel, button, tabs);
          } catch (e) { notice(e.message); }
        };
      });
    } catch (e) {
      panel.innerHTML = '<div class="card"><h2>System Health</h2><p>' + esc(e.message) + '</p></div>';
    }
  }

  async function renderEventDay(panel, button, tabs, eventId = '') {
    selectTab(tabs, button);
    panel.innerHTML = '<div class="card"><h2>Event Day</h2><p>Loading…</p></div>';
    try {
      const d = await request('event-day', { query: eventId ? { event_id: eventId } : {} });
      panel.innerHTML = `
        <section class="card">
          <h2>Event Day</h2>
          <label>Market<select id="ed-event">${d.events.map((e) => `<option value="${esc(e.id)}" ${e.id === d.event_id ? 'selected' : ''}>${esc(String(e.date).slice(0, 10) + ' — ' + (e.market_name || e.title || e.location))}</option>`).join('')}</select></label>
          <p>Quick mobile view for setup, inspection and attendance.</p>
        </section>
        <div class="list">${d.rows.map((r) => `
          <article class="card">
            <h3>${esc(r.business || r.name)}</h3>
            <p>${esc(r.name)} · ${esc(r.category)} · ${esc(r.space)}</p>
            <p><strong>Phone:</strong> ${esc(r.phone || 'Not provided')}<br>
            <strong>Setup:</strong> ${esc(r.setup_arrival_time || '—')}<br>
            <strong>Inspection:</strong> ${esc(r.inspection_status || 'not inspected')}<br>
            <strong>Attendance:</strong> ${r.checked_in ? 'Checked in' : r.no_show ? 'No show' : 'Not marked'}</p>
            <div class="actions">
              <button data-ed-inspect="${r.id}" data-imported="${r.imported ? '1' : '0'}">Inspection Approved</button>
              <button class="secondary" data-ed-correct="${r.id}" data-imported="${r.imported ? '1' : '0'}">Needs Correction</button>
              <button data-ed-checkin="${r.id}" data-imported="${r.imported ? '1' : '0'}" ${r.inspection_status === 'approved' ? '' : 'disabled'}>Check In</button>
              <button class="secondary" data-ed-no-show="${r.id}" data-imported="${r.imported ? '1' : '0'}">No Show</button>
            </div>
          </article>`).join('') || '<div class="card">No vendors for this event.</div>'}</div>`;

      panel.querySelector('#ed-event').onchange = (e) => renderEventDay(panel, button, tabs, e.target.value);

      const updateAttendance = async (btn, state) => {
        const imported = btn.dataset.imported === '1';
        const id = btn.dataset.edCheckin || btn.dataset.edNoShow;
        const r = await fetch('/.netlify/functions/api?action=' + (imported ? 'imported-attendance' : 'attendance'), {
          method: 'POST',
          headers: { Authorization: 'Bearer ' + token(), 'Content-Type': 'application/json' },
          body: JSON.stringify({ id, state })
        });
        const v = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(v.error || 'Could not update attendance.');
        await renderEventDay(panel, button, tabs, d.event_id);
      };

      const updateInspection = async (btn, status) => {
        let notes = '';
        if (status === 'needs_correction') {
          notes = prompt('What needs correction?') || '';
          if (!notes) return;
        }
        const id = btn.dataset.edInspect || btn.dataset.edCorrect;
        const r = await fetch('/.netlify/functions/api?action=inspection', {
          method: 'POST',
          headers: { Authorization: 'Bearer ' + token(), 'Content-Type': 'application/json' },
          body: JSON.stringify({ id, imported: btn.dataset.imported === '1', status, notes })
        });
        const v = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(v.error || 'Could not update inspection.');
        await renderEventDay(panel, button, tabs, d.event_id);
      };

      panel.querySelectorAll('[data-ed-inspect]').forEach((x) => x.onclick = () => updateInspection(x, 'approved').catch((e) => notice(e.message)));
      panel.querySelectorAll('[data-ed-correct]').forEach((x) => x.onclick = () => updateInspection(x, 'needs_correction').catch((e) => notice(e.message)));
      panel.querySelectorAll('[data-ed-checkin]').forEach((x) => x.onclick = () => updateAttendance(x, 'checked_in').catch((e) => notice(e.message)));
      panel.querySelectorAll('[data-ed-no-show]').forEach((x) => x.onclick = () => updateAttendance(x, 'no_show').catch((e) => notice(e.message)));
    } catch (e) {
      panel.innerHTML = '<div class="card"><h2>Event Day</h2><p>' + esc(e.message) + '</p></div>';
    }
  }

  function printTable(title, headers, rows) {
    const w = window.open('', '_blank');
    if (!w) return alert('Please allow pop-ups.');
    w.document.write(`<!doctype html><html><head><title>${esc(title)}</title><style>body{font:12px Arial;margin:28px}h1{color:#134f45}table{width:100%;border-collapse:collapse}th,td{padding:7px;border-bottom:1px solid #bbb;text-align:left;vertical-align:top}th{background:#134f45;color:#fff}</style></head><body><h1>${esc(title)}</h1><table><thead><tr>${headers.map((h) => '<th>' + esc(h) + '</th>').join('')}</tr></thead><tbody>${rows.map((r) => '<tr>' + r.map((v) => '<td>' + esc(v) + '</td>').join('') + '</tr>').join('')}</tbody></table><script>onload=()=>print()<\/script></body></html>`);
    w.document.close();
  }

  function exportCsv(filename, headers, rows) {
    const csv = [headers, ...rows].map((r) => r.map((v) => '"' + String(v ?? '').replaceAll('"', '""') + '"').join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 500);
  }

  async function renderReports(panel, button, tabs) {
    selectTab(tabs, button);
    panel.innerHTML = '<div class="card"><h2>Reports Center</h2><p>Loading…</p></div>';
    try {
      const d = await request('reports');
      const vendorRows = d.vendors.map((x) => [x.account_number, x.business, x.name, x.category || '', x.email, x.phone, x.description]);
      const invoiceRows = d.invoices.map((x) => [x.business || x.vendor_name, x.billing_period, (Number(x.amount || 0) / 100).toFixed(2), x.status, x.due_date || '', x.payment_method || '']);
      const paymentRows = d.payments.map((x) => [x.paid_at ? new Date(x.paid_at).toISOString() : '', x.business || x.name, (Number(x.amount || 0) / 100).toFixed(2), x.payment_method, x.note || '']);
      const waitRows = d.waitlist.map((x) => [String(x.date).slice(0, 10), x.business || x.name, x.email, x.phone, x.category, x.space]);
      const categoryRows = d.categories.map((x) => [x.name, x.bookings]);
      const revenueRows = d.revenue.map((x) => {
        const gross = Number(x.booking_revenue || 0) + Number(x.imported_revenue || 0);
        const net = gross - Number(x.expenses || 0);
        return [String(x.date).slice(0, 10), x.market_name, (Number(x.booking_revenue || 0) / 100).toFixed(2), (Number(x.imported_revenue || 0) / 100).toFixed(2), (Number(x.expenses || 0) / 100).toFixed(2), (net / 100).toFixed(2)];
      });

      panel.innerHTML = `
        <section class="card">
          <h2>Reports Center</h2>
          <p>All reports use the same live database records.</p>
          <div class="actions">
            <button id="r-vendors">Vendor Contact List</button>
            <button id="r-invoices">Monthly Billing</button>
            <button id="r-payments">Payments</button>
            <button id="r-waitlist">Wait List</button>
            <button id="r-categories">Category Summary</button>
            <button id="r-revenue">Event Revenue</button>
          </div>
          <div class="actions">
            <button class="secondary" id="c-vendors">Vendor CSV</button>
            <button class="secondary" id="c-invoices">Billing CSV</button>
            <button class="secondary" id="c-payments">Payments CSV</button>
            <button class="secondary" id="c-waitlist">Wait List CSV</button>
            <button class="secondary" id="c-categories">Categories CSV</button>
            <button class="secondary" id="c-revenue">Revenue CSV</button>
          </div>
        </section>`;

      panel.querySelector('#r-vendors').onclick = () => printTable('Vendor Contact List', ['Account','Business','Name','Category','Email','Phone','Everything Disclosed'], vendorRows);
      panel.querySelector('#r-invoices').onclick = () => printTable('Monthly Billing', ['Vendor','Period','Amount','Status','Due','Method'], invoiceRows.map((r) => [r[0], r[1], '$' + r[2], r[3], r[4], r[5]]));
      panel.querySelector('#r-payments').onclick = () => printTable('Payments', ['Date','Vendor','Amount','Method','Note'], paymentRows.map((r) => [r[0] ? new Date(r[0]).toLocaleString() : '', r[1], '$' + r[2], r[3], r[4]]));
      panel.querySelector('#r-waitlist').onclick = () => printTable('Wait List', ['Date','Vendor','Email','Phone','Category','Space'], waitRows);
      panel.querySelector('#r-categories').onclick = () => printTable('Category Summary', ['Category','Confirmed bookings'], categoryRows);
      panel.querySelector('#r-revenue').onclick = () => printTable('Event Revenue', ['Date','Market','Booking Revenue','Imported Revenue','Expenses','Net'], revenueRows.map((r) => [r[0], r[1], '$' + r[2], '$' + r[3], '$' + r[4], '$' + r[5]]));

      panel.querySelector('#c-vendors').onclick = () => exportCsv('vendor-contacts.csv', ['Account','Business','Name','Category','Email','Phone','Everything Disclosed'], vendorRows);
      panel.querySelector('#c-invoices').onclick = () => exportCsv('monthly-billing.csv', ['Vendor','Period','Amount','Status','Due','Method'], invoiceRows);
      panel.querySelector('#c-payments').onclick = () => exportCsv('payments.csv', ['Date','Vendor','Amount','Method','Note'], paymentRows);
      panel.querySelector('#c-waitlist').onclick = () => exportCsv('wait-list.csv', ['Date','Vendor','Email','Phone','Category','Space'], waitRows);
      panel.querySelector('#c-categories').onclick = () => exportCsv('category-summary.csv', ['Category','Confirmed bookings'], categoryRows);
      panel.querySelector('#c-revenue').onclick = () => exportCsv('event-revenue.csv', ['Date','Market','Booking Revenue','Imported Revenue','Expenses','Net'], revenueRows);
    } catch (e) {
      panel.innerHTML = '<div class="card"><h2>Reports Center</h2><p>' + esc(e.message) + '</p></div>';
    }
  }

  function install() {
    if (location.hash !== '#admin') return;
    const tabs = document.querySelector('.tabs');
    const panel = document.querySelector('#panel');
    if (!tabs || !panel) return;

    if (!tabs.querySelector('[data-system-health]')) {
      const h = document.createElement('button');
      h.textContent = 'System Health';
      h.dataset.systemHealth = '1';
      h.onclick = () => renderHealth(panel, h, tabs);
      tabs.appendChild(h);

      const e = document.createElement('button');
      e.textContent = 'Event Day';
      e.dataset.eventDay = '1';
      e.onclick = () => renderEventDay(panel, e, tabs);
      tabs.appendChild(e);

      const r = document.createElement('button');
      r.textContent = 'Reports Center';
      r.dataset.reportsCenter = '1';
      r.onclick = () => renderReports(panel, r, tabs);
      tabs.appendChild(r);
    }
  }

  new MutationObserver(install).observe(document.body, { childList: true, subtree: true });
  addEventListener('hashchange', () => setTimeout(install, 100));
  install();
})();
