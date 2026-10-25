// Build stamp for the v2 front end (audit §11 P2-5: one stamp replaces the
// hand-maintained per-file ?v= strings of the legacy UI). Every asset URL in
// public/v2 carries ?v=<VERSION>; bump this one value and the matching
// literals in index.html / module imports together — tests/v2-frontend
// verifies they agree.
export const VERSION = '20261024-37';
export const STAGE = 'Stage 3b';
