// Registered Users: who actually has an app account — the opposite
// view of the Vendor Directory, which lists vendor RECORDS (including
// PDF imports who may never have registered). Data comes from the
// organizer-only 'registered-users' action: Supabase Auth accounts
// linked back to their vendor records, plus the flip side — vendor
// emails with no account yet, the follow-up list for invitations.
// Read-only: v1 has no actions, only the two lists and the counts.
import { api, esc } from './api.js?v=20261023-16';

let view = { q: '', tab: 'registered' };
let payload = null;

// Account timestamps are full ISO instants (not market dates); show
// the calendar day in the market's timezone.
const dayOf = ts => ts ? new Date(ts).toLocaleDateString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', year: 'numeric' }) : '';
const matches = (r, q) => !q || [r.business, r.name, r.email].some(x => String(x || '').toLowerCase().includes(q));

function registeredCard(r) {
  const title = r.business || r.name || 'App account';
  const contact = [r.business && r.name ? r.name : '', r.email].filter(Boolean).join(' · ');
  const badges = [
    r.organizer ? '<span class="badge inside">Organizer</span>' : '',
    r.staff ? '<span class="badge outside">Staff</span>' : '',
    r.has_vendor_record ? '' : '<span class="badge outside">No vendor record</span>'
  ].filter(Boolean).join('');
  return `<article class="card vendor">
    <div class="vendor-top">
      <div><h3>${esc(title)}</h3>
      <div class="contact">${esc(contact)}</div></div>
      <span class="status ok">Registered</span>
    </div>
    <p class="note"><strong>Registered:</strong> ${esc(dayOf(r.registered_at) || 'Date not recorded')}<br><strong>Last sign-in:</strong> ${r.last_sign_in_at ? esc(dayOf(r.last_sign_in_at)) : 'Never'}</p>
    ${badges ? `<div class="chips">${badges}</div>` : ''}
  </article>`;
}

function notRegisteredCard(r) {
  const title = r.business || r.name || 'Vendor';
  const contact = [r.business && r.name ? r.name : '', r.email].filter(Boolean).join(' · ');
  return `<article class="card vendor">
    <div class="vendor-top">
      <div><h3>${esc(title)}</h3>
      <div class="contact">${esc(contact)}</div></div>
      <span class="status neutral">No account yet</span>
    </div>
    <p class="note">We have this vendor on file, but no app account for ${esc(r.email)} yet — they still need the download email or an invitation to register.</p>
  </article>`;
}

export function renderRegistered(ctx, root) {
  view = { q: '', tab: 'registered' };
  payload = null;
  root.innerHTML = `
    <p class="eyebrow">Vendors</p>
    <h2 class="display">Registered Users</h2>
    <p class="lede">Everyone who actually has an app account, linked to their vendor record — and the vendors who haven't registered yet. The Vendor Directory lists records; this lists people with sign-ins.</p>
    <div id="v2-reg-summary"><div class="card empty-card">Loading accounts…</div></div>
    <div class="card filter-card">
      <div class="search"><input id="v2-reg-search" type="search" placeholder="Business, name or email" autocomplete="off"></div>
      <div class="chips" role="group" aria-label="Account lists">
        <button class="chip-btn" data-reg-tab="registered">Registered</button>
        <button class="chip-btn" data-reg-tab="not">Not registered yet</button>
      </div>
    </div>
    <div id="v2-reg-list"></div>`;

  function draw() {
    const listEl = root.querySelector('#v2-reg-list');
    if (!payload) { listEl.innerHTML = ''; return; }
    root.querySelectorAll('[data-reg-tab]').forEach(b => b.classList.toggle('active', b.dataset.regTab === view.tab));
    const isReg = view.tab === 'registered';
    const source = isReg ? payload.registered : payload.not_registered;
    const rows = source.filter(r => matches(r, view.q));
    const empty = view.q
      ? '<div class="card empty-card">No accounts match your search.</div>'
      : isReg
        ? '<div class="card empty-card">No app accounts yet — when a vendor registers, they will show up here.</div>'
        : '<div class="card empty-card">Every vendor with an email on file has registered. 🎉</div>';
    listEl.innerHTML = `<div class="vendor-list">${rows.map(isReg ? registeredCard : notRegisteredCard).join('') || empty}</div>
      <p class="note">${rows.length} of ${source.length} ${isReg ? 'registered account' : 'unregistered vendor'}${source.length === 1 ? '' : 's'} shown.</p>`;
  }

  function drawSummary() {
    const c = payload.counts;
    root.querySelector('#v2-reg-summary').innerHTML = `
      <div class="stat-grid">
        <div class="stat"><b>${c.registered} registered</b><span>App accounts</span></div>
        <div class="stat"><b>${c.with_vendor_record} linked</b><span>Accounts matched to a vendor record</span></div>
        <div class="stat"><b>${c.not_registered} not yet registered</b><span>Vendors with no app account</span></div>
      </div>`;
  }

  root.querySelector('#v2-reg-search').oninput = e => { view.q = e.target.value.trim().toLowerCase(); draw(); };
  root.querySelectorAll('[data-reg-tab]').forEach(b => b.onclick = () => { view.tab = b.dataset.regTab; draw(); });

  api('registered-users').then(r => {
    payload = r;
    drawSummary();
    draw();
  }).catch(e => {
    root.querySelector('#v2-reg-summary').innerHTML = `<div class="card empty-card"><p><strong>Accounts couldn't load.</strong></p><p class="muted">${esc(e.message)}</p></div>`;
    root.querySelector('#v2-reg-list').innerHTML = '';
  });
}
