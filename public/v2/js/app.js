// v2 app shell: header, 5-group navigation, hash router, sign-in, toast and
// the one shared bottom sheet. Stage 1 wired Market Day (home + Event Day);
// Stage 2 adds Attendees management and the Vendors + Money screens
// (Applications, Wait List, Move Requests, Vendor Directory, Payment Log,
// Invoice Center); Stage 3a adds the unified floor-plan editor and the
// whole Setup group (Dates & Locations, Categories, Managers, Connections
// & Status with the bug-report inbox, Surveys, Archived Events, Organizer
// Tools). Sections not yet rebuilt open a "next stage" placeholder and
// keep working in the current app.
//
// Navigation is defined in exactly one place (SECTIONS below) — the legacy
// UI's 27 buttons injected by 8 files are the anti-pattern this replaces
// (audit §2, §3). Every data screen re-fetches its payload on entry and
// after every mutation: the server is the only source of truth (§1 rule 1).
import { api, fn, me, getConfig, sendSignInCode, verifySignInCode, getToken, signOut, esc, niceShort, marketName } from './api.js?v=20261022-3';
import { VERSION, STAGE } from './version.js?v=20261022-3';
import { renderHome } from './home.js?v=20261022-3';
import { renderEventDay } from './eventday.js?v=20261022-3';
import { renderAttendees } from './attendees.js?v=20261022-3';
import { renderApplications } from './applications.js?v=20261022-3';
import { renderWaitlist } from './waitlist.js?v=20261022-3';
import { renderMoves } from './moves.js?v=20261022-3';
import { renderVendors } from './vendors.js?v=20261022-3';
import { renderPayments } from './payments.js?v=20261022-3';
import { renderInvoices } from './invoices.js?v=20261022-3';
import { renderFloorEditor } from './flooredit.js?v=20261022-3';
import { renderDates, renderCategories, renderManagers, renderConnections, renderSurveys, renderArchive, renderTools } from './setup.js?v=20261022-3';

// The five groups and every section in them (audit §3.1 — every legacy
// button mapped). `live` sections render real screens in this stage.
export const GROUPS = [
  { key: 'market-day', label: 'Market Day', icon: '🎪' },
  { key: 'vendors', label: 'Vendors', icon: '👥' },
  { key: 'money', label: 'Money', icon: '💵' },
  { key: 'messages', label: 'Messages', icon: '💬' },
  { key: 'setup', label: 'Setup', icon: '⚙️' }
];
export const SECTIONS = [
  // Market Day
  { key: 'event-day', group: 'market-day', label: 'Event Day', icon: '🎪', desc: 'Run the day — check-ins, inspections, live status', live: 'event-day' },
  { key: 'attendees', group: 'market-day', label: 'Attendees', icon: '👥', desc: "Who's booked for the selected date — spaces, payments, cancellations", live: 'attendees' },
  { key: 'online-check-in', group: 'market-day', label: 'Online Check-In', icon: '📱', desc: 'Vendor setup arrival times and completion status' },
  { key: 'setup-floor-plan', group: 'market-day', label: 'Setup & Floor Plan', icon: '🗺️', desc: 'Booth layout, space assignments and the setup email — the one floor-plan editor', live: 'flooredit' },
  { key: 'shopper-rsvps', group: 'market-day', label: 'Shopper RSVPs', icon: '🎟️', desc: 'Shopper headcount for each market date' },
  // Vendors
  { key: 'applications', group: 'vendors', label: 'Applications', icon: '📝', desc: 'Review and approve new vendor applications', live: 'applications' },
  { key: 'application-recovery', group: 'vendors', label: 'Application Recovery', icon: '🛟', desc: 'Failed or abandoned application attempts' },
  { key: 'waitlist', group: 'vendors', label: 'Wait List', icon: '⏳', desc: 'Vendors waiting for a spot — offers go out automatically', live: 'waitlist' },
  { key: 'vendor-directory', group: 'vendors', label: 'Vendor Directory', icon: '📋', desc: 'Every vendor, credits, payments and history', live: 'directory' },
  { key: 'move-requests', group: 'vendors', label: 'Move Requests', icon: '⇄', desc: 'Date-change requests needing your approval', badge: 'moves', live: 'moves' },
  { key: 'manual-booking', group: 'vendors', label: 'Manual Booking', icon: '✍️', desc: 'Add a vendor by hand (PDF and paper sign-ups)' },
  { key: 'cancelled-vendors', group: 'vendors', label: 'Cancelled Vendors', icon: '↩️', desc: 'Cancelled bookings and reinstatements' },
  { key: 'banned-vendors', group: 'vendors', label: 'Banned Vendors', icon: '🚫', desc: 'Vendors blocked from booking' },
  { key: 'food-trucks', group: 'vendors', label: 'Food Trucks', icon: '🚚', desc: 'Food truck applications and approvals' },
  // Money
  { key: 'invoice-center', group: 'money', label: 'Invoice Center', icon: '🧾', desc: 'Invoices — send, track, resend', live: 'invoices' },
  { key: 'payment-log', group: 'money', label: 'Payment Log', icon: '💵', desc: 'Every payment, grouped by market date with totals', live: 'payments' },
  { key: 'monthly-billing', group: 'money', label: 'Monthly Billing', icon: '📅', desc: 'Recurring vendor billing at a glance' },
  { key: 'expenses', group: 'money', label: 'Expenses', icon: '🧮', desc: 'Market costs against what you collected' },
  { key: 'reports', group: 'money', label: 'Reports', icon: '📊', desc: 'Event reports, profit & loss, money owed' },
  // Messages
  { key: 'vendor-communications', group: 'messages', label: 'Vendor Communications', icon: '✉️', desc: 'Bulk email and announcements to vendors' },
  { key: 'live-chat', group: 'messages', label: 'Live Chat', icon: '💬', desc: 'Real-time chat with vendors and shoppers' },
  { key: 'social-media', group: 'messages', label: 'Social Media', icon: '📣', desc: 'Posts and promotion for the market' },
  // Setup
  { key: 'dates-locations', group: 'setup', label: 'Dates & Locations', icon: '📍', desc: 'Market calendar, venues, capacities and prices', live: 'dates' },
  { key: 'categories', group: 'setup', label: 'Categories', icon: '🏷️', desc: 'Vendor categories and per-category limits', live: 'categories' },
  { key: 'managers', group: 'setup', label: 'Managers', icon: '🔑', desc: 'Who else can help run the market', live: 'managers' },
  { key: 'connections', group: 'setup', label: 'Connections & Status', icon: '✓', desc: 'Email, calendar and integration status readouts', live: 'connections' },
  { key: 'surveys', group: 'setup', label: 'Surveys', icon: '⭐', desc: 'Vendor survey results', live: 'surveys' },
  { key: 'archived-events', group: 'setup', label: 'Archived Events', icon: '🗄️', desc: 'Past market dates', live: 'archive' },
  { key: 'organizer-tools', group: 'setup', label: 'Organizer Tools', icon: '🛠️', desc: 'Audit log and maintenance tools', live: 'tools' }
];
const sectionByKey = k => SECTIONS.find(s => s.key === k);
const groupOf = k => GROUPS.find(g => g.key === k);

