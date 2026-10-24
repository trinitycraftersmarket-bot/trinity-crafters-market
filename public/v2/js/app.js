// v2 app shell: header, role-aware navigation, hash router, sign-in, toast
// and the one shared bottom sheet. Stage 1 wired Market Day (home + Event
// Day); Stage 2 adds Attendees management and the Vendors + Money screens
// (Applications, Wait List, Move Requests, Vendor Directory, Payment Log,
// Invoice Center); Stage 3a adds the unified floor-plan editor and the
// whole Setup group (Dates & Locations, Categories, Managers, Connections
// & Status with the bug-report inbox, Surveys, Archived Events, Organizer
// Tools). Stage 3b completes the rebuild: the Messages group (Vendor
// Communications, Vendor Messages, Live Chat, Social Media), Shopper
// RSVPs, the vendor side of the same shell (Home / My Bookings / Apply /
// My Profile / Messages), and manager-scoped views that replace the old
// role notice — staff see the organizer shell limited to their permitted
// sections. Sections never rebuilt open a placeholder and keep working
// in the current app.
//
// Navigation is defined in exactly one place (SECTIONS below) — the legacy
// UI's 27 buttons injected by 8 files are the anti-pattern this replaces
// (audit §2, §3). Every data screen re-fetches its payload on entry and
// after every mutation: the server is the only source of truth (§1 rule 1).
import { api, fn, me, getConfig, sendSignInCode, verifySignInCode, getToken, signOut, esc, niceShort, marketName, todayKey } from './api.js?v=20261023-17';
import { VERSION, STAGE } from './version.js?v=20261023-17';
import { renderHome } from './home.js?v=20261023-17';
import { renderEventDay } from './eventday.js?v=20261023-17';
import { renderAttendees } from './attendees.js?v=20261023-17';
import { renderApplications } from './applications.js?v=20261023-17';
import { renderWaitlist } from './waitlist.js?v=20261023-17';
import { renderMoves } from './moves.js?v=20261023-17';
import { renderVendors } from './vendors.js?v=20261023-17';
import { renderPayments } from './payments.js?v=20261023-17';
import { renderInvoices } from './invoices.js?v=20261023-17';
import { renderFloorEditor } from './flooredit.js?v=20261023-17';
import { renderDates, renderCategories, renderManagers, renderConnections, renderSurveys, renderArchive, renderTools } from './setup.js?v=20261023-17';
import { renderComms } from './comms.js?v=20261023-17';
import { renderThreads } from './threads.js?v=20261023-17';
import { renderChatAdmin, renderChatVendor } from './chat.js?v=20261023-17';
import { renderSocial } from './social.js?v=20261023-17';
import { renderRsvps } from './rsvps.js?v=20261023-17';
import { renderVendorHome, renderVendorBookings, renderVendorApply, renderVendorProfile } from './vendor.js?v=20261023-17';
import { renderManagerHome, renderManagerEventDay, renderManagerApplications, renderManagerFloor, managerSections, managerCan } from './manager.js?v=20261023-17';
import { renderManualBooking } from './manualbooking.js?v=20261023-17';
import { renderCancelled } from './cancelled.js?v=20261023-17';
import { renderBanned } from './banned.js?v=20261023-17';
import { renderRegistered } from './registered.js?v=20261023-17';
import { renderFoodTrucks } from './foodtrucks.js?v=20261023-17';
import { renderFoodTruckApply } from './trucksapply.js?v=20261023-17';
import { renderCheckin } from './checkin.js?v=20261023-17';
import { renderAppRecovery } from './apprecovery.js?v=20261023-17';
import { renderBilling } from './billing.js?v=20261023-17';
import { renderExpenses } from './expenses.js?v=20261023-17';
import { renderReports } from './reports.js?v=20261023-17';

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
  { key: 'online-check-in', group: 'market-day', label: 'Online Check-In', icon: '📱', desc: 'Vendor setup arrival times and completion status', live: 'checkin' },
  { key: 'setup-floor-plan', group: 'market-day', label: 'Setup & Floor Plan', icon: '🗺️', desc: 'Booth layout, space assignments and the setup email — the one floor-plan editor', live: 'flooredit' },
  { key: 'shopper-rsvps', group: 'market-day', label: 'Shopper RSVPs', icon: '🎟️', desc: 'Shopper headcount for each market date', live: 'rsvps' },
  // Vendors
  { key: 'applications', group: 'vendors', label: 'Applications', icon: '📝', desc: 'Review and approve new vendor applications', live: 'applications' },
  { key: 'application-recovery', group: 'vendors', label: 'Application Recovery', icon: '🛟', desc: 'Failed or abandoned application attempts', live: 'apprecovery' },
  { key: 'waitlist', group: 'vendors', label: 'Wait List', icon: '⏳', desc: 'Vendors waiting for a spot — offers go out automatically', live: 'waitlist' },
  { key: 'vendor-directory', group: 'vendors', label: 'Vendor Directory', icon: '📋', desc: 'Every vendor, credits, payments and history', live: 'directory' },
  { key: 'registered-users', group: 'vendors', label: 'Registered Users', icon: '🔐', desc: "App accounts linked to vendor records — plus vendors who haven't registered yet", live: 'registered' },
  { key: 'move-requests', group: 'vendors', label: 'Move Requests', icon: '⇄', desc: 'Date-change requests needing your approval', badge: 'moves', live: 'moves' },
  { key: 'manual-booking', group: 'vendors', label: 'Manual Booking', icon: '✍️', desc: 'Add a vendor by hand (PDF and paper sign-ups)', live: 'manualbooking' },
  { key: 'cancelled-vendors', group: 'vendors', label: 'Cancelled Vendors', icon: '↩️', desc: 'Cancelled bookings and reinstatements', live: 'cancelled' },
  { key: 'banned-vendors', group: 'vendors', label: 'Banned Vendors', icon: '🚫', desc: 'Vendors blocked from booking', live: 'banned' },
  { key: 'food-trucks', group: 'vendors', label: 'Food Trucks', icon: '🚚', desc: 'One $35 food truck spot per market date', live: 'foodtrucks' },
  // Money
  { key: 'invoice-center', group: 'money', label: 'Invoice Center', icon: '🧾', desc: 'Invoices — send, track, resend', live: 'invoices' },
  { key: 'payment-log', group: 'money', label: 'Payment Log', icon: '💵', desc: 'Every payment, grouped by market date with totals', live: 'payments' },
  { key: 'monthly-billing', group: 'money', label: 'Monthly Billing', icon: '📅', desc: 'Recurring vendor billing at a glance', live: 'billing' },
  { key: 'expenses', group: 'money', label: 'Expenses', icon: '🧮', desc: 'Market costs against what you collected', live: 'expenses' },
  { key: 'reports', group: 'money', label: 'Reports', icon: '📊', desc: 'Event reports, profit & loss, money owed', live: 'reports' },
  // Messages
  { key: 'vendor-communications', group: 'messages', label: 'Vendor Communications', icon: '✉️', desc: 'Bulk email and announcements to vendors', live: 'comms' },
  { key: 'vendor-messages', group: 'messages', label: 'Vendor Messages', icon: '🧵', desc: 'Per-application message threads with vendors', live: 'threads' },
  { key: 'live-chat', group: 'messages', label: 'Live Chat', icon: '💬', desc: 'Real-time chat with vendors and shoppers', live: 'chat' },
  { key: 'social-media', group: 'messages', label: 'Social Media', icon: '📣', desc: 'Posts and promotion for the market', live: 'social' },
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

