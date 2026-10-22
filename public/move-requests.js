// Date-move requests: vendor dialog (My Bookings "Move date") + organizer
// Move Requests inbox (admin tab / manager workspace). Self-contained like
// vendor-credit.js; talks to /.netlify/functions/move-requests.
(() => {
  const $ = s => document.querySelector(s);
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
  const dateOnly = v => v instanceof Date ? v.toISOString().slice(0, 10) : (String(v ?? '').match(/\d{4}-\d{2}-\d{2}/)?.[0] || '');
  const nice = v => { const s = dateOnly(v); if (!s) return ''; return new Date(s + 'T12:00:00Z').toLocaleDateString('en-US', {weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', timeZone: 'America/New_York'}); };
  const money = c => '$' + (Number(c || 0) / 100).toFixed(2);
  const token = () => sessionStorage.getItem('market-token') || '';
  const post = async body => { const r = await fetch('/.netlify/functions/move-requests', {method: 'POST', headers: {Authorization: 'Bearer ' + token(), 'Content-Type': 'application/json'}, body: JSON.stringify(body)}); const v = await r.json().catch(() => ({})); if (!r.ok) throw Error(v.error || 'Request failed.'); return v; };
  const openModal = html => { const m = $('#modal'), c = $('#modal-content'); if (!m || !c) return; c.innerHTML = html; if (m.showModal) m.showModal(); else m.setAttribute('open', ''); };
  const closeModal = () => { const m = $('#modal'); if (m?.close) m.close(); };
  const me = async () => { const r = await fetch('/.netlify/functions/api?action=me', {headers: {Authorization: 'Bearer ' + token()}}); return r.ok ? r.json() : null; };

  // ---- Vendor: move-date dialog (§9.2 — only eligible dates are offered) --
  window.openMoveDateDialog = async (sourceType, sourceId) => {
    openModal('<h2>Move date</h2><p>Checking which dates you can move to…</p>');
    try {
      const v = await post({action: 'options', source_type: sourceType, source_id: sourceId});
      const eligible = v.eligible || [], excluded = v.excluded || [], space = v.space || 'indoor';
      $('#modal-content').innerHTML = `<h2>Request a date move</h2>
        <p>Your booking stays on its current date unless the organizer approves the move. Your payment carries with the booking — there is nothing more to pay for a date change.</p>
        ${eligible.length ? `<form id="move-form">
          <fieldset style="border:0;padding:0;margin:0 0 12px"><legend><strong>Move to</strong></legend>
          ${eligible.map(e => `<label style="display:block;padding:6px 0"><input type="radio" name="to" value="${esc(e.id)}" required> ${nice(e.date)} — ${esc(e.location || '')} · ${space === 'indoor' ? 'Indoor' : 'Outdoor'} ${money(e[space + '_price'])}</label>`).join('')}
          </fieldset>
          <label>Reason (optional)<textarea name="reason" maxlength="500" placeholder="Anything the organizer should know"></textarea></label>
          <div class="actions"><button type="submit">Send request</button><button type="button" class="quiet" id="move-close">Never mind</button></div>
        </form>` : '<p><strong>No other dates are available to move to right now.</strong></p>'}
        ${excluded.length ? `<div class="note"><p><strong>Why some dates aren't listed:</strong></p><ul>${excluded.map(x => `<li>${nice(x.event?.date)} — ${esc((x.problems || [])[0] || 'Not available')}</li>`).join('')}</ul></div>` : ''}`;
      const close = $('#move-close'); if (close) close.onclick = closeModal;
      const form = $('#move-form');
      if (form) form.onsubmit = async e => {
        e.preventDefault();
        const fd = new FormData(form);
        try {
          await post({action: 'create', source_type: sourceType, source_id: sourceId, to_event_id: fd.get('to'), reason: fd.get('reason') || ''});
          $('#modal-content').innerHTML = '<h2>Request sent ✓</h2><p>The organizer will review it. Your booking stays on its current date unless the move is approved — we\'ll email you the decision.</p><div class="actions"><button type="button" id="move-done">Done</button></div>';
          $('#move-done').onclick = () => { closeModal(); window.dispatchEvent(new HashChangeEvent('hashchange')); };
        } catch (err) { alert(err.message); }
      };
    } catch (e) {
      $('#modal-content').innerHTML = `<h2>Move date</h2><p>${esc(e.message)}</p><div class="actions"><button type="button" class="quiet" id="move-close">Close</button></div>`;
      $('#move-close').onclick = closeModal;
    }
  };

  // ---- Organizer: Move Requests inbox ------------------------------------
  window.renderMoveRequests = async el => {
    el.innerHTML = '<h2>Move Requests</h2><p>Loading…</p>';
    let v;
    try { v = await post({action: 'list'}); } catch (e) { el.innerHTML = `<h2>Move Requests</h2><div class="card"><p>${esc(e.message)}</p></div>`; return; }
    const items = v.items || [];
    const card = it => {
      const r = it.request, s = it.source;
      const head = `<strong>${esc(s?.business || s?.name || r.vendor_email)}</strong>${s ? ` — ${esc(s.category || '')} · ${esc(r.space)}` : ''}`;
      const line = `${nice(it.from?.date)} → <strong>${nice(it.to?.date)}</strong> · ${esc(it.to?.location || '')}`;
      if (r.status !== 'pending') return `<article class="card"><p>${head}</p><p>${line}</p><p>Status: <strong>${esc(r.status)}</strong>${r.decided_by ? ` by ${esc(r.decided_by)}` : ''}${r.decision_note ? `<br>Note: ${esc(r.decision_note)}` : ''}</p></article>`;
      return `<article class="card"><p>${head}</p><p>${line}</p>
        ${r.reason ? `<p><strong>Reason:</strong> ${esc(r.reason)}</p>` : ''}
        ${s ? `<p>Booking: ${esc(s.status)} · ${money(s.amount_paid)} paid of ${money(s.amount_due)}${s.monthly ? ' · <strong>⚠ monthly billing — leave billing as-is</strong>' : ''}${s.current_event_id !== r.from_event_id ? ' · <strong>⚠ booking is no longer on the original date</strong>' : ''}</p>` : '<p><strong>Original booking not found.</strong></p>'}
        ${it.from_within_cutoff ? `<p class="note">⚠ The original market starts within 48 hours. Approval is refused unless you tick the override.</p><label class="check"><input type="checkbox" data-move-override="${r.id}"> Override the 48-hour cutoff</label>` : ''}
        <label>Note to vendor (optional — included if you decline)<textarea data-move-note="${r.id}" maxlength="500"></textarea></label>
        <div class="actions"><button data-move-approve="${r.id}">Approve move</button><button class="quiet" data-move-decline="${r.id}">Decline</button></div>
        <p class="muted" data-move-msg="${r.id}"></p></article>`;
    };
    const pending = items.filter(i => i.request.status === 'pending'), decided = items.filter(i => i.request.status !== 'pending').slice(0, 20);
    el.innerHTML = `<h2>Move Requests ${pending.length ? `<span class="tag">${pending.length} pending</span>` : ''}</h2>
      <p>Approving re-checks space, category, and duplicates at decision time — if the target filled up, approval is refused with the reason and the request stays pending. The vendor's payment stays on the booking.</p>
      <div class="list">${pending.map(card).join('') || '<div class="card empty">No pending move requests.</div>'}</div>
      ${decided.length ? `<h3>Recently decided</h3><div class="list">${decided.map(card).join('')}</div>` : ''}`;
    el.querySelectorAll('[data-move-approve]').forEach(b => b.onclick = async () => { const id = b.dataset.moveApprove, msg = el.querySelector(`[data-move-msg="${id}"]`); b.disabled = true; try { await post({action: 'approve', id, override_cutoff: el.querySelector(`[data-move-override="${id}"]`)?.checked === true}); window.renderMoveRequests(el); } catch (e) { if (msg) msg.textContent = e.message; b.disabled = false; } });
    el.querySelectorAll('[data-move-decline]').forEach(b => b.onclick = async () => { const id = b.dataset.moveDecline, msg = el.querySelector(`[data-move-msg="${id}"]`); b.disabled = true; try { await post({action: 'decline', id, note: el.querySelector(`[data-move-note="${id}"]`)?.value || ''}); window.renderMoveRequests(el); } catch (e) { if (msg) msg.textContent = e.message; b.disabled = false; } });
  };

  // ---- Organizer tab injection (Organizer Tools pattern) -----------------
  let tabBusy = false;
  async function install() {
    if (location.hash !== '#admin') return;
    const tabs = document.querySelector('.tabs');
    if (!tabs || tabs.querySelector('[data-move-tab]')) return;
    const u = await me().catch(() => null);
    if (!u || !(u.admin || (u.permissions || []).includes('moves:approve'))) return;
    const b = document.createElement('button');
    b.type = 'button'; b.dataset.moveTab = '1'; b.textContent = 'Move Requests';
    try { const v = await post({action: 'list'}); if (v.pending) b.textContent = `Move Requests (${v.pending})`; } catch {}
    b.onclick = () => { tabs.querySelectorAll('button').forEach(x => x.classList.remove('active')); b.classList.add('active'); const panel = document.querySelector('#panel'); if (panel) window.renderMoveRequests(panel); };
    tabs.append(b);
  }
  const observer = new MutationObserver(() => { if (!tabBusy) { tabBusy = true; requestAnimationFrame(() => { tabBusy = false; install(); }); } });
  observer.observe(document.body, {childList: true, subtree: true});
  window.addEventListener('hashchange', install);
  install();
})();
