// v2 shared module: transport, auth, and formatting helpers.
//
// This is the ONLY copy of each helper in the v2 codebase (audit §1 rule 2,
// §7.2 — the legacy UI redefines esc()/money()/api() in a dozen files).
// The v2 app talks to the same Netlify functions, with the same payloads,
// as the legacy UI; nothing here invents a new endpoint or response shape.
//
// Auth is the legacy model (audit §8.2): Supabase email-code (OTP)
// sign-in. Token storage itself lives in ./token.js — the one
// allowlisted storage accessor (§52), which persists the credential on
// the device so the user stays signed in across app restarts and
// windows. api.js only re-exports its API; existing importers of
// getToken/setToken/clearToken/TOKEN_KEY are unchanged.
import { getToken, setToken, clearToken, TOKEN_KEY } from './token.js?v=20261024-35';
export { getToken, setToken, clearToken, TOKEN_KEY };

// --- formatting helpers (ported semantics from the legacy UI) -------------
export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const money = n => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format((Number(n) || 0) / 100);
// Event dates arrive as 'YYYY-MM-DD' (or a Date); parse at local noon so the
// calendar day never shifts across timezones (same trick as the legacy UI).
export const dateOf = d => new Date(String(d).slice(0, 10) + 'T12:00:00');
export const nice = d => dateOf(d).toLocaleDateString('en-US', { weekday: 'short', month: 'long', day: 'numeric', year: 'numeric' });
export const niceShort = d => dateOf(d).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
export const clock = t => {
  const [h, m] = String(t || '10:00').slice(0, 5).split(':').map(Number);
  const d = new Date(2000, 0, 1, h || 0, m || 0);
  return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: m ? '2-digit' : undefined });
};
export const marketName = e => e?.market_name || e?.title || 'Crafters Market';
// Today as YYYY-MM-DD in the market's timezone (audit §8.4).
export const todayKey = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
export const isToday = e => String(e?.date || '').slice(0, 10) === todayKey();

// --- transport ---------------------------------------------------------------
async function parse(r) {
  const v = await r.json().catch(() => ({}));
  if (!r.ok) throw Error(v.error || 'Please try again.');
  return v;
}

// GET when body is undefined, POST JSON otherwise — same convention and same
// URL shape ('/.netlify/functions/api?action=…') as the legacy api() helper.
// Extra query params (e.g. event_id for the floor-plan actions) ride along.
export async function api(action, body, params) {
  const qs = new URLSearchParams({ action, ...(params || {}) });
  const token = getToken();
  const r = await fetch('/.netlify/functions/api?' + qs.toString(), {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' })
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  return parse(r);
}

// POST to a sibling Netlify function (move-requests, vendor-profile, …) with
// an {action, ...} JSON body, exactly as the legacy enhancement scripts call
// them.
export async function fn(name, payload) {
  const token = getToken();
  const r = await fetch('/.netlify/functions/' + name, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: JSON.stringify(payload || {})
  });
  return parse(r);
}

// Query-param action transport: communications and live-chat take their
// action as an '?action=' query parameter (their legacy clients call
// them that way), unlike the body-action functions above. GET when body
// is undefined, POST JSON otherwise — same convention as api().
export async function fnq(name, action, body) {
  const token = getToken();
  const r = await fetch('/.netlify/functions/' + name + '?action=' + encodeURIComponent(action), {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' })
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  return parse(r);
}

// buffer-social is the one function with no action parameter at all: a GET
// returns channels + events, a JSON POST publishes/saves, and a multipart
// POST uploads a post image (the legacy social-media center's shapes).
export async function fnGet(name) {
  const token = getToken();
  const r = await fetch('/.netlify/functions/' + name, {
    headers: { ...(token ? { Authorization: 'Bearer ' + token } : {}) }
  });
  return parse(r);
}
export async function fnForm(name, formData) {
  const token = getToken();
  const r = await fetch('/.netlify/functions/' + name, {
    method: 'POST',
    headers: { ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: formData
  });
  return parse(r);
}

// Chat attachments (live chat, both sides): the function hands back a
// signed-upload ticket {url, key, bucket, path, token}; the file goes
// straight to Supabase Storage with the official client, exactly as the
// legacy chat scripts do it. Returns the {path, name, type, size} object
// the send/reply actions expect.
let storageLib = null;
export async function uploadChatFile(ticket, file) {
  const okTypes = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'application/pdf'];
  if (!file || !file.size || file.size > 10 * 1024 * 1024 || !okTypes.includes(file.type)) {
    throw Error('Attach a JPG, PNG, WEBP, GIF, or PDF up to 10 MB.');
  }
  storageLib = storageLib || await import('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm');
  const client = storageLib.createClient(ticket.url, ticket.key, { auth: { persistSession: false, autoRefreshToken: false } });
  const { error } = await client.storage.from(ticket.bucket).uploadToSignedUrl(ticket.path, ticket.token, file, { contentType: file.type, upsert: false });
  if (error) throw Error('The file could not be uploaded. Please try again.');
  return { path: ticket.path, name: file.name, type: file.type, size: file.size };
}

// --- auth (Supabase OTP, identical flow to the legacy sign-in) ---------------
let configCache = null;
export async function getConfig() {
  if (!configCache) configCache = await api('config').catch(() => ({ ready: false }));
  return configCache;
}
export async function sendSignInCode(email) {
  const config = await getConfig();
  if (!config.ready) throw Error('Account sign-in is not available right now.');
  const r = await fetch(config.url + '/auth/v1/otp', {
    method: 'POST',
    headers: { apikey: config.key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, create_user: true })
  });
  if (!r.ok) throw Error('Could not send a code. Please try again shortly.');
}
export async function verifySignInCode(email, code) {
  const config = await getConfig();
  const r = await fetch(config.url + '/auth/v1/verify', {
    method: 'POST',
    headers: { apikey: config.key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, token: code, type: 'email' })
  });
  const v = await r.json().catch(() => ({}));
  if (!r.ok || !v.access_token) throw Error('That code is invalid or expired.');
  setToken(v.access_token);
  // Managers get a staff-login audit row, mirroring the legacy flow.
  const user = await api('me');
  if (user.manager) { try { await api('staff-login', {}); } catch { /* audit only */ } }
  return user;
}
export const me = () => api('me');
export function signOut() { clearToken(); }
