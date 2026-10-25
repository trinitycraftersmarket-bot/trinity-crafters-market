// §52 — Stay signed in on this device (Scott, Oct 24, 2026).
// "I don't like having to sign in again cause it doesn't work." Root cause:
// v2 kept the Supabase access token in sessionStorage only, under the
// codebase's blanket localStorage ban. sessionStorage dies with the app
// session and is not shared with other windows, so every app reopen — and
// every print-page fallback reload — landed on the sign-in screen.
//
// Change: the AUTH TOKEN (a credential, not app data) persists in
// localStorage through ONE allowlisted accessor module,
// public/v2/js/token.js — exactly one module, exactly one key
// ('market-token', the same key the classic app uses). The ban narrows to
// app data: the server stays the source of truth for data, untouched.
// Behavior: a live sessionStorage token still wins (pre-§52 sessions and
// the classic app in the same tab keep working until they expire); the
// persistent copy is the fallback a fresh app launch reads. setToken
// writes both stores; sign-out clears both. No client-side expiry is
// invented — the stored artifact is the server-issued Supabase JWT and
// the server validates it on every request (server/core.mjs identity()).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const v2js = join(root, 'public', 'v2', 'js');
const read = p => readFileSync(join(root, p), 'utf8');

// The §52 storage-confinement scan, shared by the pin below and the
// negative control: returns the names of v2 JS modules that reference
// localStorage. Exactly one answer is legal.
function localStorageOffenders(sources) {
  return Object.entries(sources).filter(([, src]) => src.includes('localStorage')).map(([name]) => name).sort();
}
function v2Sources() {
  const out = {};
  for (const f of readdirSync(v2js).filter(x => x.endsWith('.js'))) out[f] = readFileSync(join(v2js, f), 'utf8');
  return out;
}

// ------------------------------------------------------------ static pins
test('§52: token.js is the ONLY v2 module that references localStorage, with exactly one key', () => {
  const offenders = localStorageOffenders(v2Sources());
  assert.deepEqual(offenders, ['token.js'], `localStorage may live only in token.js, found: ${offenders.join(', ') || 'none'}`);
  const src = read('public/v2/js/token.js');
  assert.ok(src.includes("export const TOKEN_KEY = 'market-token'"), 'the one key is the shared market-token key');
  // Every storage call goes through the TOKEN_KEY constant — no literal
  // key may be passed to either store anywhere in the module.
  for (const m of src.matchAll(/(?:localStorage|sessionStorage|store)\.(?:getItem|setItem|removeItem)\(([^)]*)\)/g)) {
    assert.equal(m[1].split(',')[0].trim(), 'TOKEN_KEY', `storage call must use TOKEN_KEY, got: ${m[0]}`);
  }
  // The key string itself appears exactly once (its definition).
  assert.equal(src.split("'market-token'").length - 1, 1, 'the key literal is defined once');
});

test('§52: api.js delegates token storage to token.js and keeps the OTP flow on it', () => {
  const api = read('public/v2/js/api.js');
  assert.ok(!api.includes('localStorage'), 'api.js must not touch localStorage directly');
  assert.ok(!api.includes('sessionStorage'), 'api.js must not touch sessionStorage directly anymore');
  assert.ok(api.includes("from './token.js?v="), 'api.js must import the accessor from token.js (stamped)');
  assert.ok(api.includes('export { getToken, setToken, clearToken, TOKEN_KEY }'), 'api.js re-exports the token API so existing importers are unchanged');
  // The sign-in flow itself is unchanged in shape: OTP send, verify, and
  // the verified access token goes through setToken (which now persists).
  assert.ok(api.includes("'/auth/v1/otp'"), 'sendSignInCode still posts to the Supabase OTP endpoint');
  assert.ok(api.includes("'/auth/v1/verify'"), 'verifySignInCode still posts to the Supabase verify endpoint');
  assert.ok(api.includes('setToken(v.access_token)'), 'a verified sign-in stores the access token via the accessor');
  assert.ok(api.includes('export function signOut() { clearToken(); }'), 'sign-out clears through the accessor (both stores)');
});

test('§52 negative control: the confinement scan catches a stray localStorage use in any other module', () => {
  const sources = v2Sources();
  assert.deepEqual(localStorageOffenders(sources), ['token.js'], 'baseline: only token.js');
  const poisoned = { ...sources, 'home.js': sources['home.js'] + "\nconst x = localStorage.getItem('market-data');\n" };
  assert.deepEqual(localStorageOffenders(poisoned), ['home.js', 'token.js'],
    'a stray localStorage reference in another module must be flagged by the same scan the pin uses');
});

// ------------------------------------------------------- storage behavior
function makeStore() {
  const map = new Map();
  return {
    getItem: k => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: k => { map.delete(k); },
    _map: map
  };
}

test('§52 (behavioral): migration, persistence across a restart, and sign-out clearing both stores', async () => {
  const persistent = makeStore(), session = makeStore();
  globalThis.localStorage = persistent;
  globalThis.sessionStorage = session;
  const tok = await import(new URL('../public/v2/js/token.js', import.meta.url));

  // Migration: a pre-§52 sessionStorage-only token keeps working.
  session.setItem('market-token', 'session-tok');
  assert.equal(tok.getToken(), 'session-tok', 'an existing session token is still honored');

  // A new sign-in persists: written to localStorage AND the session store.
  tok.setToken('fresh-tok');
  assert.equal(persistent.getItem('market-token'), 'fresh-tok', 'setToken writes the persistent store');
  assert.equal(session.getItem('market-token'), 'fresh-tok', 'setToken writes the session store (classic parity)');
  assert.equal(tok.getToken(), 'fresh-tok');

  // Simulated app restart: the session store is gone, the device store
  // survives — the boot finds the token and no code is needed.
  globalThis.sessionStorage = makeStore();
  assert.equal(tok.getToken(), 'fresh-tok', 'after a restart the persistent token is read');

  // Sign-out clears BOTH stores.
  globalThis.sessionStorage = session;
  tok.clearToken();
  assert.equal(persistent.getItem('market-token'), null, 'sign-out clears the persistent store');
  assert.equal(session.getItem('market-token'), null, 'sign-out clears the session store');
  assert.equal(tok.getToken(), null, 'signed out means no token from either store');

  // Empty/absent tokens are never written.
  tok.setToken('');
  tok.setToken(null);
  assert.equal(tok.getToken(), null, 'setToken ignores empty tokens');
});

