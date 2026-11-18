// §77 — the admin account stays signed in (Scott, Nov 18, 2026).
// "Fix it where it doesn't log out. That's annoying and do it only
// for the admin account." Diagnosis: the stored credential is a
// Supabase access token (JWT, ~1 hour); the verify response's refresh
// token was discarded, so the moment the access token expired the
// server refused it, boot cleared it, and the organizer was back at
// the email-code screen (a 12:30 PM sign-in was dead by 1:31 PM).
// §77: verify stores the refresh token + an admin flag ONLY when the
// server's identity answer says admin; api.js silently exchanges the
// refresh token for a fresh access token — proactively at boot and
// reactively when a call meets the server's sign-in errors — and
// retries once. Vendors/managers store nothing and expire as before.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = p => readFileSync(join(root, p), 'utf8');

function makeStore() {
  const map = new Map();
  return {
    getItem: k => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: k => { map.delete(k); },
    _map: map
  };
}
const jwt = payload => 'h.' + Buffer.from(JSON.stringify(payload)).toString('base64url') + '.s';

test('§77 (behavioral): token.js persistence pair, expiry reading, and full clear', async () => {
  const persistent = makeStore(), session = makeStore();
  globalThis.localStorage = persistent;
  globalThis.sessionStorage = session;
  const tok = await import(new URL('../public/v2/js/token.js', import.meta.url));
  tok.setToken(jwt({ exp: 2000000000 }));
  assert.equal(tok.tokenExpiresAt(), 2000000000000, 'the JWT exp is read in ms');
  tok.setRefreshToken('rt-1');
  tok.setPersistentSession(true);
  assert.equal(tok.getRefreshToken(), 'rt-1');
  assert.equal(tok.isPersistentSession(), true);
  assert.equal(persistent.getItem('market-refresh-token'), 'rt-1', 'the refresh token persists on the device');
  tok.setPersistentSession(false);
  assert.equal(tok.isPersistentSession(), false, 'the flag clears');
  tok.setRefreshToken('rt-2'); tok.setPersistentSession(true);
  tok.clearToken();
  assert.equal(tok.getToken(), null);
  assert.equal(tok.getRefreshToken(), null, 'sign-out clears the refresh token');
  assert.equal(tok.isPersistentSession(), false, 'sign-out clears the admin flag');
  assert.equal(tok.tokenExpiresAt(), 0, 'no token, no expiry');
});

// One scripted Supabase + api world for the sign-in/refresh flows.
// meFails: the SECOND me() answers with the server's sign-in error
// (the first me() is verifySignInCode's own, which must succeed).
function scriptWorld({ admin, meFails = false }) {
  const calls = [];
  let meCount = 0;
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    calls.push({ u, opts });
    if (u.includes('action=config')) return { ok: true, status: 200, json: async () => ({ ready: true, url: 'https://auth.example', key: 'anon-key' }) };
    if (u.endsWith('/auth/v1/verify')) return { ok: true, status: 200, json: async () => ({ access_token: 'jwt-old', refresh_token: 'rt-old' }) };
    if (u.includes('/auth/v1/token?grant_type=refresh_token')) {
      const body = JSON.parse(opts.body);
      if (body.refresh_token !== 'rt-old') return { ok: false, status: 400, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => ({ access_token: 'jwt-new', refresh_token: 'rt-new' }) };
    }
    if (u.includes('action=me')) {
      meCount++;
      if (meFails && meCount === 2) return { ok: false, status: 400, clone() { return this; }, json: async () => ({ error: 'Please sign in with a verified email.' }) };
      return { ok: true, status: 200, json: async () => ({ email: admin ? 'admin@example.com' : 'vendor@example.com', admin, manager: false }) };
    }
    throw Error('unexpected fetch ' + u);
  };
  return calls;
}

test('§77 (behavioral): an ADMIN sign-in stores the refresh pair; a vendor sign-in stores nothing', async () => {
  const persistent = makeStore(), session = makeStore();
  globalThis.localStorage = persistent;
  globalThis.sessionStorage = session;
  scriptWorld({ admin: true });
  const api = await import(new URL('../public/v2/js/api.js', import.meta.url));
  await api.verifySignInCode('admin@example.com', '123456');
  assert.equal(api.getRefreshToken(), 'rt-old', 'the admin refresh token is stored');
  assert.equal(api.isPersistentSession(), true, 'the admin flag is set');
  assert.equal(persistent.getItem('market-refresh-token'), 'rt-old', 'stored on the device, not just the tab');

  // A vendor signing in on the same device wipes any persistence.
  scriptWorld({ admin: false });
  await api.verifySignInCode('vendor@example.com', '123456');
  assert.equal(api.getRefreshToken(), null, 'a vendor sign-in stores no refresh token');
  assert.equal(api.isPersistentSession(), false, 'a vendor sign-in clears the admin flag');
});

test('§77 (behavioral): an expired admin access token renews itself mid-flight and the call retries', async () => {
  const persistent = makeStore(), session = makeStore();
  globalThis.localStorage = persistent;
  globalThis.sessionStorage = session;
  const calls = scriptWorld({ admin: true, meFails: true });
  const api = await import(new URL('../public/v2/js/api.js', import.meta.url));
  await api.verifySignInCode('admin@example.com', '123456');
  const user = await api.me();
  assert.equal(user.admin, true, 'the retried call succeeds');
  const refresh = calls.find(c => c.u.includes('grant_type=refresh_token'));
  assert.ok(refresh, 'the refresh endpoint was called');
  assert.equal(api.getToken(), 'jwt-new', 'the fresh access token is stored');
  assert.equal(api.getRefreshToken(), 'rt-new', 'the rotated refresh token is stored');
  const meCalls = calls.filter(c => c.u.includes('action=me'));
  assert.equal(new Headers(meCalls.at(-1).opts.headers).get('Authorization'), 'Bearer ' + 'jwt-new', 'the retry carries the new token');
});

test('§77 (behavioral): a non-admin session NEVER refreshes — the sign-in error stands', async () => {
  const persistent = makeStore(), session = makeStore();
  globalThis.localStorage = persistent;
  globalThis.sessionStorage = session;
  const calls = scriptWorld({ admin: false, meFails: true });
  const api = await import(new URL('../public/v2/js/api.js', import.meta.url));
  await api.verifySignInCode('vendor@example.com', '123456');
  await assert.rejects(() => api.me(), /verified email/, 'the vendor sees the sign-in error as before');
  assert.equal(calls.filter(c => c.u.includes('grant_type=refresh_token')).length, 0, 'no refresh was attempted');
});

test('§77: boot renews proactively and the transports all ride authedFetch', () => {
  const app = read('public/v2/js/app.js');
  assert.ok(app.includes('tokenExpiresAt() < Date.now() + 120000'), 'boot renews an expired/expiring admin token before the first call');
  assert.ok(app.includes('await refreshSession()'), 'boot uses the shared refresh');
  const api = read('public/v2/js/api.js');
  assert.equal(api.split('await authedFetch(').length - 1, 5, 'api/fn/fnq/fnGet/fnForm all go through authedFetch');
  assert.ok(api.includes("'/auth/v1/token?grant_type=refresh_token'"), 'the refresh posts to the Supabase token endpoint');
  assert.ok(api.includes('user.admin && v.refresh_token'), 'persistence is granted on the server-admin answer only');
});
