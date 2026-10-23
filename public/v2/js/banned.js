// Banned Vendors: the private organizer ban list. Native v2 port of the
// classic Banned vendors tab — same admin-payload `bans` rows, same 'ban'
// action: toggling flips `active` (unban / reapply ban; reapplying
// re-sends the notification email server-side), and the add form creates
// a new ban exactly like the classic ban form (name required, email or
// phone required by the server, private reason, notification emailed
// when an address is available).
import { api, esc } from './api.js?v=20261023-9';

export function renderBanned(ctx, root) {
  root.innerHTML = `
    <p class="eyebrow">Vendors</p>
    <h2 class="display">Banned Vendors</h2>
    <p class="lede">Private organizer records. Bans block vendor access and new applications. Existing bookings require separate review.</p>
    <div class="vendor-actions"><button class="btn primary small" id="v2-ban-add">Add banned vendor</button></div>
    <div id="v2-ban-list"></div>`;

  const bans = () => ctx.state.admin?.bans || [];
  const mutate = async (call, okMsg) => {
    try {
      await call();
      await ctx.refreshAdmin();
      draw();
      if (okMsg) ctx.toast(okMsg);
    } catch (e) { ctx.toast(e.message, true); }
  };

  function banSheet() {
    ctx.openSheet(`
      <h3 class="sheet-title">Ban vendor</h3>
      <p class="note">The reason stays private. A ban notification will be emailed if an email address is available. Review existing bookings separately.</p>
      <form id="v2-ban-form">
        <label class="sheet-field">Vendor name<input name="name" required></label>
        <label class="sheet-field">Email<input name="email" type="email"></label>
        <label class="sheet-field">Phone<input name="phone"></label>
        <label class="sheet-field">Private reason / notes<textarea name="reason" rows="3" maxlength="2000" required></textarea></label>
        <div class="sheet-actions"><button type="button" class="btn" data-sheet-close>Cancel</button><button class="btn danger">Ban vendor</button></div>
      </form>`);
    ctx.sheetEl.querySelector('#v2-ban-form').onsubmit = e => {
      e.preventDefault();
      const f = Object.fromEntries(new FormData(e.target));
      ctx.closeSheet();
      mutate(() => api('ban', { ...f }), 'Vendor banned.');
    };
  }

  function draw() {
    const list = bans();
    const listEl = root.querySelector('#v2-ban-list');
    listEl.innerHTML = `<div class="vendor-list">${list.map(b => `
      <article class="card vendor">
        <div class="vendor-top">
          <div><h3>${esc(b.name || 'Vendor')}</h3>
          <div class="contact">${esc(b.email || '')}${b.phone ? ' · ' + esc(b.phone) : ''}</div></div>
          <span class="status ${b.active ? 'bad' : 'neutral'}">${b.active ? 'Banned' : 'Unbanned'}</span>
        </div>
        <p class="note">${esc(b.reason || '')}</p>
        <div class="vendor-actions"><button class="btn small" data-toggle="${esc(b.id)}">${b.active ? 'Unban' : 'Reapply ban'}</button></div>
      </article>`).join('') || '<div class="card empty-card">No banned vendors.</div>'}</div>`;
    listEl.querySelectorAll('[data-toggle]').forEach(btn => btn.onclick = () => {
      const b = bans().find(x => String(x.id) === String(btn.dataset.toggle));
      if (!b) { ctx.toast('That ban record is no longer in the list — reloading.', true); ctx.refreshAdmin().then(draw); return; }
      mutate(() => api('ban', { id: b.id, active: !b.active }), b.active ? 'Ban lifted.' : 'Ban reapplied.');
    });
  }

  root.querySelector('#v2-ban-add').onclick = banSheet;
  draw();
}