test('§52 (behavioral): a storage failure never breaks the token API', async () => {
  const broken = { getItem() { throw Error('denied'); }, setItem() { throw Error('denied'); }, removeItem() { throw Error('denied'); } };
  globalThis.localStorage = broken;
  globalThis.sessionStorage = broken;
  const tok = await import(new URL('../public/v2/js/token.js', import.meta.url));
  assert.equal(tok.getToken(), null, 'unreadable storage reads as signed out, not a crash');
  tok.setToken('x');   // must not throw
  tok.clearToken();    // must not throw
});

test('§52 (behavioral): absent storage globals read as signed out, never a throw (A3 regression)', async () => {
  // Regression for the first §52 build: getToken evaluated the
  // localStorage identifier OUTSIDE the try/catch, so in an environment
  // with no such global at all (the node test harness that mocks only
  // sessionStorage — audit-batch-31's A3 tests) the lookup itself threw,
  // api() died before fetching, and the vendor floor plan rendered
  // silently empty. Every reference now sits inside its try/catch.
  delete globalThis.localStorage;
  delete globalThis.sessionStorage;
  const tok = await import(new URL('../public/v2/js/token.js', import.meta.url));
  assert.equal(tok.getToken(), null, 'no storage globals at all reads as signed out');
  tok.setToken('x');   // must not throw
  tok.clearToken();    // must not throw
  // The api() transport must still fetch with no token header at all.
  const seen = [];
  globalThis.fetch = async (url, opts = {}) => { seen.push(opts); return { ok: true, json: async () => ({ events: [] }) }; };
  const api = await import(new URL('../public/v2/js/api.js', import.meta.url));
  await api.api('public');
  assert.equal(seen.length, 1, 'api() fetched despite the absent storage globals');
  assert.ok(!('Authorization' in (seen[0].headers || {})), 'no token, no Authorization header');
});

// ------------------------------------------- email-code sign-in, end to end
test('§52 (behavioral): email-code sign-in stores the token persistently; the next boot is signed in without a code', async () => {
  const persistent = makeStore(), session = makeStore();
  globalThis.localStorage = persistent;
  globalThis.sessionStorage = session;
  const calls = [];
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    calls.push({ u, opts });
    if (u.includes('action=config')) return { ok: true, json: async () => ({ ready: true, url: 'https://auth.example', key: 'anon-key' }) };
    if (u.endsWith('/auth/v1/otp')) return { ok: true, json: async () => ({}) };
    if (u.endsWith('/auth/v1/verify')) {
      const body = JSON.parse(opts.body);
      if (body.token !== '123456') return { ok: false, json: async () => ({}) };
      return { ok: true, json: async () => ({ access_token: 'jwt-abc' }) };
    }
    if (u.includes('action=me')) return { ok: true, json: async () => ({ email: 'scott@example.com', admin: true }) };
    throw Error('unexpected fetch ' + u);
  };
  const api = await import(new URL('../public/v2/js/api.js', import.meta.url));

  // 1. Request the code.
  await api.sendSignInCode('scott@example.com');
  const otp = calls.find(c => c.u.endsWith('/auth/v1/otp'));
  assert.ok(otp, 'the code request hits the Supabase OTP endpoint');
  assert.equal(JSON.parse(otp.opts.body).email, 'scott@example.com');

  // 2. A wrong code is refused and stores nothing.
  await assert.rejects(() => api.verifySignInCode('scott@example.com', '000000'), /invalid or expired/);
  assert.equal(persistent.getItem('market-token'), null, 'a failed verify stores no token');

  // 3. The right code signs in and the token lands in the PERSISTENT store.
  const user = await api.verifySignInCode('scott@example.com', '123456');
  assert.equal(user.email, 'scott@example.com', 'verify resolves the signed-in user via me');
  assert.equal(persistent.getItem('market-token'), 'jwt-abc', 'the verified token is persisted on the device');
  const meCall = calls.filter(c => c.u.includes('action=me')).at(-1);
  assert.equal(meCall.opts.headers.Authorization, 'Bearer jwt-abc', 'the stored token is the one sent to the server');

  // 4. Next app boot (session store wiped, device store kept): getToken
  // finds the persisted token, so boot goes straight to me() — no code.
  globalThis.sessionStorage = makeStore();
  assert.equal(api.getToken(), 'jwt-abc', 'a fresh boot reads the persisted token');
  const me2 = await api.me();
  assert.equal(me2.admin, true, 'the booted session validates against the server');
});

test('§52: the server session model is unchanged — per-request validation in identity()', () => {
  const core = read('server/core.mjs');
  assert.ok(core.includes('supa().auth.getUser(token)'), 'identity() validates the bearer token with Supabase on every request');
  assert.ok(core.includes("email_confirmed_at"), 'identity() still requires a verified email');
});
