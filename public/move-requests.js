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

  // ---- Organizer: move a booking directly from its attendee card --------
  // The organizer is the approver, so the move happens immediately (no
  // request, no 48-hour cutoff); the server still refuses a target that
  // genuinely cannot take the booking, with the reason.
  window.openOrganizerMoveDialog = async (sourceType, sourceId) => {
    openModal('<h2>Move date</h2><p>Checking which dates this booking can move to…</p>');
    try {
      const v = await post({action: 'organizer-options', source_type: sourceType, source_id: sourceId});
      const who = v.source?.business || v.source?.name || 'this vendor';
      const spaceName = s => s === 'indoor' ? 'Indoor' : 'Outdoor';
      if (!v.movable) {
        $('#modal-content').innerHTML = `<h2>Move date — ${esc(who)}</h2><p>${esc(v.reason || 'This booking cannot be moved.')}</p><div class="actions"><button type="button" class="quiet" id="org-move-close">Close</button></div>`;
        $('#org-move-close').onclick = closeModal;
        return;
      }
      const targets = v.targets || [], excluded = v.excluded || [];
      $('#modal-content').innerHTML = `<h2>Move date — ${esc(who)}</h2>
        <p>Currently booked as ${spaceName(v.source.space)}. The move happens right away: payment stays on the booking, the old date's check-in and booth assignment are cleared, and the vendor is emailed the new date. There is no 48-hour cutoff for organizer moves, but a date that is full for the vendor still refuses.</p>
        ${targets.length ? `<form id="org-move-form">
          <fieldset style="border:0;padding:0;margin:0 0 12px"><legend><strong>Move to</strong></legend>
          ${targets.map(t => `<div style="padding:6px 0">
            <label style="display:block"><input type="radio" name="to" value="${esc(t.event.id)}" data-space="${esc(t.spaces[0].space)}" required> ${nice(t.event.date)} — ${esc(t.event.location || '')}</label>
            ${t.spaces.length > 1
              ? `<label style="display:block;margin:4px 0 0 24px">Space <select name="space-${esc(t.event.id)}">${t.spaces.map(s => `<option value="${s.space}" ${s.space === v.source.space ? 'selected' : ''}>${spaceName(s.space)} ${money(s.price)}</option>`).join('')}</select></label>`
              : `<span class="muted" style="margin-left:24px">${spaceName(t.spaces[0].space)} ${money(t.spaces[0].price)}</span>`}
          </div>`).join('')}
          </fieldset>
          <div class="actions"><button type="submit">Move booking</button><button type="button" class="quiet" id="org-move-close">Never mind</button></div>
        </form>` : '<p><strong>No other dates can take this booking right now.</strong></p>'}
        ${excluded.length ? `<div class="note"><p><strong>Why some dates aren't listed:</strong></p><ul>${excluded.map(x => `<li>${nice(x.event?.date)} — ${esc((x.problems || [])[0] || 'Not available')}</li>`).join('')}</ul></div>` : ''}`;
      const close = $('#org-move-close'); if (close) close.onclick = closeModal;
      const form = $('#org-move-form');
      if (form) form.onsubmit = async e => {
        e.preventDefault();
        const radio = form.querySelector('input[name="to"]:checked');
        if (!radio) return;
        const space = form.querySelector(`[name="space-${radio.value}"]`)?.value || radio.dataset.space;
        const btn = form.querySelector('button[type="submit"]');
        if (btn) btn.disabled = true;
        try {
          const out = await post({action: 'organizer-move', source_type: sourceType, source_id: sourceId, to_event_id: radio.value, space});
          $('#modal-content').innerHTML = `<h2>Moved ✓</h2><p><strong>${esc(who)}</strong> is now booked for <strong>${nice(out.to?.date)}</strong>${out.to?.location ? ` — ${esc(out.to.location)}` : ''} (${spaceName(out.space)}). The vendor has been emailed the new date.</p>${out.resolved_request ? '<p>The vendor\'s pending move request was resolved as approved.</p>' : ''}<div class="actions"><button type="button" id="org-move-done">Done</button></div>`;
          $('#org-move-done').onclick = () => { closeModal(); window.dispatchEvent(new HashChangeEvent('hashchange')); };
        } catch (err) { alert(err.message); if (btn) btn.disabled = false; }
      };
    } catch (e) {
      $('#modal-content').innerHTML = `<h2>Move date</h2><p>${esc(e.message)}</p><div class="actions"><button type="button" class="quiet" id="org-move-close">Close</button></div>`;
      $('#org-move-close').onclick = closeModal;
    }
  };

  // Button injection: visibility comes from the server (organizer-movable)
  // — only confirmed records on an upcoming date get a button, mirroring
  // the vendor-side rules; booking status is not rendered on the card, so
  // the client cannot judge it locally. The append pass is fully
  // synchronous: existence check and DOM write happen in the same task, so
  // overlapping passes can never double-insert (no await between them).
  const movableCache = new Map();
  const movableSet = eventId => {
    if (!movableCache.has(eventId)) {
      movableCache.set(eventId, post({action: 'organizer-movable', event_id: eventId})
        .then(v => new Set((v.sources || []).map(s => `${s.source_type}:${s.source_id}`)))
        .catch(e => { movableCache.delete(eventId); throw e; }));
    }
    return movableCache.get(eventId);
  };
  function appendMoveButtons(set) {
    document.querySelectorAll('.report-actions').forEach(actions => {
      const anchor = actions.querySelector('[data-cancel-vendor]');
      if (!anchor || actions.querySelector('[data-org-move]')) return;
      const sourceType = anchor.dataset.imported === '1' ? 'imported' : 'booking';
      const sourceId = anchor.dataset.cancelVendor;
      if (!set.has(`${sourceType}:${sourceId}`)) return;
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'secondary'; b.dataset.orgMove = sourceId; b.dataset.imported = anchor.dataset.imported;
      b.textContent = '📅 Move date';
      b.onclick = () => window.openOrganizerMoveDialog(sourceType, sourceId);
      actions.insertBefore(b, anchor);
    });
  }
  function enhanceMoveButtons() {
    const eventId = document.querySelector('#report-date')?.value || '';
    if (!eventId || !document.querySelector('.report-actions [data-cancel-vendor]')) return;
    movableSet(eventId).then(set => appendMoveButtons(set)).catch(() => {});
  }
  let moveBtnBusy = false;
  const moveBtnObserver = new MutationObserver(() => { if (!moveBtnBusy) { moveBtnBusy = true; requestAnimationFrame(() => { moveBtnBusy = false; enhanceMoveButtons(); }); } });
  moveBtnObserver.observe(document.body, {childList: true, subtree: true});
  window.addEventListener('hashchange', enhanceMoveButtons);
  enhanceMoveButtons();
})();
