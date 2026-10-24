// Live Chat (Messages group) — the website chat the legacy live-chat
// scripts run, over the live-chat function's '?action=' endpoints.
// Admin side: dashboard + searchable history (admin-search), thread view
// (admin-messages), reply with optional attachment (admin-create-upload
// ticket -> storage -> admin-reply), close/reopen, and the open/closed
// toggle (admin-toggle). Vendor side: the same conversation from the
// vendor's account — start / messages / send / create-upload, with the
// session {id, token} kept in session storage (the legacy widget keeps
// it in persistent browser storage; v2 keeps it per-session only, so a
// v2 chat resumes within the browser session rather than across
// restarts).
// Both sides re-fetch the thread after every send (state rule), and the
// admin view quietly re-polls while it is on screen.
import { fnq, uploadChatFile, esc } from './api.js?v=20261023-16';

const stamp = d => d ? new Date(d).toLocaleString() : '';
const CHAT_KEY = 'market-chat-session';

export function attachmentHtml(m) {
  if (!m.attachment_name) return '';
  const name = esc(m.attachment_name), url = m.attachment_url ? esc(m.attachment_url) : '';
  if (!url) return `<div class="chat-attachment"><span>📎 ${name}</span></div>`;
  if (String(m.attachment_type || '').startsWith('image/')) {
    return `<div class="chat-attachment"><a href="${url}" target="_blank" rel="noopener"><img class="chat-attachment-img" src="${url}" alt="Attachment: ${name}" loading="lazy"></a><a class="chat-file-link" href="${url}" target="_blank" rel="noopener">📎 ${name}</a></div>`;
  }
  return `<div class="chat-attachment"><a class="chat-file-link" href="${url}" target="_blank" rel="noopener">📄 ${name}</a></div>`;
}
const fileOk = f => !!f && f.size > 0;

