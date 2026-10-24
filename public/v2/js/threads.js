// Vendor Messages: the per-application message thread (api 'messages') —
// the same store the legacy #messages panel reads. One renderer serves
// all three roles; the caller passes the application list its own
// payload carries (admin applications, manager applications, or the
// vendor's own `mine` rows). A message's sender is the author's email,
// so "mine" below means "sent from the signed-in account". Posting
// re-fetches the whole thread list before re-rendering (state rule).
import { api, esc } from './api.js?v=20261023-19';

export function renderThreads(ctx, root, { eyebrow = 'Messages', title = 'Vendor Messages', apps = [] } = {}) {
  const list = (apps || []).filter(a => a && a.application_id);
  root.innerHTML = `
    <p class="eyebrow">${esc(eyebrow)}</p>
    <h2 class="display">${esc(title)}</h2>
    <p class="lede">Messages are saved here. Pick the application to read its thread and reply.</p>
    <div id="v2-thread-box"><div class="card empty-card">Loading messages…</div></div>`;
  const box = root.querySelector('#v2-thread-box');
  if (!list.length) {
    box.innerHTML = '<div class="card empty-card">No applications to message about yet. Messages attach to an application, so they will appear here once one exists.</div>';
    return;
  }
  let selected = String(list[0].application_id);

  async function load() {
    let messages;
    try {
      messages = await api('messages');
    } catch (e) {
      box.innerHTML = `<div class="card empty-card"><p><strong>Messages couldn't load.</strong></p><p class="muted">${esc(e.message)}</p></div>`;
      return;
    }
    const thread = (messages || []).filter(m => String(m.application_id) === String(selected));
    box.innerHTML = `
      <label class="picker-label">Application
        <select id="v2-thread-app" class="picker">${list.map(a => `<option value="${esc(a.application_id)}" ${String(a.application_id) === String(selected) ? 'selected' : ''}>${esc(a.business || a.name || 'Application')}</option>`).join('')}</select>
      </label>
      <div class="msg-thread">
        ${thread.map(m => `<div class="msg ${String(m.sender).toLowerCase() === String(ctx.state.user.email).toLowerCase() ? 'mine' : 'theirs'}"><small>${esc(m.sender)} · ${new Date(m.created_at).toLocaleString()}</small><p>${esc(m.body)}</p></div>`).join('') || '<div class="card empty-card">No messages in this thread yet.</div>'}
      </div>
      <form id="v2-thread-form" class="card">
        <label class="sheet-field">Reply<textarea name="body" rows="3" maxlength="4000" required placeholder="Write a message…"></textarea></label>
        <div class="vendor-actions"><button class="btn primary small">Send reply</button></div>
      </form>`;
    box.querySelector('#v2-thread-app').onchange = e => { selected = e.target.value; load(); };
    box.querySelector('#v2-thread-form').onsubmit = async e => {
      e.preventDefault();
      const body = new FormData(e.target).get('body');
      try {
        await api('messages', { application_id: selected, body });
        ctx.toast('Message sent.');
        await load();
      } catch (err) { ctx.toast(err.message, true); }
    };
  }
  load();
}
