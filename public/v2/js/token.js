// §52 — the ONE allowlisted storage accessor in the v2 codebase.
//
// Scott (Oct 24, 2026): "I don't like having to sign in again cause it
// doesn't work." The token used to live in sessionStorage only, under
// the codebase's blanket localStorage ban, so it died with every app
// session and was never shared with other windows: every app reopen —
// and every print-page fallback reload — landed back on the sign-in
// screen, where the email-code step is one more failure point between
// the user and their books at a market.
//
// The ban now narrows to app DATA (the server stays the source of
// truth for data — untouched). The auth token is a credential, not
// data, and it persists on the device in localStorage so the user
// stays signed in across restarts and windows. The confinement is
// enforced by tests (tests/v2-frontend.test.mjs + stay-signed-in-52):
// this is the only v2 module that may reference localStorage, and it
// uses exactly one key — market-token, the same key the classic app
// uses, so the two UIs agree on what "signed in" means.
//
// Lifetime: no client-side expiry is invented here. The stored
// artifact is the server-issued Supabase access token (a JWT); the
// server validates it on every request (server/core.mjs identity()
// calls Supabase auth.getUser), and this module simply keeps the
// credential until the server stops accepting it or the user signs
// out. Sign-out clears BOTH stores.
//
// Read order is the graceful migration: a live sessionStorage token
// wins (pre-§52 sessions, and the classic app in the same tab, keep
// working until they expire); the persistent copy is the fallback a
// fresh app launch reads. Writes go to both stores so the two never
// disagree about the current token.
//
// §77 (Scott, Nov 18, 2026): "fix it where it doesn't log out. That's
// annoying — and do it only for the admin account." The stored access
// token is a Supabase JWT with a short life (about an hour): §52 kept
// it across restarts, but once it expired the server refused it, boot
// cleared it, and Scott was back at the email-code screen — the
// sign-in he did at 12:30 was dead by 1:31. The verify response also
// carries a long-lived REFRESH token, which §77 now stores — for the
// ADMIN account only (api.js sets the flag from the server's own
// identity answer) — so api.js can silently exchange it for a fresh
// access token instead of ever showing the organizer a sign-in
// screen. Vendor and manager sessions keep the old behavior exactly:
// no refresh token is stored for them and their access tokens expire
// as before. The confinement narrows accordingly: this module is
// still the only one that may touch storage, now with three keys —
// the access token, the admin refresh token, and the admin flag.
//
// Every store reference sits INSIDE its try/catch: in an environment
// where a storage global is absent entirely (not just throwing), the
// identifier lookup itself raises — the accessor must read that as
// "no token", never propagate it into api() (the audit-batch-31 A3
// regression: zero fetches, a silently empty screen).
export const TOKEN_KEY = 'market-token';
export const REFRESH_KEY = 'market-refresh-token';
export const PERSIST_KEY = 'market-persistent-session';

const readLocal = key => { try { return localStorage.getItem(key); } catch { return null; } };
const readSession = key => { try { return sessionStorage.getItem(key); } catch { return null; } };
const writeLocal = (key, value) => { try { localStorage.setItem(key, value); } catch { /* storage unavailable */ } };
const writeSession = (key, value) => { try { sessionStorage.setItem(key, value); } catch { /* storage unavailable */ } };
const removeLocal = key => { try { localStorage.removeItem(key); } catch { /* storage unavailable */ } };
const removeSession = key => { try { sessionStorage.removeItem(key); } catch { /* storage unavailable */ } };
const readKey = key => readSession(key) || readLocal(key);
const writeKey = (key, value) => { if (value) { writeLocal(key, value); writeSession(key, value); } else { removeLocal(key); removeSession(key); } };

export const getToken = () => readKey(TOKEN_KEY);
export const setToken = t => { if (!t) return; writeKey(TOKEN_KEY, t); };
// §77: the admin-only persistence pair. clearToken() clears all three
// keys, so an explicit sign-out always ends persistence too.
export const getRefreshToken = () => readKey(REFRESH_KEY);
export const setRefreshToken = t => writeKey(REFRESH_KEY, t || null);
export const isPersistentSession = () => readKey(PERSIST_KEY) === '1';
export const setPersistentSession = on => writeKey(PERSIST_KEY, on ? '1' : null);
export const clearToken = () => { writeKey(TOKEN_KEY, null); writeKey(REFRESH_KEY, null); writeKey(PERSIST_KEY, null); };
// The access token's expiry (ms epoch) read from the JWT itself, so
// boot can renew BEFORE the first call fails. 0 = unknown/none.
export const tokenExpiresAt = () => {
  const t = getToken();
  if (!t) return 0;
  try {
    const payload = JSON.parse(atob(t.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
    return (Number(payload.exp) || 0) * 1000;
  } catch { return 0; }
};