// ---------------------------------------------------------------- admin ---
export function renderChatAdmin(ctx, root) {
  const view = { q: '', filter: 'all', page: 1, pageSize: 20, pages: 1, total: 0, sessionId: null, open: false };
  root.innerHTML = `
    <p class="eyebrow">Messages</p>
    <h2 class="display">Live Chat</h2>
    <div id="v2-chat-box"><div class="card empty-card">Loading conversations…</div></div>`;
  const box = root.querySelector('#v2-chat-box');
  let poller = setInterval(() => {
    if (!document.body.contains(root)) { clearInterval(poller); return; }
    // Never rebuild the screen under the organizer's fingers: a focused
    // search box or reply composer (or a chosen attachment) wins.
    const active = document.activeElement;
    if (active && box.contains(active) && /INPUT|TEXTAREA/.test(active.tagName)) return;
    if (box.querySelector('input[type="file"]')?.files?.length) return;
    if (view.sessionId) openThread(view.sessionId, true);
    else loadList(true);
  }, 10000);

  function chatCard(s) {
    const label = s.vendor_business || s.visitor_name || 'Vendor';
    const unread = Number(s.unread || 0);
    return `<button type="button" class="menu-item chat-row" data-chat-open="${esc(s.id)}">
      <span><b>${esc(label)}</b><span>${esc(s.visitor_name || '')}${s.visitor_email ? ' · ' + esc(s.visitor_email) : ''}${s.visitor_phone ? ' · ' + esc(s.visitor_phone) : ''}</span>
      <span class="chat-preview">${esc(s.last_message || 'No message yet')}</span></span>
      <span class="chat-meta"><span class="status ${s.status === 'closed' ? 'neutral' : 'ok'}">${esc(s.status)}</span> <span class="status ${s.vendor_id ? 'neutral' : 'warn'}">${s.vendor_id ? 'Existing vendor' : 'New inquiry'}</span>${unread ? `<span class="tab-badge static">${unread}</span>` : ''}<br><small>${esc(stamp(s.last_message_at))}</small></span>
    </button>`;
  }

  async function loadList(quiet = false) {
    try {
      const d = await fnq('live-chat', 'admin-dashboard');
      view.open = !!d.open;
      const s = await fnq('live-chat', 'admin-search', { q: view.q, filter: view.filter, page: view.page, page_size: view.pageSize });
      view.total = Number(s.total || 0); view.pages = Number(s.pages || 1); view.page = Number(s.page || 1);
      box.innerHTML = `
        <section class="card">
          <div class="vendor-top"><div><h3>${view.open ? 'Chat is open' : 'Chat is closed'}</h3>
          <p class="note">${view.open ? 'Vendors can start a live conversation now.' : 'New questions are sent to you by email and saved here.'}</p></div>
          <button class="btn small ${view.open ? '' : 'primary'}" id="v2-chat-toggle">${view.open ? 'Close Live Chat' : 'Open Live Chat'}</button></div>
          <div class="search"><input id="v2-chat-q" type="search" placeholder="Search name, phone, email, or business…" autocomplete="off" value="${esc(view.q)}"></div>
          <div class="filters" role="group" aria-label="Filter conversations">
            ${[['all', 'All'], ['active', 'Active'], ['unread', 'Unread'], ['closed', 'Closed'], ['existing', 'Existing vendors'], ['new', 'New inquiries']].map(([v, l]) => `<button type="button" class="chip-btn ${view.filter === v ? 'active' : ''}" data-chat-filter="${v}">${l}</button>`).join('')}
          </div>
          <p class="note">${view.total ? `Showing ${view.total} conversation${view.total === 1 ? '' : 's'} · newest first` : 'No conversations match this search.'}</p>
          <div class="sheet-menu">${(s.sessions || []).map(chatCard).join('') || '<p class="note">No conversations yet.</p>'}</div>
          ${view.pages > 1 ? `<div class="vendor-actions"><button class="btn small" id="v2-chat-prev" ${view.page <= 1 ? 'disabled' : ''}>← Previous</button><span class="note">Page ${view.page} of ${view.pages}</span><button class="btn small" id="v2-chat-next" ${view.page >= view.pages ? 'disabled' : ''}>Next →</button></div>` : ''}
        </section>`;
      box.querySelector('#v2-chat-toggle').onclick = async e => {
        e.currentTarget.disabled = true;
        try { await fnq('live-chat', 'admin-toggle', { open: !view.open }); ctx.toast(view.open ? 'Live Chat closed for new visitors.' : 'Live Chat is open.'); await loadList(); }
        catch (err) { ctx.toast(err.message, true); e.currentTarget.disabled = false; }
      };
      const q = box.querySelector('#v2-chat-q');
      let timer = 0;
      q.oninput = () => { clearTimeout(timer); timer = setTimeout(() => { view.q = q.value.trim(); view.page = 1; loadList(); }, 300); };
      box.querySelectorAll('[data-chat-filter]').forEach(b => b.onclick = () => { view.filter = b.dataset.chatFilter; view.page = 1; loadList(); });
      box.querySelectorAll('[data-chat-open]').forEach(b => b.onclick = () => openThread(b.dataset.chatOpen));
      const prev = box.querySelector('#v2-chat-prev'); if (prev) prev.onclick = () => { view.page = Math.max(1, view.page - 1); loadList(); };
      const next = box.querySelector('#v2-chat-next'); if (next) next.onclick = () => { view.page = Math.min(view.pages, view.page + 1); loadList(); };
    } catch (e) {
      if (!quiet) box.innerHTML = `<div class="card empty-card"><p><strong>Live Chat couldn't load.</strong></p><p class="muted">${esc(e.message)}</p></div>`;
    }
  }

  async function openThread(id, quiet = false) {
    view.sessionId = id;
    try {
      const d = await fnq('live-chat', 'admin-messages', { id });
      const s = d.session, msgs = d.messages || [];
      const draft = box.querySelector('#v2-chat-reply-text')?.value || '';
      box.innerHTML = `
        <section class="card">
          <div class="vendor-actions"><button class="btn small" id="v2-chat-back">← Back to Live Chat</button></div>
          <h3 class="section-title">${esc(s.vendor_business || s.visitor_name || 'Conversation')}</h3>
          <p class="note"><strong>${esc(s.visitor_name || '')}</strong><br>${esc(s.visitor_email || '')} · ${esc(s.visitor_phone || '')}<br><strong>What they sell:</strong> ${esc(s.selling || '')}</p>
          <p><span class="status ${s.status === 'closed' ? 'neutral' : 'ok'}">${esc(s.status)}</span> ${s.account_number ? `<span class="status neutral">Vendor ${esc(s.account_number)}</span>` : '<span class="status neutral">New vendor / visitor</span>'}</p>
          <div class="msg-thread chat-thread">${msgs.map(m => `<div class="msg ${m.sender === 'organizer' ? 'mine' : 'theirs'}"><small>${m.sender === 'organizer' ? 'You' : 'Vendor'} · ${esc(stamp(m.created_at))}</small>${m.body ? `<p>${esc(m.body)}</p>` : ''}${attachmentHtml(m)}</div>`).join('') || '<p class="note">No messages yet.</p>'}</div>
          ${s.status === 'closed'
            ? '<div class="vendor-actions"><button class="btn small" id="v2-chat-reopen">Reopen conversation</button></div>'
            : `<form id="v2-chat-reply">
                <label class="sheet-field">Reply<textarea id="v2-chat-reply-text" name="message" rows="3" placeholder="Type a reply, attach a file, or both">${esc(draft)}</textarea></label>
                <label class="sheet-field">Attach screenshot or PDF<input name="attachment" type="file" accept="image/jpeg,image/png,image/webp,image/gif,application/pdf"></label>
                <p class="note">JPG, PNG, WEBP, GIF, or PDF up to 10 MB.</p>
                <div class="vendor-actions"><button class="btn primary small">Send reply</button><button type="button" class="btn small" id="v2-chat-close">Close conversation</button></div>
              </form>`}
        </section>`;
      box.querySelector('#v2-chat-back').onclick = () => { view.sessionId = null; loadList(); };
      const threadEl = box.querySelector('.chat-thread');
      if (threadEl) threadEl.scrollTop = threadEl.scrollHeight;
      const form = box.querySelector('#v2-chat-reply');
      if (form) form.onsubmit = async e => {
        e.preventDefault();
        const f = new FormData(form);
        const file = f.get('attachment');
        const hasFile = fileOk(file);
        const message = String(f.get('message') || '').trim();
        if (!message && !hasFile) { ctx.toast('Type a reply or attach a file.', true); return; }
        const btn = e.submitter; btn.disabled = true; btn.textContent = hasFile ? 'Uploading…' : 'Sending…';
        try {
          const attachment = hasFile ? await uploadChatFile(await fnq('live-chat', 'admin-create-upload', { id, name: file.name, type: file.type, size: file.size }), file) : null;
          await fnq('live-chat', 'admin-reply', { id, message, attachment });
          await openThread(id);
        } catch (err) { ctx.toast(err.message, true); btn.disabled = false; btn.textContent = 'Send reply'; }
      };
      const close = box.querySelector('#v2-chat-close');
      if (close) close.onclick = async () => {
        if (!confirm('Close this conversation?')) return;
        try { await fnq('live-chat', 'admin-close', { id }); await openThread(id); } catch (err) { ctx.toast(err.message, true); }
      };
      const reopen = box.querySelector('#v2-chat-reopen');
      if (reopen) reopen.onclick = async () => { try { await fnq('live-chat', 'admin-reopen', { id }); await openThread(id); } catch (err) { ctx.toast(err.message, true); } };
    } catch (e) {
      if (!quiet) ctx.toast(e.message, true);
    }
  }

  loadList();
}

