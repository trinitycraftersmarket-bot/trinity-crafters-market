// Online Check-In (organizer view): which vendors have picked a setup
// arrival time for each market date, and a reminder for those who have
// not. Native v2 port of the classic Online Check-In admin tab
// (setup-checkin.js): same setup-checkin function (GET ?admin=1 lists
// every upcoming booking with its check-in state; POST action 'remind'
// emails the vendor), same arrival slots (8:15 / 8:30 / 8:45 / 9:00 AM),
// same 24-hour close. The vendor side of check-in already lives in the
// v2 vendor portal (vendor.js); this is the organizer side.
import { esc, getToken, nice } from './api.js?v=20261023-17';

const timeLabel = t => ({ '08:15': '8:15 AM', '08:30': '8:30 AM', '08:45': '8:45 AM', '09:00': '9:00 AM' }[String(t || '').slice(0, 5)] || 'Not selected');

async function scCall(payload) {
  const r = await fetch('/.netlify/functions/setup-checkin?admin=1', {
    method: payload ? 'POST' : 'GET',
    headers: { Authorization: 'Bearer ' + getToken(), ...(payload ? { 'Content-Type': 'application/json' } : {}) },
    body: payload ? JSON.stringify(payload) : undefined
  });
  const v = await r.json().catch(() => ({}));
  if (!r.ok) throw Error(v.error || 'Could not load setup check-in.');
  return v;
}

export function renderCheckin(ctx, root) {
  root.innerHTML = `
    <p class="eyebrow">Market Day</p>
    <h2 class="display">Online Check-In</h2>
    <p class="lede">Vendors choose an arrival time of 8:15, 8:30, 8:45, or 9:00 AM. Check-in closes automatically 24 hours before each market.</p>
    <div id="v2-ci-slot"><div class="card empty-card">Loading vendor responses…</div></div>`;

  const slot = root.querySelector('#v2-ci-slot');
  let rows = [], eventId = '';

  const load = async () => {
    const d = await scCall(null);
    rows = d.rows || [];
    if (!rows.some(r => String(r.event_id) === eventId)) eventId = rows.length ? String(rows[0].event_id) : '';
    draw();
  };

  function remindSheet(r, btn) {
    ctx.openSheet(`
      <h3 class="sheet-title">Send check-in reminder</h3>
      <p>Send <strong>${esc(r.business || r.name || 'this vendor')}</strong> an email reminder to complete online setup check-in?</p>
      <div class="sheet-actions"><button class="btn" data-sheet-close>Cancel</button><button class="btn primary" id="v2-ci-send">Send reminder</button></div>`);
    ctx.sheetEl.querySelector('#v2-ci-send').onclick = async () => {
      ctx.closeSheet();
      btn.disabled = true;
      btn.textContent = 'Sending…';
      try {
        const v = await scCall({ action: 'remind', source: r.source || 'booking', record_id: r.record_id });
        btn.textContent = 'Reminder Sent ✓';
        ctx.toast('Online check-in reminder sent to ' + (v.recipient || r.email || 'the vendor') + '.');
      } catch (e) {
        btn.disabled = false;
        btn.textContent = 'Send Check-In Reminder';
        ctx.toast(e.message, true);
      }
    };
  }

  function draw() {
    const dates = [...new Map(rows.map(r => [String(r.event_id), r])).values()];
    if (!dates.length) {
      slot.innerHTML = '<div class="card empty-card">No upcoming vendor bookings found.</div>';
      return;
    }
    const selected = rows.filter(r => String(r.event_id) === eventId);
    const checked = selected.filter(r => r.setup_arrival_time).length;
    slot.innerHTML = `
      <label class="picker-label">Market date<select id="v2-ci-date" class="picker">${dates.map(r => `<option value="${esc(r.event_id)}" ${String(r.event_id) === eventId ? 'selected' : ''}>${esc(nice(r.date))} — ${esc(r.market_name || r.title || 'Crafters Market')}</option>`).join('')}</select></label>
      <p class="note"><strong>${checked} of ${selected.length}</strong> vendors checked in online.</p>
      <div class="vendor-list">${selected.map(r => `
        <article class="card vendor">
          <div class="vendor-top">
            <div><h3>${esc(r.business || r.name || '')}</h3>
            <div class="contact">${esc(r.name || '')} · ${esc(r.email || '')}<br>${esc(r.space || '')} · ${esc(r.status || '')}</div></div>
            <span class="status ${r.setup_arrival_time ? 'ok' : 'warn'}">${r.setup_arrival_time ? esc(timeLabel(r.setup_arrival_time)) : 'Not checked in'}</span>
          </div>
          ${r.setup_checkin_at ? `<p class="note">Submitted ${esc(new Date(r.setup_checkin_at).toLocaleString('en-US', { timeZone: 'America/New_York' }))}</p>` : ''}
          ${!r.setup_arrival_time && r.checkin_open ? `<div class="vendor-actions"><button class="btn small" data-remind="${esc(r.record_id)}" ${r.email ? '' : 'disabled title="No email address is available for this vendor."'}>Send Check-In Reminder</button></div>` : ''}
        </article>`).join('') || '<div class="card empty-card">No vendors for this date.</div>'}
      </div>`;
    slot.querySelector('#v2-ci-date').onchange = e => { eventId = e.target.value; draw(); };
    slot.querySelectorAll('[data-remind]').forEach(btn => btn.onclick = () => {
      const r = selected.find(x => String(x.record_id) === btn.dataset.remind);
      if (r) remindSheet(r, btn);
    });
  }

  load().catch(e => {
    slot.innerHTML = `<div class="card empty-card"><p><strong>Online Check-In couldn't load.</strong></p><p class="muted">${esc(e.message)}</p></div>`;
  });
}