const state = { user: null, admin: null, pendingMoves: null, route: { name: 'home' } };

const $ = s => document.querySelector(s);

// --- toast (the one feedback pattern, audit §6.3) ---------------------------
let toastTimer = 0;
function toast(msg, isError = false) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.toggle('error', !!isError);
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 3400);
}

// --- bottom sheet (the one modal system, audit §6.2/§6.4) -------------------
function openSheet(html) {
  const rootEl = $('#sheet-root');
  rootEl.innerHTML = `<div class="sheet-backdrop" data-sheet-close></div><div class="sheet" role="dialog" aria-modal="true">${html}</div>`;
  rootEl.querySelectorAll('[data-sheet-close]').forEach(el => el.onclick = closeSheet);
}
function closeSheet() { $('#sheet-root').innerHTML = ''; }

// --- navigation ---------------------------------------------------------------
function navigate(name, params = {}) {
  const qs = new URLSearchParams(params).toString();
  const target = '#/' + name + (qs ? '?' + qs : '');
  if (location.hash === target) route();
  else location.hash = target;
}
function parseHash() {
  const raw = location.hash.replace(/^#\/?/, '');
  const [path, qs] = raw.split('?');
  const params = Object.fromEntries(new URLSearchParams(qs || ''));
  if (path.startsWith('section/')) return { name: 'section', section: path.slice(8) };
  if (['event-day', 'attendees', 'applications', 'waitlist', 'directory', 'moves', 'payments', 'invoices', 'flooredit', 'dates', 'categories', 'managers', 'connections', 'surveys', 'archive', 'tools', 'vendors', 'money', 'messages', 'more'].includes(path)) return { name: path, ...params };
  return { name: 'home', ...params };
}
function bindGo(scope) {
  scope.querySelectorAll('[data-go]').forEach(b => b.onclick = () => {
    const go = b.dataset.go;
    if (go === 'event-day') navigate('event-day', { event: b.dataset.event || '' });
    else if (go === 'section') openSection(b.dataset.section);
  });
}
function openSection(key) {
  const s = sectionByKey(key);
  if (!s) return;
  if (s.live === 'event-day') navigate('event-day', { ...(s.focus ? { focus: s.focus } : {}) });
  else if (s.live) navigate(s.live);
  else navigate('section/' + key);
}

// --- chrome (header + nav) ------------------------------------------------------
function renderChrome() {
  const u = state.user;
  const next = state.admin?.events?.[0];
  $('#app-head').innerHTML = `
    <div class="wrap head-wrap">
      <div class="brand">
        <div class="brand-mark">T</div>
        <div><h1>Trinity Crafters Market</h1>
        <p>${next ? 'Next market · ' + esc(niceShort(next.date)) + ' · ' + esc(marketName(next)) : 'Organizer view'}</p></div>
      </div>
      ${u ? `<div class="head-user"><span class="head-email">${esc(u.email)}</span><button class="btn small ghost-light" id="v2-signout">Sign out</button></div>` : ''}
    </div>`;
  const out = $('#v2-signout');
  if (out) out.onclick = () => { signOut(); state.user = null; state.admin = null; boot(); };

  const tabs = [
    { name: 'home', label: 'Market Day', icon: '🎪', routeNames: ['home', 'event-day'] },
    { name: 'vendors', label: 'Vendors', icon: '👥', badge: state.pendingMoves || 0 },
    { name: 'money', label: 'Money', icon: '💵' },
    { name: 'messages', label: 'Messages', icon: '💬' },
    { name: 'more', label: 'More', icon: '☰' }
  ];
  // Stage-2 screens are their own routes; map them back to their group tab.
  const routeTab = { attendees: 'home', flooredit: 'home', applications: 'vendors', waitlist: 'vendors', directory: 'vendors', moves: 'vendors', payments: 'money', invoices: 'money', dates: 'more', categories: 'more', managers: 'more', connections: 'more', surveys: 'more', archive: 'more', tools: 'more' };
  const activeFor = t => t.routeNames ? t.routeNames.includes(state.route.name) : state.route.name === t.name || (state.route.name === 'section' && sectionByKey(state.route.section)?.group === t.name) || routeTab[state.route.name] === t.name;
  const navHtml = tabs.map(t => `<button class="nav-item ${activeFor(t) ? 'active' : ''}" data-nav="${t.name}"><span class="ti">${t.icon}</span><span class="nav-label">${t.label}</span>${t.badge ? `<span class="tab-badge">${t.badge}</span>` : ''}</button>`).join('');
  $('#tabbar').innerHTML = `<div class="tabbar-inner">${navHtml}</div>`;
  $('#sidenav').innerHTML = `<div class="side-brand"><div class="brand-mark">T</div><div><strong>Trinity</strong><span>Crafters Market</span></div></div>${navHtml}<div class="side-foot">New organizer app · ${STAGE}<br>build ${VERSION}</div>`;
  document.querySelectorAll('[data-nav]').forEach(b => b.onclick = () => navigate(b.dataset.nav === 'home' ? '' : b.dataset.nav));
}

// --- screens rendered by the shell itself ---------------------------------------
function groupScreen(root, groupKey) {
  const g = groupOf(groupKey);
  const items = SECTIONS.filter(s => s.group === groupKey);
  root.innerHTML = `
    <p class="eyebrow">${esc(g.label)}</p>
    <h2 class="display">${esc(g.label)}</h2>
    <p class="lede">${groupKey === 'market-day' ? 'The day-of tools live on the Market Day home and Event Day screens.' : 'Sections open in the new app as their stage lands. Anything not rebuilt yet keeps working in the current app.'}</p>
    <div class="card group-card">${items.map(s => menuItem(s)).join('')}</div>`;
  bindGo(root);
  bindMenu(root);
}
function menuItem(s) {
  const badge = s.badge === 'moves' && state.pendingMoves ? `<span class="tab-badge static">${state.pendingMoves}</span>` : '';
  return `<button class="menu-item" data-menu="${esc(s.key)}"><span class="mi-icon">${s.icon}</span><span><b>${esc(s.label)}</b><span>${esc(s.desc)}</span></span>${badge}<span class="chev">›</span></button>`;
}
function bindMenu(root) {
  root.querySelectorAll('[data-menu]').forEach(b => b.onclick = () => openSection(b.dataset.menu));
}
function moreScreen(root) {
  root.innerHTML = `
    <p class="eyebrow">All tools</p>
    <h2 class="display">Menu</h2>
    <p class="lede">27 loose buttons become 5 groups. Market Day, Vendors, Money and Setup are live in the new app; Messages arrives in the next stage and keeps working in the current app meanwhile.</p>
    ${GROUPS.map(g => `<div class="group"><h3>${esc(g.label)}</h3><div class="card group-card">${SECTIONS.filter(s => s.group === g.key).map(s => menuItem(s)).join('')}</div></div>`).join('')}
    <div class="card account-card">
      <p><strong>Signed in as ${esc(state.user.email)}</strong><br><span class="muted">${state.user.admin ? 'Organizer' : 'Manager'} · the new app and the current app share this sign-in.</span></p>
      <div class="vendor-actions">
        <a class="btn small" href="/">Open the current app</a>
        <button class="btn small ghost" id="v2-signout-2">Sign out</button>
      </div>
      <p class="note">Trinity Crafters Market — new organizer app · ${STAGE} · build ${VERSION}</p>
    </div>`;
  bindMenu(root);
  const out = $('#v2-signout-2');
  if (out) out.onclick = () => { signOut(); state.user = null; state.admin = null; boot(); };
}
function sectionScreen(root, key) {
  const s = sectionByKey(key);
  if (!s) { root.innerHTML = '<p class="lede">That section does not exist.</p>'; return; }
  const g = groupOf(s.group);
  root.innerHTML = `
    <p class="eyebrow">${esc(g.label)}</p>
    <h2 class="display">${esc(s.label)}</h2>
    <p class="lede">${esc(s.desc)}.</p>
    <div class="card empty-card">
      <p><strong>Coming in the next stage of the rebuild.</strong></p>
      <p class="muted">This section is being rebuilt with the same rules as Market Day — server-fresh data, one screen per job, no patch layers. Nothing is missing in the meantime: it works exactly as today in the current app.</p>
      <div class="vendor-actions">
        <a class="btn primary small" href="/#admin">Open it in the current app</a>
        <button class="btn small" data-go-home>Back to Market Day</button>
      </div>
    </div>`;
  root.querySelector('[data-go-home]').onclick = () => navigate('');
}
function roleNotice(root, kind) {
  root.innerHTML = `
    <p class="eyebrow">New organizer app · ${STAGE}</p>
    <h2 class="display">${kind === 'manager' ? 'Manager workspace is on its way' : 'This preview is organizer-only'}</h2>
    <p class="lede">${kind === 'manager'
      ? 'Stage 1 covers the organizer\'s Market Day screens. The manager workspace — the same screens, scoped to your permissions — arrives in a later stage. Your current workspace is unchanged.'
      : 'Stage 1 is the organizer\'s Market Day workspace. Your bookings, online check-in and profile all stay in the current app for now.'}</p>
    <div class="card empty-card"><div class="vendor-actions">
      <a class="btn primary small" href="${kind === 'manager' ? '/#admin' : '/#account'}">Continue in the current app</a>
      <button class="btn small ghost" id="v2-signout-3">Sign out</button>
    </div></div>`;
  $('#v2-signout-3').onclick = () => { signOut(); state.user = null; state.admin = null; boot(); };
}

// --- sign-in (same email-code flow as the current app) ---------------------------
function signInScreen(root) {
  $('#app-head').innerHTML = `<div class="wrap head-wrap"><div class="brand"><div class="brand-mark">T</div><div><h1>Trinity Crafters Market</h1><p>New organizer app · ${STAGE}</p></div></div></div>`;
  $('#tabbar').innerHTML = '';
  $('#sidenav').innerHTML = '';
  root.innerHTML = `
    <section class="card signin-card">
      <p class="eyebrow">Organizer access</p>
      <h2 class="display">Welcome back.</h2>
      <p class="lede">Sign in with a code sent to your email — the same sign-in as the current app, so if you're signed in there you may already be signed in here.</p>
      <form id="v2-login">
        <label class="sheet-field">Email address<input name="email" type="email" required autocomplete="email" placeholder="you@example.com"></label>
        <button class="btn primary btn-block">Email my sign-in code</button>
      </form>
      <form id="v2-verify" hidden>
        <label class="sheet-field">Email verification code<input name="code" inputmode="numeric" autocomplete="one-time-code" required placeholder="123456"></label>
        <button class="btn primary btn-block">Verify &amp; sign in</button>
      </form>
      <p class="note" id="v2-login-note"></p>
      <p class="note">Just looking? <a href="/">Open the current app</a> — nothing there has changed.</p>
    </section>`;
  const note = msg => { root.querySelector('#v2-login-note').textContent = msg; };
  let email = '';
  root.querySelector('#v2-login').onsubmit = async e => {
    e.preventDefault();
    email = new FormData(e.target).get('email');
    try {
      await sendSignInCode(email);
      root.querySelector('#v2-verify').hidden = false;
      note('Check your email for your sign-in code.');
    } catch (err) { note(err.message); }
  };
  root.querySelector('#v2-verify').onsubmit = async e => {
    e.preventDefault();
    try {
      await verifySignInCode(email, new FormData(e.target).get('code'));
      note('Signed in.');
      boot();
    } catch (err) { note(err.message); }
  };
}

// --- data loading ------------------------------------------------------------------
async function refreshAdmin() {
  state.admin = await api('admin');
  // Pending move requests power the Vendors badge; the list action requires
  // the moves:approve permission, so a failure just means no badge.
  try {
    const r = await fn('move-requests', { action: 'list' });
    state.pendingMoves = typeof r.pending === 'number' ? r.pending : null;
  } catch { state.pendingMoves = null; }
}

const ctx = {
  state,
  toast,
  openSheet,
  closeSheet,
  navigate,
  bindGo,
  refreshAdmin: async () => { await refreshAdmin(); renderChrome(); }
};
Object.defineProperty(ctx, 'sheetEl', { get: () => document.querySelector('#sheet-root .sheet') });

// --- router ---------------------------------------------------------------------------
async function route() {
  const r = parseHash();
  state.route = r;
  const root = $('#screen');
  renderChrome();
  try {
    if (r.name === 'home') { await refreshAdmin(); renderChrome(); renderHome(ctx, root); }
    else if (r.name === 'event-day') { await refreshAdmin(); renderChrome(); renderEventDay(ctx, root, r); }
    else if (r.name === 'attendees') { await refreshAdmin(); renderChrome(); renderAttendees(ctx, root, r); }
    else if (r.name === 'applications') { await refreshAdmin(); renderChrome(); renderApplications(ctx, root); }
    else if (r.name === 'waitlist') { await refreshAdmin(); renderChrome(); renderWaitlist(ctx, root); }
    else if (r.name === 'moves') { renderMoves(ctx, root); }
    else if (r.name === 'directory') { await refreshAdmin(); renderChrome(); renderVendors(ctx, root); }
    else if (r.name === 'payments') { await refreshAdmin(); renderChrome(); renderPayments(ctx, root); }
    else if (r.name === 'invoices') { await refreshAdmin(); renderChrome(); renderInvoices(ctx, root); }
    else if (r.name === 'flooredit') { await refreshAdmin(); renderChrome(); renderFloorEditor(ctx, root, r); }
    else if (r.name === 'dates') { await refreshAdmin(); renderChrome(); renderDates(ctx, root); }
    else if (r.name === 'categories') { await refreshAdmin(); renderChrome(); renderCategories(ctx, root); }
    else if (r.name === 'managers') { renderManagers(ctx, root); }
    else if (r.name === 'connections') { await refreshAdmin(); renderChrome(); renderConnections(ctx, root); }
    else if (r.name === 'surveys') { renderSurveys(ctx, root); }
    else if (r.name === 'archive') { await refreshAdmin(); renderChrome(); renderArchive(ctx, root); }
    else if (r.name === 'tools') { renderTools(ctx, root); }
    else if (['vendors', 'money', 'messages'].includes(r.name)) groupScreen(root, r.name);
    else if (r.name === 'more') moreScreen(root);
    else if (r.name === 'section') sectionScreen(root, r.section);
    else renderHome(ctx, root);
  } catch (e) {
    root.innerHTML = `<div class="card empty-card"><h3>Something went wrong loading this screen.</h3><p class="muted">${esc(e.message)}</p><div class="vendor-actions"><button class="btn small" onclick="location.reload()">Reload</button><a class="btn small" href="/">Open the current app</a></div></div>`;
  }
  window.scrollTo(0, 0);
}

async function boot() {
  const root = $('#screen');
  $('#sheet-root').innerHTML = '';
  if (!getToken()) { state.user = null; signInScreen(root); return; }
  try {
    state.user = await me();
  } catch {
    signOut();
    state.user = null;
    signInScreen(root);
    return;
  }
  if (state.user.admin) {
    try { await refreshAdmin(); } catch (e) { toast(e.message, true); }
    renderChrome();
    route();
  } else {
    renderChrome();
    // Stage 1 has no workspace for this role yet — hide the organizer nav
    // so nothing on screen is a dead button.
    $('#tabbar').innerHTML = '';
    $('#sidenav').innerHTML = '';
    roleNotice(root, state.user.manager ? 'manager' : 'vendor');
  }
}

window.addEventListener('hashchange', () => { if (state.user?.admin) route(); });
getConfig(); // warm the OTP config so the sign-in form answers fast
boot();