// --------------------------------------------------------------- vendor ---
export function renderChatVendor(ctx, root) {
  root.innerHTML = `
    <p class="eyebrow">Messages</p>
    <h2 class="display">Chat with us</h2>
    <p class="lede">Questions about your booth, a market date, or your application — ask here.</p>
    <div id="v2-vchat-box"><div class="card empty-card">Loading chat…</div></div>`;
  const box = root.querySelector('#v2-vchat-box');
  const saved = () => { try { return JSON.parse(sessionStorage.getItem(CHAT_KEY) || 'null'); } catch { return null; } };
  const save = s => { if (s) sessionStorage.setItem(CHAT_KEY, JSON.stringify(s)); else sessionStorage.removeItem(CHAT_KEY); };
  let session = saved();
  let open = false;

  async function refresh() {
    if (!session) { drawStart(); return; }
    try {
      const r = await fnq('live-chat', 'messages', { id: session.id, token: session.token });
      open = !!r.open;
      session = { ...session, ...r.session };
      save(session);
      drawThread(r.messages || []);
    } catch (e) {
      if (/not found/i.test(e.message)) { save(null); session = null; drawStart(); }
      else box.innerHTML = `<div class="card empty-card"><p><strong>Chat couldn't load.</strong></p><p class="muted">${esc(e.message)}</p></div>`;
    }
  }

  function drawStart() {
    box.innerHTML = `
      <form id="v2-vchat-start" class="card">
        <p class="note">${open ? 'We are online. Tell us who you are and what you sell to start chatting.' : 'Live chat is currently closed. Send your question and we will receive it by email.'}</p>
        <label class="sheet-field">Name<input name="name" autocomplete="name" required></label>
        <label class="sheet-field">Email<input type="email" name="email" autocomplete="email" required value="${esc(ctx.state.user.email)}"></label>
        <label class="sheet-field">Phone<input name="phone" autocomplete="tel" required></label>
        <label class="sheet-field">What do you sell?<textarea name="selling" rows="2" required></textarea></label>
        <label class="sheet-field">Your question<textarea name="message" rows="3" placeholder="Type your question, attach a file, or both"></textarea></label>
        <label class="sheet-field">Attach screenshot or PDF<input name="attachment" type="file" accept="image/jpeg,image/png,image/webp,image/gif,application/pdf"></label>
        <p class="note">Attachments may be JPG, PNG, WEBP, GIF, or PDF up to 10 MB. Your contact information is used to respond to your market question.</p>
        <div class="vendor-actions"><button class="btn primary small">${open ? 'Start live chat' : 'Send us a message'}</button></div>
      </form>`;
    box.querySelector('#v2-vchat-start').onsubmit = async e => {
      e.preventDefault();
      const form = e.target, f = new FormData(form);
      const file = f.get('attachment');
      const hasFile = fileOk(file);
      const message = String(f.get('message') || '').trim();
      if (!message && !hasFile) { ctx.toast('Type a question or attach a file.', true); return; }
      const btn = e.submitter; btn.disabled = true; btn.textContent = hasFile ? 'Uploading…' : 'Sending…';
      try {
        const r = await fnq('live-chat', 'start', { name: f.get('name'), email: f.get('email'), phone: f.get('phone'), selling: f.get('selling'), message, has_attachment: hasFile });
        session = { ...r.session };
        save(session);
        if (hasFile) {
          const attachment = await uploadChatFile(await fnq('live-chat', 'create-upload', { id: session.id, token: session.token, name: file.name, type: file.type, size: file.size }), file);
          await fnq('live-chat', 'send', { id: session.id, token: session.token, message, attachment });
        }
        await refresh();
      } catch (err) { ctx.toast(err.message, true); btn.disabled = false; btn.textContent = open ? 'Start live chat' : 'Send us a message'; }
    };
  }

  function drawThread(messages) {
    const closed = session.status === 'closed';
    const offline = session.status === 'offline' || !open;
    box.innerHTML = `
      <div class="card">
        <p class="note"><strong>${session.existing_vendor ? 'Welcome back — we matched your vendor record.' : 'Vendor inquiry'}</strong><br>${closed ? 'Conversation closed' : offline ? 'We are offline. New messages will be emailed to us.' : 'Live now'}</p>
        <div class="msg-thread chat-thread">${messages.map(m => `<div class="msg ${m.sender === 'visitor' ? 'mine' : 'theirs'}"><small>${m.sender === 'visitor' ? 'You' : 'Trinity Crafters Market'} · ${esc(stamp(m.created_at))}</small>${m.body ? `<p>${esc(m.body)}</p>` : ''}${attachmentHtml(m)}</div>`).join('') || '<p class="note">No messages yet.</p>'}</div>
        ${closed
          ? '<div class="vendor-actions"><button class="btn small" id="v2-vchat-new">Start a new conversation</button></div>'
          : `<form id="v2-vchat-send">
              <label class="sheet-field">Message<textarea name="message" rows="2" placeholder="Type a message or attach a file…"></textarea></label>
              <label class="sheet-field">Attach screenshot or PDF<input name="attachment" type="file" accept="image/jpeg,image/png,image/webp,image/gif,application/pdf"></label>
              <div class="vendor-actions"><button class="btn primary small">Send</button></div>
            </form>`}
      </div>`;
    const threadEl = box.querySelector('.chat-thread');
    if (threadEl) threadEl.scrollTop = threadEl.scrollHeight;
    const send = box.querySelector('#v2-vchat-send');
    if (send) send.onsubmit = async e => {
      e.preventDefault();
      const f = new FormData(send);
      const file = f.get('attachment');
      const hasFile = fileOk(file);
      const message = String(f.get('message') || '').trim();
      if (!message && !hasFile) { ctx.toast('Type a message or attach a file.', true); return; }
      const btn = e.submitter; btn.disabled = true; btn.textContent = hasFile ? 'Uploading…' : 'Sending…';
      try {
        const attachment = hasFile ? await uploadChatFile(await fnq('live-chat', 'create-upload', { id: session.id, token: session.token, name: file.name, type: file.type, size: file.size }), file) : null;
        await fnq('live-chat', 'send', { id: session.id, token: session.token, message, attachment });
        await refresh();
      } catch (err) { ctx.toast(err.message, true); btn.disabled = false; btn.textContent = 'Send'; }
    };
    const nw = box.querySelector('#v2-vchat-new');
    if (nw) nw.onclick = () => { save(null); session = null; drawStart(); };
    // Quiet re-poll while the vendor sits on this screen (composer-safe:
    // never redraws over a draft or a chosen file).
    clearTimeout(drawThread._t);
    drawThread._t = setTimeout(() => {
      if (!document.body.contains(root)) return;
      const formNow = box.querySelector('#v2-vchat-send');
      const busy = formNow && (formNow.querySelector('textarea')?.value.trim() || formNow.querySelector('input[type="file"]')?.files?.length);
      if (!busy) refresh();
    }, 6000);
  }

  fnq('live-chat', 'status').then(r => { open = !!r.open; }).catch(() => {}).finally(() => refresh());
}
