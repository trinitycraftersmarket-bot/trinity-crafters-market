// Move Requests inbox (audit §9.4): vendor date-move requests waiting on
// an organizer decision. Rebuilt from the Features A inbox with the same
// move-requests function payloads: list returns {items, pending}; each
// item carries the request, its source booking snapshot, both events, and
// the 48-hour-cutoff flag. Approving re-checks capacity on the server — if
// the target filled up, the server refuses with the reason and the request
// stays pending; that error is shown on the card, never swallowed.
import { fn, esc, money, nice } from './api.js?v=20261023-4';

export function renderMoves(ctx, root) {
  root.innerHTML = `
    <p class="eyebrow">Vendors</p>
    <h2 class="display">Move Requests</h2>
    <p class="lede">Approving re-checks space, category, and duplicates at decision time — if the target date filled up, approval is refused with the reason and the request stays pending. The vendor's payment stays on the booking.</p>
    <div id="v2-moves-list"><div class="card empty-card">Loading move requests…</div></div>`;

  const load = async () => {
    const listEl = root.querySelector('#v2-moves-list');
    let v;
    try {
      v = await fn('move-requests', { action: 'list' });
    } catch (e) {
      listEl.innerHTML = `<div class="card empty-card"><p><strong>Move requests couldn't load.</strong></p><p class="muted">${esc(e.message)}</p></div>`;
      return;
    }
    const items = v.items || [];
    const pending = items.filter(i => i.request.status === 'pending');
    const decided = items.filter(i => i.request.status !== 'pending').slice(0, 20);
    listEl.innerHTML = `
      ${pending.length ? `<p class="note"><strong>${pending.length}</strong> request${pending.length === 1 ? '' : 's'} waiting for your decision.</p>` : ''}
      <div class="vendor-list">${pending.map(cardHtml).join('') || '<div class="card empty-card">No pending move requests.</div>'}</div>
      ${decided.length ? `<h3 class="section-title">Recently decided</h3><div class="vendor-list">${decided.map(cardHtml).join('')}</div>` : ''}`;
    bind();
  };

  function cardHtml(it) {
    const r = it.request, s = it.source;
    const head = `<div class="vendor-top"><div><h3>${esc(s?.business || s?.name || r.vendor_email)}</h3>
      <div class="contact">${s ? esc(s.category || '') + ' · ' + esc(r.space) : esc(r.vendor_email)}</div></div>
      <span class="status ${r.status === 'pending' ? 'warn' : r.status === 'approved' ? 'ok' : 'bad'}">${esc(r.status)}</span></div>`;
    const line = `<p class="note"><strong>${esc(it.from?.date ? nice(it.from.date) : '—')}</strong> → <strong>${esc(it.to?.date ? nice(it.to.date) : '—')}</strong>${it.to?.location ? ' · ' + esc(it.to.location) : ''}</p>`;
    if (r.status !== 'pending') {
      return `<article class="card vendor">${head}${line}
        <p class="note">Decided${r.decided_by ? ' by ' + esc(r.decided_by) : ''}${r.decision_note ? `<br>Note: ${esc(r.decision_note)}` : ''}</p></article>`;
    }
    return `<article class="card vendor">${head}${line}
      ${r.reason ? `<p class="note"><strong>Reason:</strong> ${esc(r.reason)}</p>` : ''}
      ${s ? `<p class="note">Booking: ${esc(s.status)} · ${money(s.amount_paid)} paid of ${money(s.amount_due)}${s.monthly ? ' · <strong>⚠ monthly billing — leave billing as-is</strong>' : ''}${String(s.current_event_id) !== String(r.from_event_id) ? ' · <strong>⚠ booking is no longer on the original date</strong>' : ''}</p>` : '<p class="note flag-note"><strong>Original booking not found.</strong></p>'}
      ${it.from_within_cutoff ? `<p class="note flag-note">⚠ The original market starts within 48 hours. Approval is refused unless you tick the override.</p>
        <label class="checkline"><input type="checkbox" data-override="${esc(r.id)}"> Override the 48-hour cutoff</label>` : ''}
      <label class="sheet-field">Note to vendor (optional — included if you decline)<textarea data-note="${esc(r.id)}" rows="2" maxlength="500"></textarea></label>
      <p class="note flag-note" data-msg="${esc(r.id)}" hidden></p>
      <div class="vendor-actions">
        <button class="btn primary small" data-approve="${esc(r.id)}">Approve move</button>
        <button class="btn small" data-decline="${esc(r.id)}">Decline</button>
      </div>
    </article>`;
  }

  function bind() {
    const decide = async (id, action) => {
      const msg = root.querySelector(`[data-msg="${CSS.escape(id)}"]`);
      try {
        await fn('move-requests', action === 'approve'
          ? { action: 'approve', id, override_cutoff: root.querySelector(`[data-override="${CSS.escape(id)}"]`)?.checked === true }
          : { action: 'decline', id, note: root.querySelector(`[data-note="${CSS.escape(id)}"]`)?.value || '' });
        ctx.toast(action === 'approve' ? 'Move approved — the vendor has been emailed.' : 'Move declined — the vendor has been emailed.');
        await ctx.refreshData();
        load();
      } catch (e) {
        if (msg) { msg.hidden = false; msg.textContent = e.message; }
        ctx.toast(e.message, true);
      }
    };
    root.querySelectorAll('[data-approve]').forEach(b => b.onclick = () => { b.disabled = true; decide(b.dataset.approve, 'approve').finally(() => { b.disabled = false; }); });
    root.querySelectorAll('[data-decline]').forEach(b => b.onclick = () => { b.disabled = true; decide(b.dataset.decline, 'decline').finally(() => { b.disabled = false; }); });
  }

  load();
}
