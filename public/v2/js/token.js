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
export const TOKEN_KEY = 'market-token';

const read = store => { try { return store.getItem(TOKEN_KEY); } catch { return null; } };
const write = (store, value) => { try { store.setItem(TOKEN_KEY, value); } catch { /* storage unavailable */ } };
const remove = store => { try { store.removeItem(TOKEN_KEY); } catch { /* storage unavailable */ } };

export const getToken = () => read(sessionStorage) || read(localStorage);
export const setToken = t => { if (!t) return; write(localStorage, t); write(sessionStorage, t); };
export const clearToken = () => { remove(localStorage); remove(sessionStorage); };
