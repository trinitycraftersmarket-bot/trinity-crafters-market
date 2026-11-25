// Online Check-In (organizer view): which vendors have picked a setup
// arrival time for each market date, and a reminder for those who have
// not. Native v2 port of the classic Online Check-In admin tab
// (setup-checkin.js): same setup-checkin function (GET ?admin=1 lists
// every upcoming booking with its check-in state; POST action 'remind'
// emails the vendor), same arrival slots (8:15 / 8:30 / 8:45 / 9:00 AM),
// same 24-hour close. The vendor side of check-in already lives in the
// v2 vendor portal (vendor.js); this is the organizer side.
import { esc, getToken, nice } from './api.js?v=20261125-107';

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
  let proofCache = { eventId: '', vendors: null };
  let proofEmail = '';

  const fmtWhen = v => v ? new Date(v).toLocaleString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—';

  async function drawProof() {
    const pslot = slot.querySelector('#v2-ci-proof-slot');
    if (!pslot) return;
    if (!proofEmail) { pslot.innerHTML = ''; return; }
    const match = rows.find(r => String(r.event_id) === eventId && String(r.email || '').toLowerCase() === proofEmail);
    if (!match) { pslot.innerHTML = '<p class="note">That vendor is not on this market date.</p>'; return; }
    if (!proofCache.vendors || proofCache.eventId !== eventId) {
      pslot.innerHTML = '<p class="note">Loading email history…</p>';
      try {
        const rep = await scCall({ action: 'email-report', event_id: eventId });
        proofCache = { eventId, vendors: rep.vendors || [] };
      } catch (e) { pslot.innerHTML = `<p class="note">${esc(e.message)}</p>`; return; }
    }
    const v = (proofCache.vendors || []).find(x => String(x.email || '').toLowerCase() === proofEmail);
    if (!v) { pslot.innerHTML = '<p class="note">No email history found for this vendor.</p>'; return; }
    pslot.innerHTML = `
      <p><strong>${esc(v.business || v.name || '')}</strong> · ${esc(v.email || '')}</p>
      <p class="note">Emailed <strong>${v.sends.length} time${v.sends.length === 1 ? '' : 's'}</strong> to the address on file.</p>
      ${match.record_id ? `<div class="vendor-actions"><button type="button" class="btn small" id="v2-ci-resend-setup">↻ Resend setup email</button></div>` : ''}
      ${v.sends.length ? `<div class="vendor-list">${v.sends.map(snd => `
        <article class="card vendor">
          <div class="contact">${esc(fmtWhen(snd.sent_at || snd.created_at))}</div>
          <div><strong>${esc(snd.error ? 'FAILED TO SEND — ' + (snd.subject || '') : (snd.subject || ''))}</strong></div>
          ${snd.error ? `<div class="contact">Reason: ${esc(snd.error)}</div>` : ''}
          <div class="contact">${snd.opened_at ? 'Opened ✓ ' + esc(fmtWhen(snd.opened_at)) + (Number(snd.open_count) > 1 ? ' · ' + snd.open_count + ' opens' : '') : 'Not opened'}</div>
        </article>`).join('')}</div>` : '<p class="note">No emails sent to this vendor yet.</p>'}`;
    const rsBtn = pslot.querySelector('#v2-ci-resend-setup');
    if (rsBtn) rsBtn.onclick = async () => {
      rsBtn.disabled = true;
      try {
        await scCall({ action: 'resend-setup', record_id: match.record_id, source: match.source });
        ctx.toast('Setup email resent to ' + (v.business || v.name || v.email) + '.');
        proofCache = { eventId: '', vendors: null };
        drawProof();
      } catch (e) { ctx.toast(e.message, true); rsBtn.disabled = false; }
    };
  }

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

  function remindAllSheet(count, btn) {
    const sel = rows.find(r => String(r.event_id) === eventId);
    ctx.openSheet(`
      <h3 class="sheet-title">Remind all not checked in</h3>
      <p>Email the online check-in reminder to <strong>${count} vendor${count === 1 ? '' : 's'}</strong> who ${count === 1 ? 'has' : 'have'} not checked in for <strong>${esc(nice(sel ? sel.date : ''))} — ${esc(sel ? (sel.market_name || sel.title || 'Crafters Market') : '')}</strong>?</p>
      <p>Subject: <strong>Online check-in required, final plan sent Friday</strong></p>
      <div class="sheet-actions"><button class="btn" data-sheet-close>Cancel</button><button class="btn primary" id="v2-ci-send-all">Send to all ${count}</button></div>`);
    ctx.sheetEl.querySelector('#v2-ci-send-all').onclick = async () => {
      ctx.closeSheet();
      btn.disabled = true;
      btn.textContent = 'Sending…';
      try {
        const v = await scCall({ action: 'remind-all', event_id: eventId });
        btn.textContent = 'Reminders Sent ✓';
        ctx.toast('Online check-in reminder sent to ' + v.count + ' vendor(s).');
      } catch (e) {
        btn.disabled = false;
        btn.textContent = 'Remind All Not Checked In (' + count + ')';
        ctx.toast(e.message, true);
      }
    };
  }

  function tablesSheet(count, btn) {
    const sel = rows.find(r => String(r.event_id) === eventId);
    ctx.openSheet(`
      <h3 class="sheet-title">Ask for table counts</h3>
      <p>Email <strong>${count} checked-in vendor${count === 1 ? '' : 's'}</strong> for <strong>${esc(nice(sel ? sel.date : ''))} — ${esc(sel ? (sel.market_name || sel.title || 'Crafters Market') : '')}</strong> who ${count === 1 ? 'has' : 'have'} not told us how many tables they are bringing, and ask them to add it (1 or 2)?</p>
      <p>Subject: <strong>Quick update needed: how many tables are you bringing?</strong></p>
      <div class="sheet-actions"><button class="btn" data-sheet-close>Cancel</button><button class="btn primary" id="v2-ci-send-tables">Send to ${count}</button></div>`);
    ctx.sheetEl.querySelector('#v2-ci-send-tables').onclick = async () => {
      ctx.closeSheet();
      btn.disabled = true;
      btn.textContent = 'Sending…';
      try {
        const v = await scCall({ action: 'remind-tables', event_id: eventId });
        btn.textContent = 'Requests Sent ✓';
        ctx.toast('Table count request sent to ' + v.count + ' vendor(s).');
      } catch (e) {
        btn.disabled = false;
        btn.textContent = 'Email Checked-In Vendors Missing Table Count (' + count + ')';
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
    const pending = selected.filter(r => !r.setup_arrival_time && r.checkin_open);
    const missingTables = selected.filter(r => (r.setup_checkin_at || r.setup_arrival_time) && !r.setup_tables && !/out/i.test(String(r.space || '')));
    slot.innerHTML = `
      <label class="picker-label">Market date<select id="v2-ci-date" class="picker">${dates.map(r => `<option value="${esc(r.event_id)}" ${String(r.event_id) === eventId ? 'selected' : ''}>${esc(nice(r.date))} — ${esc(r.market_name || r.title || 'Crafters Market')}</option>`).join('')}</select></label>
      <p class="note"><strong>${checked} of ${selected.length}</strong> vendors checked in online.</p>
      ${pending.length ? `<div class="vendor-actions"><button class="btn primary" id="v2-ci-remind-all">Remind All Not Checked In (${pending.length})</button></div>` : ''}
      ${missingTables.length ? `<div class="vendor-actions"><button class="btn" id="v2-ci-remind-tables">Email Checked-In Vendors Missing Table Count (${missingTables.length})</button></div>` : ''}
      <div class="vendor-list">${selected.map(r => `
        <article class="card vendor">
          <div class="vendor-top">
            <div><h3>${esc(r.business || r.name || '')}</h3>
            <div class="contact">${esc(r.name || '')} · ${esc(r.email || '')}<br>${esc(r.space || '')} · ${esc(r.status || '')}</div>${r.products ? `<div class="contact">Sells: ${esc(r.products)}</div>` : ''}</div>
            <span class="status ${r.setup_arrival_time ? 'ok' : 'warn'}">${r.setup_arrival_time ? esc(timeLabel(r.setup_arrival_time)) : 'Not checked in'}</span>
          </div>
          ${r.setup_checkin_at ? `<p class="note">Submitted ${esc(new Date(r.setup_checkin_at).toLocaleString('en-US', { timeZone: 'America/New_York' }))}</p>` : ''}
          ${r.setup_tables ? `<p class="note">Bringing <strong>${esc(r.setup_tables)} table${Number(r.setup_tables) === 1 ? '' : 's'}</strong></p>` : ''}
          ${r.email ? `<div class="vendor-actions">${!r.setup_arrival_time && r.checkin_open ? `<button class="btn small" data-remind="${esc(r.record_id)}">Send Check-In Reminder</button>` : ''}<button class="btn small" data-resend-setup="${esc(r.record_id)}" data-source="${esc(r.source || 'booking')}">↻ Resend setup email</button></div>` : ''}
        </article>`).join('') || '<div class="card empty-card">No vendors for this date.</div>'}
      </div>
      <section class="card" style="margin-top:14px">
        <h3>📧 Email Proof</h3>
        <p class="note">Pick a vendor on this date to see every email sent to the address on file — and whether they opened it. Same proof as the printout, without the paper.</p>
        <label class="picker-label">Vendor<select id="v2-ci-proof-vendor" class="picker">
          <option value="">Choose a vendor…</option>
          ${[...new Map(selected.filter(r => r.email).map(r => [String(r.email).toLowerCase(), r])).values()].map(r => `<option value="${esc(String(r.email).toLowerCase())}" ${String(r.email).toLowerCase() === proofEmail ? 'selected' : ''}>${esc(r.business || r.name || '')}</option>`).join('')}
        </select></label>
        <div id="v2-ci-proof-slot"></div>
      </section>`;
    slot.querySelector('#v2-ci-date').onchange = e => { eventId = e.target.value; proofEmail = ''; draw(); };
    const proofSel = slot.querySelector('#v2-ci-proof-vendor');
    if (proofSel) proofSel.onchange = e => { proofEmail = e.target.value; drawProof(); };
    if (proofEmail) drawProof();
    const allBtn = slot.querySelector('#v2-ci-remind-all');
    if (allBtn) allBtn.onclick = () => remindAllSheet(pending.length, allBtn);
    const tablesBtn = slot.querySelector('#v2-ci-remind-tables');
    if (tablesBtn) tablesBtn.onclick = () => tablesSheet(missingTables.length, tablesBtn);
    slot.querySelectorAll('[data-remind]').forEach(btn => btn.onclick = () => {
      const r = selected.find(x => String(x.record_id) === btn.dataset.remind);
      if (r) remindSheet(r, btn);
    });
    slot.querySelectorAll('[data-resend-setup]').forEach(btn => btn.onclick = async () => {
      const r = selected.find(x => String(x.record_id) === btn.dataset.resendSetup);
      if (!r) return;
      btn.disabled = true;
      try {
        await scCall({ action: 'resend-setup', record_id: r.record_id, source: r.source || 'booking' });
        ctx.toast('Setup email resent to ' + (r.business || r.name) + '.');
      } catch (e) { ctx.toast(e.message, true); }
      btn.disabled = false;
    });
  }

  load().catch(e => {
    slot.innerHTML = `<div class="card empty-card"><p><strong>Online Check-In couldn't load.</strong></p><p class="muted">${esc(e.message)}</p></div>`;
  });
}
