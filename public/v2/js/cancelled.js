// Cancelled Vendors: every cancelled booking / imported record with its
// reason, who cancelled it, and its preserved payment status — plus
// reinstatement for future dates. Native v2 port of the classic Cancelled
// Vendors panel: rows are shaped from the admin payload exactly as the
// classic panel shapes them (cancelled bookings + cancelled imports), and
// reinstatement goes through the same 'reinstate-cancelled' action, whose
// server side re-verifies capacity, category, duplicates and ban status
// before restoring the record and emailing the vendor.
import { api, esc, nice, todayKey } from './api.js?v=20261024-25';

let view = { q: '', date: '', period: 'all' };

export function cancelledRows(admin) {
  const events = admin.allEvents || [];
  const eventById = new Map(events.map(e => [String(e.id), e]));
  const locById = new Map((admin.locations || []).map(l => [String(l.id), l]));
  const online = (admin.applications || []).filter(x => x.status === 'cancelled').map(x => ({
    ...x, imported: false,
    date: String(x.date || '').slice(0, 10),
    cancelled_at: x.cancelled_at || null, cancelled_by: x.cancelled_by || '',
    reason: x.cancellation_reason || 'No reason recorded',
    payment_status: x.paid_at ? 'paid' : 'unpaid'
  }));
  const imported = (admin.importedAttendees || []).filter(x => x.cancelled).map(x => {
    const event = eventById.get(String(x.event_id));
    return {
      ...x, imported: true,
      date: String(event?.date || x.date || '').slice(0, 10),
      location: locById.get(String(event?.location_id))?.name || '',
      reason: x.cancellation_reason || 'No reason recorded',
      payment_status: x.payment_status || 'unpaid'
    };
  });
  return [...online, ...imported].sort((x, y) =>
    String(y.cancelled_at || '').localeCompare(String(x.cancelled_at || '')) || String(y.date || '').localeCompare(String(x.date || '')));
}

