// Email a Flyer (Messages group, §56): one bulk email with a flyer
// attached (PDF, PNG or JPG, up to 10 MB — uploaded fresh for each
// send, nothing is stored). Audiences are resolved and previewed by
// the server (communications function, flyer actions): a market date's
// booked vendors, all vendors, or regulars only — de-duplicated by
// email and with banned vendors excluded server-side. The send result
// is read back per recipient from the mail queue: the screen lists
// delivered, failed (with the reason) and still-queued separately and
// never calls a queued or failed email "sent".
import { fnq, esc, nice } from './api.js?v=20261103-43';

const FLYER_MAX_BYTES = 10 * 1024 * 1024;

export function renderFlyer(ctx, root) {
  root.innerHTML = `
    <p class="eyebrow">Messages</p>
    <h2 class="display">Email a Flyer</h2>
    <p class="lede">Send one email with a flyer attached — a market date's booked vendors, <strong>All Vendors</strong>, or <strong>Regulars Only</strong>. Duplicate email addresses are removed and banned vendors are excluded automatically.</p>
    <div class="card" id="v2-flyer-box"><p class="note">Loading…</p></div>
    <div id="v2-flyer-results"></div>
    <h3 class="section-title">Recent flyer emails</h3>
    <div id="v2-flyer-history"><div class="card empty-card">Loading history…</div></div>`;

  const box = root.querySelector('#v2-flyer-box');
  const resultsEl = root.querySelector('#v2-flyer-results');
  const histEl = root.querySelector('#v2-flyer-history');
  let events = [];
  let current = [];
  let flyer = null; // {filename, data_url} — this send's upload only

  const modeLabel = h => h.mode === 'all' ? 'All Vendors' : h.mode === 'regulars' ? 'Regulars Only' : h.event_date ? esc(nice(h.event_date)) + ' — ' + esc(h.location || 'Market Date') : 'Market Date';

  function historyHtml(history) {
    if (!history.length) return '<div class="card empty-card">No flyer emails have been sent yet.</div>';
    return history.map(h => `
      <article class="card vendor">
        <div class="vendor-top"><div><h3>${esc(h.subject)}</h3>
        <div class="contact">${modeLabel(h)} · ${h.recipient_count} recipients · 📎 ${esc(h.attachment)}</div></div></div>
        <p class="note">Sent ${new Date(h.created_at).toLocaleString()} by ${esc(h.sender_email)}${h.delivered != null ? ` — ${h.delivered} delivered${h.failed ? `, ${h.failed} failed` : ''}${h.queued ? `, ${h.queued} still queued` : ''}` : ''}</p>
      </article>`).join('');
  }

  async function loadHistory() {
    try {
      const history = await fnq('communications', 'flyer-history');
      histEl.innerHTML = historyHtml(history || []);
    } catch (e) {
      histEl.innerHTML = `<div class="card empty-card"><p><strong>History couldn't load.</strong></p><p class="muted">${esc(e.message)}</p></div>`;
    }
  }

  function resultsHtml(r) {
    const row = x => `<p>${esc(x.business)} — ${esc(x.email)}${x.status === 'delivered' ? ' · ✅ Delivered' : x.status === 'failed' ? ` · ❌ Failed — ${esc(x.error || 'delivery failed')}` : ' · 🕓 Still queued — not delivered yet'}</p>`;
    return `
      <h3 class="section-title">Send results</h3>
      <div class="card">
        <p class="note"><strong>${r.delivered} delivered</strong> · ${r.failed} failed · ${r.queued} still queued, out of ${r.count} vendor${r.count === 1 ? '' : 's'}.</p>
        <details open><summary>Per-vendor results</summary><div class="comm-recipients">${(r.results || []).map(row).join('')}</div></details>
      </div>`;
  }

  async function load() {
    try {
      events = await fnq('communications', 'events');
    } catch (e) {
      box.innerHTML = `<p class="note flag-note"><strong>Email a Flyer couldn't load.</strong><br>${esc(e.message)}</p>`;
      return;
    }
    box.innerHTML = `
      <form id="v2-flyer-form">
        <div class="sheet-grid">
          <label class="sheet-field">Recipients
            <select id="flyer-mode"><option value="event">Market Date</option><option value="all">All Vendors</option><option value="regulars">Regulars Only</option></select>
          </label>
          <label class="sheet-field" id="flyer-event-wrap">Market date
            <select id="flyer-event">${(events || []).map(e => `<option value="${esc(e.id)}">${esc(nice(e.date))} — ${esc(e.market_name || e.title || '')} — ${esc(e.location || '')}</option>`).join('')}</select>
          </label>
        </div>
        <div class="note" id="flyer-preview">Choose recipients to preview the count.</div>
        <label class="sheet-field">Subject<input id="flyer-subject" maxlength="300" placeholder="This Saturday's market flyer"></label>
        <label class="sheet-field">Message<textarea id="flyer-body" rows="8" maxlength="10000" placeholder="Type the message that goes with the flyer. You can use {{name}} and {{business}} to personalize it."></textarea></label>
        <label class="sheet-field">Flyer attachment (PDF, PNG or JPG, up to 10 MB)
          <input type="file" id="flyer-file" accept=".pdf,.png,.jpg,.jpeg,application/pdf,image/png,image/jpeg">
        </label>
        <p class="note" id="flyer-file-note">No flyer attached yet. The flyer is uploaded fresh for this send and is not stored.</p>
        <div class="vendor-actions">
          <button type="button" class="btn small" id="flyer-refresh">Preview recipients</button>
          <button type="submit" class="btn primary small" id="flyer-send">Send flyer email</button>
        </div>
      </form>`;
    const mode = box.querySelector('#flyer-mode');
    const eventSel = box.querySelector('#flyer-event');
    const wrap = box.querySelector('#flyer-event-wrap');
    const previewBox = box.querySelector('#flyer-preview');
    const fileInput = box.querySelector('#flyer-file');
    const fileNote = box.querySelector('#flyer-file-note');
    const payload = () => ({ mode: mode.value, event_id: mode.value === 'event' ? eventSel.value : null });
    const preview = async () => {
      wrap.hidden = mode.value !== 'event';
      try {
        const v = await fnq('communications', 'flyer-preview', payload());
        current = v.recipients || [];
        previewBox.innerHTML = v.count
          ? `<strong>This will go to ${v.count} vendor${v.count === 1 ? '' : 's'}</strong><details><summary>Review recipient list</summary><div class="comm-recipients">${current.map(x => `<p>${esc(x.business)} — ${esc(x.email)}</p>`).join('')}</div></details>`
          : '<p>No vendors with email addresses are in this selection.</p>';
      } catch (e) {
        previewBox.innerHTML = `<span class="flag-note">${esc(e.message)}</span>`;
      }
    };
    mode.onchange = preview;
    eventSel.onchange = preview;
    box.querySelector('#flyer-refresh').onclick = () => preview();
    fileInput.onchange = () => {
      flyer = null;
      const f = fileInput.files && fileInput.files[0];
      if (!f) { fileNote.textContent = 'No flyer attached yet. The flyer is uploaded fresh for this send and is not stored.'; return; }
      if (!/\.(pdf|png|jpe?g)$/i.test(f.name)) { fileNote.innerHTML = '<span class="flag-note">Attach the flyer as a PDF, PNG, or JPG file.</span>'; fileInput.value = ''; return; }
      if (f.size > FLYER_MAX_BYTES) { fileNote.innerHTML = '<span class="flag-note">The flyer is too large — attach a file up to 10 MB.</span>'; fileInput.value = ''; return; }
      const reader = new FileReader();
      reader.onerror = () => { fileNote.innerHTML = '<span class="flag-note">That flyer file could not be read. Try attaching it again.</span>'; };
      reader.onload = () => {
        flyer = { filename: f.name, data_url: String(reader.result || '') };
        fileNote.textContent = `Attached: ${f.name} (${(f.size / 1024).toFixed(0)} KB) — this file goes out with this send only.`;
      };
      reader.readAsDataURL(f);
    };
    box.querySelector('#v2-flyer-form').onsubmit = async e => {
      e.preventDefault();
      const sendBtn = box.querySelector('#flyer-send');
      try {
        await preview();
        if (!current.length) throw Error('There are no recipients to email.');
        const subject = box.querySelector('#flyer-subject').value.trim();
        const body = box.querySelector('#flyer-body').value.trim();
        if (!subject || !body) throw Error('Enter both a subject and message.');
        if (!flyer) throw Error('Attach the flyer file first (PDF, PNG or JPG, up to 10 MB).');
        if (!confirm(`Send this flyer email to ${current.length} vendor${current.length === 1 ? '' : 's'}?`)) return;
        sendBtn.disabled = true;
        const r = await fnq('communications', 'flyer-send', { ...payload(), subject, body, attachment: flyer });
        resultsEl.innerHTML = resultsHtml(r);
        ctx.toast(r.failed || r.queued ? `Flyer email finished: ${r.delivered} delivered, ${r.failed} failed, ${r.queued} still queued.` : `Flyer email delivered to ${r.delivered} vendor${r.delivered === 1 ? '' : 's'}.`, !!(r.failed || r.queued));
        box.querySelector('#flyer-subject').value = '';
        box.querySelector('#flyer-body').value = '';
        fileInput.value = ''; flyer = null;
        fileNote.textContent = 'No flyer attached yet. The flyer is uploaded fresh for this send and is not stored.';
        resultsEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
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
