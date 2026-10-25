// Vendor Communications (Messages group): one bulk email to a market
// date's vendors or to every vendor, via the communications function —
// the same '?action=' endpoints the legacy Vendor Communications tab
// calls (events / history / preview / send). Recipients are previewed
// (and de-duplicated) by the server before anything sends; cancelled
// vendors are excluded from a Market Date email server-side. Past sends
// double as templates: "Use again" loads a previous subject + body into
// the composer. Sending re-fetches the history, per the state rule.
import { fnq, esc, nice } from './api.js?v=20261024-31';

export function renderComms(ctx, root) {
  root.innerHTML = `
    <p class="eyebrow">Messages</p>
    <h2 class="display">Vendor Communications</h2>
    <p class="lede">For weather, setup changes, parking or event reminders choose <strong>Market Date</strong>. For general announcements choose <strong>All Vendors</strong>. Duplicate email addresses are removed automatically.</p>
    <div class="card" id="v2-comms-box"><p class="note">Loading…</p></div>
    <h3 class="section-title">Recent vendor emails</h3>
    <div id="v2-comms-history"><div class="card empty-card">Loading history…</div></div>`;

  const box = root.querySelector('#v2-comms-box');
  const histEl = root.querySelector('#v2-comms-history');
  let events = [];
  let current = [];

  function historyHtml(history) {
    if (!history.length) return '<div class="card empty-card">No mass emails have been sent yet.</div>';
    return history.map(h => `
      <article class="card vendor">
        <div class="vendor-top"><div><h3>${esc(h.subject)}</h3>
        <div class="contact">${h.recipient_mode === 'all' ? 'All Vendors' : h.event_date ? esc(nice(h.event_date)) + ' — ' + esc(h.location || 'Market Date') : 'Market Date'} · ${h.recipient_count} recipients</div></div></div>
        <p class="note">Sent ${new Date(h.created_at).toLocaleString()} by ${esc(h.sender_email)}</p>
        <div class="vendor-actions"><button class="btn small" data-reuse="${esc(h.id)}">Use again as a template</button></div>
      </article>`).join('');
  }

  async function loadHistory() {
    try {
      const history = await fnq('communications', 'history');
      histEl.innerHTML = historyHtml(history || []);
      histEl.querySelectorAll('[data-reuse]').forEach(b => b.onclick = () => {
        const h = (history || []).find(x => String(x.id) === String(b.dataset.reuse));
        if (!h) return;
        const subject = box.querySelector('#comm-subject');
        const body = box.querySelector('#comm-body');
        if (subject) subject.value = h.subject || '';
        if (body) body.value = h.body || '';
        ctx.toast('Loaded into the composer — edit, preview, then send.');
        box.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    } catch (e) {
      histEl.innerHTML = `<div class="card empty-card"><p><strong>History couldn't load.</strong></p><p class="muted">${esc(e.message)}</p></div>`;
    }
  }

  async function load() {
    try {
      events = await fnq('communications', 'events');
    } catch (e) {
      box.innerHTML = `<p class="note flag-note"><strong>Vendor Communications couldn't load.</strong><br>${esc(e.message)}</p>`;
      return;
    }
    box.innerHTML = `
      <form id="v2-comms-form">
        <div class="sheet-grid">
          <label class="sheet-field">Recipients
            <select id="comm-mode"><option value="event">Market Date</option><option value="all">All Vendors</option></select>
          </label>
          <label class="sheet-field" id="comm-event-wrap">Market date
            <select id="comm-event">${(events || []).map(e => `<option value="${esc(e.id)}">${esc(nice(e.date))} — ${esc(e.market_name || e.title || '')} — ${esc(e.location || '')}</option>`).join('')}</select>
          </label>
        </div>
        <div class="note" id="comm-preview">Choose recipients to preview the list.</div>
        <label class="sheet-field">Subject<input id="comm-subject" maxlength="300" placeholder="Important update for our vendors"></label>
        <label class="sheet-field">Message<textarea id="comm-body" rows="10" maxlength="10000" placeholder="Type your vendor message here. You can use {{name}} and {{business}} to personalize it."></textarea></label>
        <div class="vendor-actions">
          <button type="button" class="btn small" id="comm-refresh">Preview recipients</button>
          <button type="submit" class="btn primary small" id="comm-send">Send email</button>
        </div>
        <p class="note">Cancelled vendors are excluded from a Market Date email. All Vendors uses the master vendor records and sends only one copy to each unique email address.</p>
      </form>`;
    const mode = box.querySelector('#comm-mode');
    const eventSel = box.querySelector('#comm-event');
    const wrap = box.querySelector('#comm-event-wrap');
    const previewBox = box.querySelector('#comm-preview');
    const preview = async () => {
      wrap.hidden = mode.value === 'all';
      try {
        const v = await fnq('communications', 'preview', { mode: mode.value, event_id: mode.value === 'event' ? eventSel.value : null });
        current = v.recipients || [];
        previewBox.innerHTML = `<strong>${v.count} unique vendor email${v.count === 1 ? '' : 's'}</strong>${v.count ? `<details><summary>Review recipient list</summary><div class="comm-recipients">${current.map(x => `<p>${esc(x.business)} — ${esc(x.email)}</p>`).join('')}</div></details>` : '<p>No vendors with email addresses are in this selection.</p>'}`;
      } catch (e) {
        previewBox.innerHTML = `<span class="flag-note">${esc(e.message)}</span>`;
      }
    };
    mode.onchange = preview;
    eventSel.onchange = preview;
    box.querySelector('#comm-refresh').onclick = () => preview();
    box.querySelector('#v2-comms-form').onsubmit = async e => {
      e.preventDefault();
      const sendBtn = box.querySelector('#comm-send');
      try {
        await preview();
        if (!current.length) throw Error('There are no recipients to email.');
        const subject = box.querySelector('#comm-subject').value.trim();
        const body = box.querySelector('#comm-body').value.trim();
        if (!subject || !body) throw Error('Enter both a subject and message.');
        if (!confirm(`Send this email to ${current.length} unique vendor${current.length === 1 ? '' : 's'}?`)) return;
        sendBtn.disabled = true;
        const r = await fnq('communications', 'send', { mode: mode.value, event_id: mode.value === 'event' ? eventSel.value : null, subject, body });
        ctx.toast(`Vendor email sent to ${r.count} unique vendor${r.count === 1 ? '' : 's'}.`);
        box.querySelector('#comm-subject').value = '';
        box.querySelector('#comm-body').value = '';
        await loadHistory();
        await preview();
      } catch (err) {
        ctx.toast(err.message, true);
      } finally {
        sendBtn.disabled = false;
      }
    };
    await preview();
  }

  load();
  loadHistory();
}