export function renderCancelled(ctx, root) {
  const today = todayKey();
  const all = cancelledRows(ctx.state.admin);
  const upcoming = all.filter(x => x.date >= today).length;
  const paid = all.filter(x => String(x.payment_status || '').toLowerCase() === 'paid').length;
  const dateOptions = [...new Set(all.map(x => x.date).filter(Boolean))].sort();

  root.innerHTML = `
    <p class="eyebrow">Vendors</p>
    <h2 class="display">Cancelled Vendors</h2>
    <p class="lede">Search cancelled vendor records, review the cancellation reason and who cancelled them, or reinstate an available future market date.</p>
    <div class="stat-grid">
      <div class="stat"><b>${all.length} cancelled</b><span>Total records</span></div>
      <div class="stat"><b>${upcoming} future dates</b><span>Eligible to reinstate if space is available</span></div>
      <div class="stat"><b>${paid} previously paid</b><span>Payment status is preserved</span></div>
    </div>
    <div class="card filter-card">
      <div class="search"><input id="v2-cx-search" type="search" placeholder="Vendor, business, email, phone or reason" autocomplete="off" value="${esc(view.q)}"></div>
      <div class="filter-row">
        <label class="picker-label">Market date<select id="v2-cx-date" class="picker"><option value="">All market dates</option>${dateOptions.map(d => `<option value="${esc(d)}">${esc(nice(d))}</option>`).join('')}</select></label>
        <label class="picker-label">Show<select id="v2-cx-period" class="picker"><option value="all">All cancelled vendors</option><option value="future">Future market dates</option><option value="past">Past market dates</option></select></label>
      </div>
    </div>
    <div id="v2-cx-list"></div>`;

  const findRow = (id, imported) => all.find(r => String(r.id) === String(id) && r.imported === imported);
  const mutate = async (call, okMsg) => {
    try {
      await call();
      await ctx.refreshAdmin();
      draw();
      if (okMsg) ctx.toast(okMsg);
    } catch (e) { ctx.toast(e.message, true); }
  };

  function reinstateSheet(x) {
    const name = x.business || x.name || 'this vendor';
    ctx.openSheet(`
      <h3 class="sheet-title">Reinstate vendor</h3>
      <p><strong>${esc(name)}</strong> · ${x.date ? esc(nice(x.date)) : 'Unknown date'}</p>
      <p class="note">Reinstate ${esc(name)} for ${x.date ? esc(nice(x.date)) : 'this market date'}?<br><br>The system will verify booth capacity, category availability, duplicate bookings and ban status first. Their previous payment status will be preserved and a reinstatement email will be sent.</p>
      <div class="sheet-actions"><button class="btn" data-sheet-close>Cancel</button><button class="btn primary" id="v2-cx-reinstate-go">Reinstate vendor</button></div>`);
    ctx.sheetEl.querySelector('#v2-cx-reinstate-go').onclick = () => {
      ctx.closeSheet();
      mutate(async () => {
        const r = await api('reinstate-cancelled', { id: x.id, imported: x.imported });
        ctx.toast(name + ' reinstated' + (r.status === 'paid' ? ' as paid.' : '.'));
      }, null);
    };
  }

  function cardHtml(x) {
    const future = x.date >= today;
    const isPaid = String(x.payment_status || '').toLowerCase() === 'paid';
    return `<article class="card vendor">
      <div class="vendor-top">
        <div><h3>${esc(x.business || x.name || 'Vendor')}</h3>
        <div class="contact">${esc(x.name || '')}${x.email ? ' · ' + esc(String(x.email).replace(/,+\s*$/, '').trim()) : ''}${x.phone ? ' · ' + esc(x.phone) : ''}</div></div>
        <span class="status bad">CANCELLED</span>
      </div>
      <p class="note"><strong>Booking ID:</strong> ${esc(x.id || '—')}<br><strong>Market:</strong> ${x.date ? esc(nice(x.date)) : 'Unknown date'}${x.location ? ' · ' + esc(x.location) : ''}<br><strong>Space:</strong> ${esc(x.space || 'Not listed')} · <strong>Category:</strong> ${esc(x.category || 'Not listed')}</p>
      <p class="note"><strong>Payment:</strong> ${isPaid ? 'Paid ✓' : 'Not recorded'}<br><strong>Cancelled:</strong> ${x.cancelled_at ? esc(new Date(x.cancelled_at).toLocaleString('en-US', { timeZone: 'America/New_York' })) : 'Date not recorded'}<br><strong>Cancelled by:</strong> ${esc(x.cancelled_by || 'Not recorded')}</p>
      <p class="note"><strong>Cancellation reason</strong><br>${esc(x.reason)}</p>
      <div class="vendor-actions">
        ${future ? `<button class="btn primary small" data-reinstate="${esc(x.id)}" data-imported="${x.imported ? '1' : '0'}">Reinstate Vendor</button>` : '<span class="status neutral">Past market date</span>'}
      </div>
    </article>`;
  }

  function draw() {
    let rows = all.filter(x => {
      const hay = [x.business, x.name, x.email, x.phone, x.reason, x.cancelled_by, x.category, x.space].join(' ').toLowerCase();
      if (view.q && !hay.includes(view.q)) return false;
      if (view.date && x.date !== view.date) return false;
      if (view.period === 'future' && x.date < today) return false;
      if (view.period === 'past' && x.date >= today) return false;
      return true;
    });
    const listEl = root.querySelector('#v2-cx-list');
    listEl.innerHTML = `<div class="vendor-list">${rows.map(cardHtml).join('') || '<div class="card empty-card">No cancelled vendors match these filters.</div>'}</div>
      <p class="note">${rows.length} cancelled vendor${rows.length === 1 ? '' : 's'} shown.</p>`;
    listEl.querySelectorAll('[data-reinstate]').forEach(btn => btn.onclick = () => {
      const x = findRow(btn.dataset.reinstate, btn.dataset.imported === '1');
      if (!x) { ctx.toast('That record is no longer in the list — reloading.', true); ctx.refreshAdmin().then(draw); return; }
      reinstateSheet(x);
    });
    root.querySelector('#v2-cx-date').value = view.date;
    root.querySelector('#v2-cx-period').value = view.period;
  }

  root.querySelector('#v2-cx-search').oninput = e => { view.q = e.target.value.trim().toLowerCase(); draw(); };
  root.querySelector('#v2-cx-date').onchange = e => { view.date = e.target.value; draw(); };
  root.querySelector('#v2-cx-period').onchange = e => { view.period = e.target.value; draw(); };
  draw();
}
