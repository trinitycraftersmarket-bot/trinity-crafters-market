// §28 Android app usage: behavioral checks for the 'app-usage-ping'
// api action, through the real handler (manager.test.mjs harness:
// strip the module imports, inline the real permissions module, mock
// identity/db/supa per scenario). The mock sql evaluates the same
// semantics the declared SQL has: a first insert sets first_seen_at
// and last_seen_at to now; ON CONFLICT platform + last_seen_at move —
// first_seen_at never does — and only when the stored last_seen_at
// falls on an earlier market day (America/New_York) than now, so the
// stamp advances at most once per market day.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

process.env.ADMIN_EMAIL = 'org@example.com';

let handler;
test.before(async () => {
  let source = await readFile('netlify/functions/api.mjs', 'utf8');
  source = source.replace(/^import .*;\n/gm, '');
  const permissions = (await readFile('server/permissions.mjs', 'utf8')).replace(/^export /gm, '');
  const mock = permissions + `
const ready=()=>true;
const identity=async()=>{ if(globalThis.__who===null) throw Error('Sign in to continue.'); return globalThis.__who; };
const db=()=>globalThis.__sql;
const supa=()=>globalThis.__supa;
const publicData=async()=>({}); const flushMail=async()=>{}; const banned=async()=>false;
const expire=async()=>{}; const audit=async()=>{}; const queue=async()=>({});
const isUserError=()=>false;
`;
  ({ default: handler } = await import('data:text/javascript;base64,' + Buffer.from(mock + source).toString('base64')));
});

const marketDay = ts => new Date(ts).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
const makeSql = store => {
  const sql = async (strings, ...values) => {
    const text = strings.join(' ');
    if (text.includes('create table if not exists market.app_usage')) return [];
    if (text.includes('insert into market.app_usage')) {
      const userId = values[0];
      const now = globalThis.__now;
      const row = store.get(userId);
      if (row) {
        // The SQL's day-bound WHERE: same market day → the row is untouched.
        if (marketDay(row.last_seen_at) < marketDay(now)) { row.platform = 'android-app'; row.last_seen_at = now; }
      }
      else store.set(userId, { user_id: userId, platform: 'android-app', first_seen_at: now, last_seen_at: now });
      return [];
    }
    if (text.includes('from market.app_usage')) return [...store.values()];
    throw Error('Unexpected query: ' + text);
  };
  sql.json = v => JSON.stringify(v);
  sql.begin = async fn => fn(sql);
  return sql;
};
const ping = () => handler(new Request('https://market.test/.netlify/functions/api?action=app-usage-ping', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}'
}));

test('app-usage-ping stamps nothing when signed out', async () => {
  const store = new Map();
  globalThis.__sql = makeSql(store);
  globalThis.__supa = {};
  globalThis.__who = null; // identity rejects: no verified session
  globalThis.__now = '2026-10-23T12:00:00Z';
  const res = await ping();
  assert.ok(res.status >= 400, 'a signed-out ping must not succeed');
  assert.equal(store.size, 0, 'a signed-out ping must not stamp any account');
});

test('app-usage-ping stamps any signed-in role; the stamp advances at most once per market day', async () => {
  const store = new Map();
  globalThis.__sql = makeSql(store);
  globalThis.__supa = {};
  // A plain vendor — the ping is not organizer/staff gated.
  globalThis.__who = { id: 'vendor-1', email: 'vendor@example.com', admin: false, manager: false, permissions: [] };
  globalThis.__now = '2026-10-23T12:00:00Z'; // Oct 23 in the market timezone
  const first = await ping();
  assert.equal(first.status, 200);
  assert.deepEqual(await first.json(), { ok: true });
  assert.equal(store.size, 1);
  assert.deepEqual(store.get('vendor-1'), {
    user_id: 'vendor-1', platform: 'android-app',
    first_seen_at: '2026-10-23T12:00:00Z', last_seen_at: '2026-10-23T12:00:00Z'
  });
  // Later the SAME market day (Oct 23, 10pm ET): the row is untouched.
  globalThis.__now = '2026-10-24T02:00:00Z';
  assert.equal((await ping()).status, 200);
  assert.equal(store.size, 1, 'a repeat ping must update in place, not duplicate');
  assert.equal(store.get('vendor-1').last_seen_at, '2026-10-23T12:00:00Z', 'a same-market-day ping must not move the stamp');
  // The next market day: last_seen_at advances, first_seen_at frozen.
  globalThis.__now = '2026-10-24T12:00:00Z';
  assert.equal((await ping()).status, 200);
  assert.deepEqual(store.get('vendor-1'), {
    user_id: 'vendor-1', platform: 'android-app',
    first_seen_at: '2026-10-23T12:00:00Z', last_seen_at: '2026-10-24T12:00:00Z'
  });
  // The organizer's account stamps too — the stamp is per account.
  globalThis.__who = { id: 'org-1', email: 'org@example.com', admin: true, manager: false, permissions: [] };
  globalThis.__now = '2026-10-24T13:00:00Z';
  assert.equal((await ping()).status, 200);
  assert.equal(store.size, 2);
  assert.equal(store.get('org-1').platform, 'android-app');
});