const state = {
  user: null, admin: null, pendingMoves: null, route: { name: 'home' },
  // Stage 3b role payloads: the manager payload + permission list for
  // staff, and the vendor's own rows / move requests / credits / public
  // application data for vendors.
  manager: null, permissions: [],
  vendorRows: null, vendorMoves: [], credits: null, publicData: null, vendorProfile: null
};

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
// Legacy hash aliases (audit §20 Stage H — permanent): the classic app
// and years of server-sent email link to /#admin, /#account and /#apply.
// They deep-link to the v2 equivalents instead of falling back to home.
const HASH_ALIASES = { admin: 'home', account: 'vbookings', apply: 'vapply' };
function parseHash() {
  const raw = location.hash.replace(/^#\/?/, '');
  const [path, qs] = raw.split('?');
  const params = Object.fromEntries(new URLSearchParams(qs || ''));
  if (HASH_ALIASES[path]) return { name: HASH_ALIASES[path], ...params };
  if (path.startsWith('section/')) return { name: 'section', section: path.slice(8) };
  if (['event-day', 'attendees', 'applications', 'waitlist', 'directory', 'moves', 'payments', 'invoices', 'flooredit', 'dates', 'categories', 'managers', 'connections', 'surveys', 'archive', 'tools', 'vendors', 'money', 'messages', 'more',
    'rsvps', 'comms', 'threads', 'chat', 'social', 'manualbooking', 'cancelled', 'banned', 'foodtrucks', 'checkin', 'apprecovery', 'billing', 'expenses', 'reports', 'vtrucks', 'registered',
    'mhome', 'meventday', 'mattendees', 'mapplications', 'mwaitlist', 'mrsvps', 'mmoves', 'mthreads', 'mchat', 'mfloor', 'mmore',
    'vhome', 'vbookings', 'vapply', 'vprofile', 'vmessages', 'vthreads', 'vmore'].includes(path)) return { name: path, ...params };
  return { name: 'home', ...params };
}
function bindGo(scope) {
  scope.querySelectorAll('[data-go]').forEach(b => b.onclick = () => {
    const go = b.dataset.go;
    if (go === 'event-day') navigate('event-day', { event: b.dataset.event || '' });
    else if (go === 'section') openSection(b.dataset.section);
    else if (go) navigate(go);
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
// One shell, three role shapes (Stage 3b): the organizer gets the five
// groups; a manager gets Home + their permitted sections; a vendor gets
// Home / My Bookings / Apply / Messages / More. Nothing renders a tab
// the signed-in role cannot open.
const roleOf = () => state.user?.admin ? 'admin' : state.user?.manager ? 'manager' : 'vendor';
const todayStr = () => new Date().toLocaleDateString('en-CA');

function resetSession() {
  signOut();
  state.user = null; state.admin = null; state.manager = null; state.permissions = [];
  state.vendorRows = null; state.vendorMoves = []; state.credits = null; state.publicData = null;
  boot();
}

function renderChrome() {
  const u = state.user;
  if (!u) return;
  const role = roleOf();
  let subtitle = 'Organizer view';
  if (role === 'manager') {
    const next = (state.manager?.events || []).filter(e => String(e.date) >= todayStr()).sort((a, b) => String(a.date).localeCompare(String(b.date)))[0];
    subtitle = next ? 'Next market · ' + esc(niceShort(next.date)) + ' · ' + esc(marketName(next)) : 'Staff view';
  } else if (role === 'vendor') {
    const next = (state.vendorRows || []).filter(r => ['approved', 'paid', 'held'].includes(String(r.status)) && String(r.date) >= todayStr()).sort((a, b) => String(a.date).localeCompare(String(b.date)))[0];
    subtitle = next ? 'Your next market · ' + esc(niceShort(next.date)) + (next.location ? ' · ' + esc(next.location) : '') : 'Vendor view';
  } else {
    const next = state.admin?.events?.[0];
    subtitle = next ? 'Next market · ' + esc(niceShort(next.date)) + ' · ' + esc(marketName(next)) : 'Organizer view';
  }
  $('#app-head').innerHTML = `
    <div class="wrap head-wrap">
      <div class="brand">
        <div class="brand-mark">T</div>
        <div><h1>Trinity Crafters Market</h1>
        <p>${subtitle}</p></div>
      </div>
      <div class="head-user"><span class="head-email">${esc(u.email)}</span><button class="btn small ghost-light" id="v2-signout">Sign out</button></div>
    </div>`;
  const out = $('#v2-signout');
  if (out) out.onclick = resetSession;

  let tabs, activeFor, homeTarget = '';
  if (role === 'admin') {
    tabs = [
      { name: 'home', label: 'Market Day', icon: '🎪', routeNames: ['home', 'event-day'] },
      { name: 'vendors', label: 'Vendors', icon: '👥', badge: state.pendingMoves || 0 },
      { name: 'money', label: 'Money', icon: '💵' },
      { name: 'messages', label: 'Messages', icon: '💬' },
      { name: 'more', label: 'More', icon: '☰' }
    ];
    // Screens are their own routes; map them back to their group tab.
    const routeTab = { attendees: 'home', flooredit: 'home', rsvps: 'home', applications: 'vendors', waitlist: 'vendors', directory: 'vendors', registered: 'vendors', moves: 'vendors', manualbooking: 'vendors', cancelled: 'vendors', banned: 'vendors', foodtrucks: 'vendors', apprecovery: 'vendors', checkin: 'home', payments: 'money', invoices: 'money', billing: 'money', expenses: 'money', reports: 'money', dates: 'more', categories: 'more', managers: 'more', connections: 'more', surveys: 'more', archive: 'more', tools: 'more', comms: 'messages', threads: 'messages', chat: 'messages', social: 'messages' };
    activeFor = t => t.routeNames ? t.routeNames.includes(state.route.name) : state.route.name === t.name || (state.route.name === 'section' && sectionByKey(state.route.section)?.group === t.name) || routeTab[state.route.name] === t.name;
  } else if (role === 'manager') {
    const sections = managerSections({ state });
    const icons = { meventday: '🎪', mapplications: '📝', mwaitlist: '⏳', mattendees: '👥', mrsvps: '🎟️', mmoves: '⇄', mthreads: '🧵', mchat: '💬', mfloor: '🗺️' };
    tabs = [
      { name: 'mhome', label: 'Home', icon: '🎪', routeNames: ['mhome', 'home'] },
      ...sections.slice(0, 3).map(s => ({ name: s.id, label: s.label, icon: icons[s.id] || '•' })),
      { name: 'mmore', label: 'More', icon: '☰' }
    ];
    const extra = sections.slice(3).map(s => s.id);
    activeFor = t => t.routeNames ? t.routeNames.includes(state.route.name) : state.route.name === t.name || (t.name === 'mmore' && (state.route.name === 'mmore' || extra.includes(state.route.name)));
    homeTarget = 'mhome';
  } else {
    tabs = [
      { name: 'vhome', label: 'Home', icon: '🏠', routeNames: ['vhome', 'home'] },
      { name: 'vbookings', label: 'Bookings', icon: '🎪' },
      { name: 'vapply', label: 'Apply', icon: '📝' },
      { name: 'vmessages', label: 'Messages', icon: '💬' },
      { name: 'vmore', label: 'More', icon: '☰', routeNames: ['vmore', 'vprofile', 'vthreads'] }
    ];
    activeFor = t => t.routeNames ? t.routeNames.includes(state.route.name) : state.route.name === t.name;
    homeTarget = 'vhome';
  }
  const navHtml = tabs.map(t => `<button class="nav-item ${activeFor(t) ? 'active' : ''}" data-nav="${t.name}"><span class="ti">${t.icon}</span><span class="nav-label">${t.label}</span>${t.badge ? `<span class="tab-badge">${t.badge}</span>` : ''}</button>`).join('');
  $('#tabbar').innerHTML = `<div class="tabbar-inner">${navHtml}</div>`;
  $('#sidenav').innerHTML = `<div class="side-brand"><div class="brand-mark">T</div><div><strong>Trinity</strong><span>Crafters Market</span></div></div>${navHtml}<div class="side-foot">New ${role === 'admin' ? 'organizer' : role} app · ${STAGE}<br>build ${VERSION}</div>`;
  document.querySelectorAll('[data-nav]').forEach(b => b.onclick = () => navigate(b.dataset.nav === 'home' ? homeTarget : b.dataset.nav));
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
    <p class="lede">27 loose buttons become 5 groups — and with the full port complete, every section now opens natively in the new app.</p>
    ${GROUPS.map(g => `<div class="group"><h3>${esc(g.label)}</h3><div class="card group-card">${SECTIONS.filter(s => s.group === g.key).map(s => menuItem(s)).join('')}</div></div>`).join('')}
    <div class="card account-card">
      <p><strong>Signed in as ${esc(state.user.email)}</strong><br><span class="muted">${state.user.admin ? 'Organizer' : 'Manager'} · the new app and the current app share this sign-in.</span></p>
      <div class="vendor-actions">
        <a class="btn small" href="/classic/">Open the classic app</a>
        <button class="btn small ghost" id="v2-signout-2">Sign out</button>
      </div>
      <p class="note">Trinity Crafters Market — new organizer app · ${STAGE} · build ${VERSION}</p>
    </div>`;
  bindMenu(root);
  const out = $('#v2-signout-2');
  if (out) out.onclick = resetSession;
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
        <a class="btn primary small" href="/classic/#admin">Open it in the classic app</a>
        <button class="btn small" data-go-home>Back to Market Day</button>
      </div>
    </div>`;
  root.querySelector('[data-go-home]').onclick = () => navigate('');
}
// Manager "More": every section their permissions open, plus the
// account card. Sections they cannot access are not listed at all.
function managerMoreScreen(root) {
  const sections = managerSections({ state });
  root.innerHTML = `
    <p class="eyebrow">Staff menu</p>
    <h2 class="display">Your sections</h2>
    <p class="lede">Scoped to your permissions — the organizer sees everything.</p>
    <div class="card group-card">${sections.map(s => `<button class="menu-item" data-go="${s.id}"><span><b>${esc(s.label)}</b><span>${esc(s.sub)}</span></span><span class="chev">›</span></button>`).join('') || '<p class="note">No sections are open for your account yet.</p>'}</div>
    <div class="card account-card">
      <p><strong>Signed in as ${esc(state.user.email)}</strong><br><span class="muted">Staff · the new app and the current app share this sign-in.</span></p>
      <div class="vendor-actions">
        <a class="btn small" href="/classic/">Open the classic app</a>
        <button class="btn small ghost" id="v2-signout-m">Sign out</button>
      </div>
      <p class="note">Trinity Crafters Market — staff app · ${STAGE} · build ${VERSION}</p>
    </div>`;
  bindGo(root);
  const out = $('#v2-signout-m');
  if (out) out.onclick = resetSession;
}

// Vendor "More": profile, message threads, and the account card.
function vendorMoreScreen(root) {
  root.innerHTML = `
    <p class="eyebrow">Vendor menu</p>
    <h2 class="display">More</h2>
    <div class="card group-card">
      <button class="menu-item" data-go="vprofile"><span><b>My Profile</b><span>Your details, saved once — applications pre-fill from them</span></span><span class="chev">›</span></button>
      <button class="menu-item" data-go="vthreads"><span><b>Application messages</b><span>The message thread on each of your applications</span></span><span class="chev">›</span></button>
      <button class="menu-item" data-go="vmessages"><span><b>Chat with us</b><span>Live chat with the organizer</span></span><span class="chev">›</span></button>
    </div>
    <div class="card account-card">
      <p><strong>Signed in as ${esc(state.user.email)}</strong><br><span class="muted">Vendor · the new app and the current app share this sign-in.</span></p>
      <div class="vendor-actions">
        <a class="btn small" href="/classic/">Open the classic app</a>
        <button class="btn small ghost" id="v2-signout-v">Sign out</button>
      </div>
      <p class="note">Trinity Crafters Market — vendor app · ${STAGE} · build ${VERSION}</p>
    </div>`;
  bindGo(root);
  const out = $('#v2-signout-v');
  if (out) out.onclick = resetSession;
}

// --- sign-in (same email-code flow as the current app) ---------------------------
function signInScreen(root) {
  $('#app-head').innerHTML = `<div class="wrap head-wrap"><div class="brand"><div class="brand-mark">T</div><div><h1>Trinity Crafters Market</h1><p>New app · ${STAGE}</p></div></div></div>`;
  $('#tabbar').innerHTML = '';
  $('#sidenav').innerHTML = '';
  root.innerHTML = `
    <section class="card signin-card">
      <p class="eyebrow">Trinity Crafters Market</p>
      <h2 class="display">Welcome back.</h2>
      <p class="lede">Sign in with a code sent to your email — the same sign-in as the current app, so if you're signed in there you may already be signed in here. Vendors, staff, and the organizer all sign in here; you land on your own home.</p>
      <form id="v2-login">
        <label class="sheet-field">Email address<input name="email" type="email" required autocomplete="email" placeholder="you@example.com"></label>
        <button class="btn primary btn-block">Email my sign-in code</button>
      </form>
      <form id="v2-verify" hidden>
        <label class="sheet-field">Email verification code<input name="code" inputmode="numeric" autocomplete="one-time-code" required placeholder="123456"></label>
        <button class="btn primary btn-block">Verify &amp; sign in</button>
      </form>
      <p class="note" id="v2-login-note"></p>
      <p class="note">Just looking? <a href="/classic/">Open the classic app</a> — nothing there has changed.</p>
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
async function refreshManager() {
  state.manager = await api('manager');
  state.permissions = state.user?.permissions || [];
}
async function refreshVendor() {
  state.vendorRows = await api('mine');
  // Move requests + credits ride along; each is best-effort so one
  // failing never takes My Bookings down with it.
  try { state.vendorMoves = (await fn('move-requests', { action: 'mine' })).requests || []; } catch { state.vendorMoves = []; }
  try { state.credits = await fn('vendor-credit', { action: 'mine' }); } catch { state.credits = null; }
}
async function ensurePublic() {
  if (!state.publicData) state.publicData = await api('public');
}

const ctx = {
  state,
  toast,
  openSheet,
  closeSheet,
  navigate,
  bindGo,
  // Public screens (food-truck form) send a signed-out visitor to the
  // sign-in screen; the hash survives, so boot() returns them to the
  // same public form once signed in.
  showSignIn: () => signInScreen($('#screen')),
  refreshAdmin: async () => { await refreshAdmin(); renderChrome(); },
  // The role-aware refresh every Stage 3b screen mutates through:
  // re-fetch the signed-in role's payload, then refresh the chrome.
  refreshData: async () => {
    const role = roleOf();
    if (role === 'admin') await refreshAdmin();
    else if (role === 'manager') await refreshManager();
    else await refreshVendor();
    renderChrome();
  }
};
Object.defineProperty(ctx, 'sheetEl', { get: () => document.querySelector('#sheet-root .sheet') });

// --- router ---------------------------------------------------------------------------
async function route() {
  const r = parseHash();
  state.route = r;
  const root = $('#screen');
  const role = roleOf();
  renderChrome();
  try {
    // The public food-truck form renders for every role (and, via boot,
    // signed-out): it is a public page, not a role screen.
    if (r.name === 'vtrucks') { renderFoodTruckApply(ctx, root); window.scrollTo(0, 0); return; }
    if (role === 'manager') return await routeManager(r, root);
    if (role === 'vendor') return await routeVendor(r, root);
    if (r.name === 'home') { await refreshAdmin(); renderChrome(); renderHome(ctx, root); }
    else if (r.name === 'event-day') { await refreshAdmin(); renderChrome(); renderEventDay(ctx, root, r); }
    else if (r.name === 'attendees') { await refreshAdmin(); renderChrome(); renderAttendees(ctx, root, r); }
    else if (r.name === 'applications') { await refreshAdmin(); renderChrome(); renderApplications(ctx, root); }
    else if (r.name === 'waitlist') { await refreshAdmin(); renderChrome(); renderWaitlist(ctx, root); }
    else if (r.name === 'moves') { renderMoves(ctx, root); }
    else if (r.name === 'manualbooking') { renderManualBooking(ctx, root); }
    else if (r.name === 'cancelled') { await refreshAdmin(); renderChrome(); renderCancelled(ctx, root); }
    else if (r.name === 'banned') { await refreshAdmin(); renderChrome(); renderBanned(ctx, root); }
    else if (r.name === 'foodtrucks') { await refreshAdmin(); renderChrome(); renderFoodTrucks(ctx, root); }
    else if (r.name === 'checkin') { await refreshAdmin(); renderChrome(); renderCheckin(ctx, root); }
    else if (r.name === 'apprecovery') { await refreshAdmin(); renderChrome(); renderAppRecovery(ctx, root); }
    else if (r.name === 'directory') { await refreshAdmin(); renderChrome(); renderVendors(ctx, root); }
    else if (r.name === 'registered') { renderRegistered(ctx, root); }
    else if (r.name === 'payments') { await refreshAdmin(); renderChrome(); renderPayments(ctx, root); }
    else if (r.name === 'invoices') { await refreshAdmin(); renderChrome(); renderInvoices(ctx, root); }
    else if (r.name === 'billing') { await refreshAdmin(); renderChrome(); renderBilling(ctx, root); }
    else if (r.name === 'expenses') { await refreshAdmin(); renderChrome(); renderExpenses(ctx, root); }
    else if (r.name === 'reports') { await refreshAdmin(); renderChrome(); renderReports(ctx, root); }
    else if (r.name === 'flooredit') { await refreshAdmin(); renderChrome(); renderFloorEditor(ctx, root, r); }
    else if (r.name === 'dates') { await refreshAdmin(); renderChrome(); renderDates(ctx, root); }
    else if (r.name === 'categories') { await refreshAdmin(); renderChrome(); renderCategories(ctx, root); }
    else if (r.name === 'managers') { renderManagers(ctx, root); }
    else if (r.name === 'connections') { await refreshAdmin(); renderChrome(); renderConnections(ctx, root); }
    else if (r.name === 'surveys') { renderSurveys(ctx, root); }
    else if (r.name === 'archive') { await refreshAdmin(); renderChrome(); renderArchive(ctx, root); }
    else if (r.name === 'tools') { renderTools(ctx, root); }
    else if (r.name === 'rsvps') { renderRsvps(ctx, root); }
    else if (r.name === 'comms') { renderComms(ctx, root); }
    else if (r.name === 'threads') { await refreshAdmin(); renderChrome(); renderThreads(ctx, root, { apps: threadApps(state.admin?.applications) }); }
    else if (r.name === 'chat') { renderChatAdmin(ctx, root); }
    else if (r.name === 'social') { renderSocial(ctx, root); }
    else if (['vendors', 'money', 'messages'].includes(r.name)) groupScreen(root, r.name);
    else if (r.name === 'more') moreScreen(root);
    else if (r.name === 'section') sectionScreen(root, r.section);
    else renderHome(ctx, root);
  } catch (e) {
    root.innerHTML = `<div class="card empty-card"><h3>Something went wrong loading this screen.</h3><p class="muted">${esc(e.message)}</p><div class="vendor-actions"><button class="btn small" onclick="location.reload()">Reload</button><a class="btn small" href="/classic/">Open the classic app</a></div></div>`;
  }
  window.scrollTo(0, 0);
}

// Thread screens take a deduped application list from whichever payload
// the role carries (admin applications / manager applications / the
// vendor's own rows).
function threadApps(rows) {
  const seen = new Map();
  for (const a of rows || []) {
    if (a?.application_id && !seen.has(String(a.application_id))) seen.set(String(a.application_id), a);
  }
  return [...seen.values()];
}

async function routeManager(r, root) {
  await refreshManager();
  renderChrome();
  const guard = (perm, render) => {
    if (!managerCan(ctx, perm)) { renderManagerHome(ctx, root); return; }
    render();
  };
  if (r.name === 'meventday') guard('attendees', () => renderManagerEventDay(ctx, root));
  else if (r.name === 'mattendees') guard('attendees', () => renderManagerEventDay(ctx, root, { attendeesMode: true }));
  else if (r.name === 'mapplications') guard('applications', () => renderManagerApplications(ctx, root));
  else if (r.name === 'mwaitlist') guard('waitlist', () => renderManagerApplications(ctx, root, { waitlistOnly: true }));
  else if (r.name === 'mrsvps') guard('shopper_rsvps', () => renderRsvps(ctx, root));
  else if (r.name === 'mmoves') guard('moves:approve', () => renderMoves(ctx, root));
  else if (r.name === 'mthreads') guard('vendor_messages', () => renderThreads(ctx, root, { eyebrow: 'Staff messages', apps: threadApps(state.manager?.applications) }));
  else if (r.name === 'mchat') guard('live_chat', () => renderChatAdmin(ctx, root));
  else if (r.name === 'mfloor') guard('floor_plans', () => renderManagerFloor(ctx, root));
  else if (r.name === 'mmore') managerMoreScreen(root);
  else renderManagerHome(ctx, root);
  window.scrollTo(0, 0);
}

async function routeVendor(r, root) {
  await refreshVendor();
  renderChrome();
  if (r.name === 'vbookings') renderVendorBookings(ctx, root);
  else if (r.name === 'vapply') { await ensurePublic(); renderVendorApply(ctx, root); }
  else if (r.name === 'vprofile') { await ensurePublic(); renderVendorProfile(ctx, root); }
  else if (r.name === 'vmessages') renderChatVendor(ctx, root);
  else if (r.name === 'vthreads') renderThreads(ctx, root, { eyebrow: 'Messages', title: 'Application messages', apps: threadApps(state.vendorRows) });
  else if (r.name === 'vmore') vendorMoreScreen(root);
  else renderVendorHome(ctx, root);
  window.scrollTo(0, 0);
}

// Minimal chrome for public pages reached signed-out (Stage H): the
// brand header with no role navigation, like the sign-in screen.
function publicHead() {
  $('#app-head').innerHTML = `<div class="wrap head-wrap"><div class="brand"><div class="brand-mark">T</div><div><h1>Trinity Crafters Market</h1><p>New app · ${STAGE}</p></div></div></div>`;
  $('#tabbar').innerHTML = '';
  $('#sidenav').innerHTML = '';
}

// Android-app detection (§28). The Android app is a Capacitor shell
// (appId com.trinitylutzmarkets.app) whose server.url loads THIS site,
// so "in the app" has to be detected from inside the page. Signals, in
// order of trust:
//  1. The Capacitor bridge — window.Capacitor is injected into the
//     shell's WebView and reaches remote-served pages like this one
//     (the classic UI's in-app controls script already relies on
//     exactly this). isNativePlatform() + getPlatform()==='android'
//     is the strongest signal available.
//  2. User-Agent fallback for a shell whose bridge is missing: an
//     Android WebView UA carries the '; wv)' token, which a regular
//     Chrome tab never sends — so plain browser visits on an Android
//     phone never count as app use.
function insideAndroidApp() {
  try {
    const cap = window.Capacitor;
    if (cap && typeof cap.isNativePlatform === 'function' && cap.isNativePlatform()) {
      if (typeof cap.getPlatform === 'function') return cap.getPlatform() === 'android';
      return /Android/i.test(navigator.userAgent || '');
    }
  } catch { /* a broken bridge must never break boot — fall through to the UA */ }
  const ua = navigator.userAgent || '';
  return /Android/i.test(ua) && /;\s*wv\)/.test(ua);
}

// Usage ping (§28): when a signed-in session boots inside the Android
// app, stamp the account server-side (Registered Users shows who uses
// the app). Fire-and-forget: every failure — offline, signed out, not
// in the app — is silent, and signed-out boots return before this is
// called, so nothing is ever stamped anonymously. Throttled to at
// most one ping per day per device: a sessionStorage day key (the v2
// codebase stores nothing persistently in the browser — audit §1)
// skips repeat boots in the same app session, and the server write
// is day-bounded as well, so a fresh app session later the same day
// still cannot move the stamp twice.
const APP_USAGE_PING_KEY = 'tcm-app-usage-ping-day';
function pingAppUsage() {
  try {
    if (!insideAndroidApp()) return;
    const day = todayKey();
    if (sessionStorage.getItem(APP_USAGE_PING_KEY) === day) return;
    api('app-usage-ping', {}).then(() => {
      try { sessionStorage.setItem(APP_USAGE_PING_KEY, day); } catch { /* storage unavailable */ }
    }).catch(() => {});
  } catch { /* usage tracking must never break the shell */ }
}

async function boot() {
  const root = $('#screen');
  $('#sheet-root').innerHTML = '';
  if (!getToken()) {
    state.user = null;
    // The public food-truck application form renders signed-out, like
    // its classic page (Stage H): its GET is anonymous and the function
    // itself requires sign-in at submit.
    if (parseHash().name === 'vtrucks') { publicHead(); renderFoodTruckApply(ctx, root); return; }
    signInScreen(root); return;
  }
  try {
    state.user = await me();
  } catch {
    signOut();
    state.user = null;
    signInScreen(root);
    return;
  }
  pingAppUsage();
  // Every role lands in the same shell now (Stage 3b): route() dispatches
  // to the organizer, manager, or vendor screens by role.
  try {
    if (state.user.admin) await refreshAdmin();
    else if (state.user.manager) await refreshManager();
    else await refreshVendor();
  } catch (e) { toast(e.message, true); }
  renderChrome();
  route();
}

window.addEventListener('hashchange', () => { if (state.user) route(); else boot(); });
getConfig(); // warm the OTP config so the sign-in form answers fast
boot();
