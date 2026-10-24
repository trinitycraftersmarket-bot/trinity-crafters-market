// §27 Registered Users: behavioral checks for the 'registered-users'
// api action, through the real handler (manager.test.mjs harness:
// strip the module imports, inline the real permissions module, mock
// identity/db/supa per scenario).
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
const identity=async()=>globalThis.__who;
const db=()=>globalThis.__sql;
const supa=()=>globalThis.__supa;
const publicData=async()=>({}); const flushMail=async()=>{}; const banned=async()=>false;
const expire=async()=>{}; const audit=async()=>{}; const queue=async()=>({});
`;
  ({ default: handler } = await import('data:text/javascript;base64,' + Buffer.from(mock + source).toString('base64')));
});

const makeSql = ({ staff = [], apps = [], profiles = [], imported = [], usage = [] } = {}) => {
  const sql = async (strings, ...values) => {
    const text = strings.join(' ');
    if (text.includes('market.app_usage')) return usage;
    if (text.includes('market.staff')) return staff;
    if (text.includes('market.applications')) return apps;
    if (text.includes('market.vendor_profiles')) return profiles;
    if (text.includes('market.imported_attendees')) return imported;
    throw Error('Unexpected query: ' + text);
  };
  sql.json = v => JSON.stringify(v);
  sql.begin = async fn => fn(sql);
  return sql;
};
const makeSupa = users => ({
  auth: {
    admin: {
      listUsers: async ({ page, perPage }) => {
        const start = (page - 1) * perPage;
        return { data: { users: users.slice(start, start + perPage) }, error: null };
      }
    }
  }
});
const call = () => handler(new Request('https://market.test/.netlify/functions/api?action=registered-users', { method: 'GET' }));

test('registered-users rejects vendors and managers (organizer only)', async () => {
  globalThis.__sql = makeSql();
  globalThis.__supa = makeSupa([]);
  globalThis.__who = { id: 'v1', email: 'vendor@example.com', admin: false, manager: false, permissions: [] };
  assert.equal((await call()).status, 403, 'vendor must be denied');
  globalThis.__who = { id: 'm1', email: 'manager@example.com', admin: false, manager: true, permissions: ['applications', 'attendees'] };
  assert.equal((await call()).status, 403, 'manager must be denied — the action is not in the staff permission map');
});

test('registered-users links accounts to vendor records and lists the unregistered flip side', async () => {
  const users = [
    { id: 'u1', email: 'org@example.com', created_at: '2026-01-01T00:00:00Z', last_sign_in_at: '2026-10-20T00:00:00Z' },
    { id: 'u2', email: 'a@example.com', created_at: '2026-09-01T00:00:00Z', last_sign_in_at: null },
    { id: 'u3', email: 'b@example.com', created_at: '2026-08-01T00:00:00Z', last_sign_in_at: '2026-10-01T00:00:00Z' },
    { id: 'u4', email: 'staff@example.com', created_at: '2026-07-01T00:00:00Z', last_sign_in_at: '2026-10-15T00:00:00Z' },
    { id: 'u5', email: 'stray@example.com', created_at: '2026-10-01T00:00:00Z', last_sign_in_at: null }
  ];
  globalThis.__supa = makeSupa(users);
  globalThis.__sql = makeSql({
    staff: [{ email: 'staff@example.com' }],
    apps: [
      { user_id: 'u2', email: 'a@example.com', name: 'Ann', business: 'Ann Newest', created_at: '2026-09-02T00:00:00Z' },
      { user_id: 'u2', email: 'a@example.com', name: 'Ann', business: 'Ann Older', created_at: '2026-05-01T00:00:00Z' },
      { user_id: null, email: 'ghost@example.com', name: 'Ghost', business: 'Ghost Crafts', created_at: '2026-06-01T00:00:00Z' }
    ],
    profiles: [
      { user_id: 'u4', email: 'staff@example.com', name: 'Staff Person', business: '' }
    ],
    imported: [
      { email: 'b@example.com', name: 'Bee', business: 'Bee Goods', created_at: '2026-04-01T00:00:00Z' },
      { email: 'ghost@example.com', name: 'Ghost', business: 'Ghost Imported', created_at: '2026-03-01T00:00:00Z' },
      { email: 'pdf@example.com', name: 'Pdf', business: 'Pdf Crafts', created_at: '2026-02-01T00:00:00Z' }
    ],
    usage: [
      { user_id: 'u3', platform: 'android-app', first_seen_at: '2026-10-10T00:00:00Z', last_seen_at: '2026-10-21T00:00:00Z' }
    ]
  });
  globalThis.__who = { id: 'u1', email: 'org@example.com', admin: true, manager: false, permissions: [] };
  const res = await call();
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.counts, { registered: 5, not_registered: 2, with_vendor_record: 3 });
  // Newest registration first, one row per account.
  assert.deepEqual(body.registered.map(r => r.email), ['stray@example.com', 'a@example.com', 'b@example.com', 'staff@example.com', 'org@example.com']);
  const byEmail = Object.fromEntries(body.registered.map(r => [r.email, r]));
  // Exact user_id match wins, and the most recent application is the link.
  assert.equal(byEmail['a@example.com'].matched_via, 'application');
  assert.equal(byEmail['a@example.com'].business, 'Ann Newest');
  assert.equal(byEmail['a@example.com'].has_vendor_record, true);
  assert.equal(byEmail['a@example.com'].last_sign_in_at, null, 'a null last sign-in passes through (UI renders Never)');
  // Imported attendees have no user_id: email fallback.
  assert.equal(byEmail['b@example.com'].matched_via, 'imported-email');
  assert.equal(byEmail['b@example.com'].business, 'Bee Goods');
  // Profile user_id match + staff badge.
  assert.equal(byEmail['staff@example.com'].matched_via, 'profile');
  assert.equal(byEmail['staff@example.com'].staff, true);
  assert.equal(byEmail['staff@example.com'].organizer, false);
  // Organizer badge, and an account with no vendor record is flagged.
  assert.equal(byEmail['org@example.com'].organizer, true);
  assert.equal(byEmail['org@example.com'].has_vendor_record, false);
  assert.equal(byEmail['stray@example.com'].has_vendor_record, false);
  assert.equal(byEmail['stray@example.com'].matched_via, null);
  // §28: the usage stamp rides along by account id — present for the
  // account seen in the Android app, null for everyone else.
  assert.deepEqual(byEmail['b@example.com'].app_usage, { platform: 'android-app', first_seen_at: '2026-10-10T00:00:00Z', last_seen_at: '2026-10-21T00:00:00Z' });
  assert.equal(byEmail['a@example.com'].app_usage, null);
  assert.equal(byEmail['org@example.com'].app_usage, null);
  // Flip side: deduped by email, applications win over imported twins,
  // account holders are excluded, sorted by business.
  assert.deepEqual(body.not_registered, [
    { email: 'ghost@example.com', business: 'Ghost Crafts', name: 'Ghost' },
    { email: 'pdf@example.com', business: 'Pdf Crafts', name: 'Pdf' }
  ]);
});

test('registered-users paginates the Auth user list until a short page', async () => {
  const users = Array.from({ length: 205 }, (_, i) => ({
    id: 'bulk-' + i, email: 'bulk' + i + '@example.com',
    created_at: '2026-01-01T00:00:00Z', last_sign_in_at: null
  }));
  let pages = [];
  globalThis.__supa = {
    auth: {
      admin: {
        listUsers: async ({ page, perPage }) => {
          pages.push(page);
          const start = (page - 1) * perPage;
          return { data: { users: users.slice(start, start + perPage) }, error: null };
        }
      }
    }
  };
  globalThis.__sql = makeSql();
  globalThis.__who = { id: 'u1', email: 'org@example.com', admin: true, manager: false, permissions: [] };
  const res = await call();
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.counts.registered, 205);
  assert.deepEqual(pages, [1, 2], 'a full first page (200) must be followed by page 2');
});
