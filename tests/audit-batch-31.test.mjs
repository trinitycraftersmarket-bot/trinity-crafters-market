// §31 — market-critical fixes from the full v2 audit (Oct 23, 2026), for
// the Oct 24 market: A1 print attendance, A2 checkin-reminder, A3 vendor
// floor plan, B1 vendor-credit space gates, B2 waitlist gate + ownership,
// B5 home Attendees quick action.
//
// B1 note: the audit reported a `price` TDZ crash in vendor-credit.mjs.
// Byte-level inspection (python codepoints; `grep -n price` skips the
// lines) proved the identifiers at the two flagged sites are the loop /
// parameter SPACE variable — the module was already correct, and its
// behavior is pinned here so the class cannot regress silently.
import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = p => readFileSync(join(root, p), 'utf8');

// ---------------------------------------------------------------- A1
test('A1: print.js has no escHtml anywhere (only esc is defined)', () => {
  assert.ok(!read('public/v2/js/print.js').includes('escHtml'));
});

test('A1 (behavioral): printAttendance renders rows + plan images without throwing', async () => {
  const doc = { html: '', write(s) { this.html += s; }, close() {} };
  globalThis.window = { open: () => ({ document: doc }) };
  try {
    const { printAttendance } = await import(new URL('../public/v2/js/print.js', import.meta.url));
    // The real caller contract (attendees.js print button).
    printAttendance({
      market: 'Hampton Inn Odessa',
      subtitle: 'Sat, October 24, 2026',
      summary: '9 vendors · 9 paid · 0 checked in',
      headers: ['Space', 'Business', 'Vendor'],
      rows: [['HI-01', 'A & B <Co>', 'Ann']],
      plans: [{ title: 'Indoor Room', image: 'data:image/png;base64,AAAA' }]
    });
  } finally {
    // PGlite (used below) detects a browser environment from `window`.
    delete globalThis.window;
  }
  assert.ok(doc.html.includes('Attendance List'), 'document rendered');
  assert.ok(doc.html.includes('A &amp; B &lt;Co&gt;'), 'row business rendered through esc()');
  assert.ok(doc.html.includes('HI-01'), 'booth spot rendered');
  assert.ok(doc.html.includes('<img src="data:image/png;base64,AAAA"'), 'original plan image rendered, one plan page');
  assert.ok(doc.html.includes('Indoor Room'), 'plan title rendered');
});

// ---------------------------------------------------------------- A3
test('A3: renderVendorFloorPlan uses vendor_names, never the staff floor-attendees payload', () => {
  const src = read('public/v2/js/floorplan.js');
  const vendorView = src.slice(src.indexOf('export async function renderVendorFloorPlan'));
  assert.ok(vendorView.includes('vendor_names'), 'vendor view consumes the vendor_names payload');
  assert.ok(!vendorView.includes("api('floor-attendees'"), 'vendor view must not fetch floor-attendees');
  assert.ok(read('netlify/functions/api.mjs').includes('vendor_names[String(r.vendor_id)]'),
    'server keys vendor_names by the master vendor id as well as the row id');
});

test('A3 (behavioral): vendor sees the ORIGINAL layout image with their booth marked', async () => {
  const prevFetch = globalThis.fetch, prevSession = globalThis.sessionStorage;
  globalThis.sessionStorage = { getItem: () => null, setItem() {}, removeItem() {} };
  const calls = [];
  const payload = {
    areas: [{
      area_key: 'main', title: 'Indoor Room', prefix: 'HI', capacity: 2, space_type: 'indoor',
      image_data_url: 'data:image/jpeg;base64,AAAA', image_width: 1200, image_height: 800,
      assignments: { 'HI-01': { vendor_id: 'row-1', x: 20, y: 30 }, 'HI-02': { vendor_id: 'master-2', x: 60, y: 40 } }
    }],
    template: [],
    vendor_names: { 'row-1': 'My Biz', 'master-2': 'Other Biz' }
  };
  globalThis.fetch = async url => {
    calls.push(String(url));
    return { ok: true, json: async () => payload };
  };
  const fp = await import(new URL('../public/v2/js/floorplan.js', import.meta.url));
  const host = { innerHTML: '', querySelectorAll: () => [] };
  try {
    await fp.renderVendorFloorPlan(host, 'ev-1', { id: 'row-1', vendor_id: 'master-1', email: 'me@x.com' });
  } finally {
    globalThis.fetch = prevFetch; globalThis.sessionStorage = prevSession;
  }
  assert.equal(calls.length, 1, 'exactly one fetch on the vendor path');
  assert.ok(calls[0].includes('action=floor-area-plans'));
  assert.ok(!calls.some(u => u.includes('floor-attendees')), 'staff payload never requested');
  assert.ok(host.innerHTML.includes('Your booth: HI-01'), 'own booth identified');
  assert.ok(host.innerHTML.includes('src="data:image/jpeg;base64,AAAA"'), 'ORIGINAL uploaded image, not a redraw');
  assert.ok(host.innerHTML.includes('fp-pin mine'), 'own pin highlighted');
  assert.ok(host.innerHTML.includes('My Biz') && host.innerHTML.includes('Other Biz'), 'pin labels resolved for both id spaces');
});

test('A3 (behavioral): assignment recorded under the MASTER vendor id still finds the booth', async () => {
  const prevFetch = globalThis.fetch, prevSession = globalThis.sessionStorage;
  globalThis.sessionStorage = { getItem: () => null, setItem() {}, removeItem() {} };
  const payload = {
    areas: [{
      area_key: 'main', title: 'Indoor Room', prefix: 'HI', capacity: 1, space_type: 'indoor',
      image_data_url: 'data:image/jpeg;base64,AAAA', image_width: 800, image_height: 600,
      assignments: { 'HI-01': { vendor_id: 'master-1', x: 50, y: 50 } }
    }],
    template: [],
    vendor_names: { 'master-1': 'My Biz' }
  };
  globalThis.fetch = async () => ({ ok: true, json: async () => payload });
  const fp = await import(new URL('../public/v2/js/floorplan.js', import.meta.url));
  const host = { innerHTML: '', querySelectorAll: () => [] };
  try {
    await fp.renderVendorFloorPlan(host, 'ev-1', { id: 'row-9', vendor_id: 'master-1', email: 'me@x.com' });
  } finally {
    globalThis.fetch = prevFetch; globalThis.sessionStorage = prevSession;
  }
  assert.ok(host.innerHTML.includes('Your booth: HI-01'), 'master-id assignment resolves to the vendor booth');
});

// ---------------------------------------------------------------- api.mjs harness (A2 + B2)
// Same harness as tests/registered-users.test.mjs / manager.test.mjs:
// strip api.mjs's import lines, inline the REAL permissions module
// (export prefixes stripped), and mock identity/db/collaborators per
// scenario through globalThis.
process.env.ADMIN_EMAIL = 'scottweber332@gmail.com';
let handlerPromise = null;
function loadApiHandler() {
  if (handlerPromise) return handlerPromise;
  const mocks = `
const isUserError=e=>false;
const ready=()=>true;
const db=()=>globalThis.__sql;
const supa=async()=>{throw Error('supa disabled in audit-batch tests')};
const identity=async()=>globalThis.__who;
const banned=async()=>false;
const expire=async()=>{};
const audit=async()=>{};
const queue=async(tx,to,subject,body)=>{globalThis.__queued.push({to,subject});return {};};
const publicData=async()=>({});
const flushMail=async()=>{};
const normalizePhone=v=>String(v||'');
const eventInventory=async()=>({indoor_used:0,outdoor_used:0});
const categoryUsed=async()=>0;
const assertCapacity=async()=>{};
const vendorIdentityKey=()=>'';
const syncInspection=async()=>{};
const acceptOffer=async(tx,id,u)=>{globalThis.__wlCalls.push({fn:'accept',id,user:u});return {booking:{id},event:{id:'ev-1'}};};
const declineOffer=async(tx,id,u)=>{globalThis.__wlCalls.push({fn:'decline',id,user:u});return {booking:{id}};};
const ensureWaitlistSchema=async()=>{};
const offerAnyway=async()=>({});
const resolveOffers=async()=>({});
const scanWaitlist=async()=>{};
const decisionEmail=()=>({subject:'',body:''});
const banEmail=()=>({subject:'',body:''});
const syncCalendar=async()=>{};
const claimImported=async()=>{};
const ensureProfileSchema=async()=>{};
const upsertProfileFromApplication=async()=>{};
const vendorPaymentHistory=async()=>({rows:[]});
const recordManualPayment=async()=>({});
const ensureVendorPaymentColumns=async()=>{};
const pickAreaAttachment=()=>null;
const allAreaAttachments=()=>[];
const blockedRecipients=async()=>new Set();
`;
  const permissions = read('server/permissions.mjs').replace(/^export /gm, '');
  const source = read('netlify/functions/api.mjs').replace(/^import .*;\n/gm, '');
  handlerPromise = import('data:text/javascript;base64,' + Buffer.from(permissions + mocks + source).toString('base64'))
    .then(m => m.default);
  return handlerPromise;
}

function fakeSql(routes = []) {
  const sql = Object.assign(async (strings, ...values) => {
    const text = Array.isArray(strings) ? strings.join(' ') : String(strings);
    for (const [needle, rows] of routes) if (text.includes(needle)) return rows;
    return [];
  }, { json: v => v, begin: async fn => fn(sql) });
  return sql;
}

const post = (action, body) => new Request('http://x/.netlify/functions/api?action=' + action, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {})
});

// ---------------------------------------------------------------- A2
test('A2: checkin-reminder handler does not re-read the request body; manager sends the per-attendee contract', () => {
  const apiSrc = read('netlify/functions/api.mjs');
  const start = apiSrc.indexOf("action==='checkin-reminder'");
  const slice = apiSrc.slice(start, apiSrc.indexOf("if(action===", start + 10));
  assert.ok(!slice.includes('await req.json()'), 'handler reuses the shared body parse');
  const mgr = read('public/v2/js/manager.js');
  assert.ok(mgr.includes("api('checkin-reminder', { id: r.id, imported: r.imported })"), 'manager fans out per attendee row');
  assert.ok(!mgr.includes("checkin-reminder', { event_id"), 'the unaccepted {event_id} payload is gone');
  assert.ok(read('public/v2/js/attendees.js').includes("api('checkin-reminder', { id: r.id, imported: r.imported })"), 'attendees screen contract unchanged');
});

test('A2 (behavioral): checkin-reminder sends end-to-end through the real handler', async () => {
  delete process.env.PAYPAL_CLIENT_ID;
  const handler = await loadApiHandler();
  globalThis.__who = { id: 'admin-1', email: 'scottweber332@gmail.com', admin: true };
  globalThis.__queued = [];
  globalThis.__wlCalls = [];
  globalThis.__sql = fakeSql([['market.bookings b join market.applications', [{
    id: 'bk-rem', event_id: 'ev-rem', business: 'Reminder Biz', name: 'Remy', email: 'remy@x.com',
    market_name: 'Trinity Crafters Market', date: '2026-10-24', setup_open_time: '08:30:00', location: 'Hampton Inn Odessa'
  }]]]);
  const r = await handler(post('checkin-reminder', { id: 'bk-rem', imported: false }));
  assert.equal(r.status, 200, 'previously 500 (double body parse)');
  const body = await r.json();
  assert.equal(body.ok, true);
  assert.equal(body.email, 'remy@x.com');
  assert.equal(globalThis.__queued.length, 1, 'reminder queued exactly once');
  assert.equal(globalThis.__queued[0].to, 'remy@x.com');
});

// ---------------------------------------------------------------- B2 (gate)
test('B2 (behavioral): vendors reach waitlist-accept/decline; every other staff gate is unchanged', async () => {
  delete process.env.PAYPAL_CLIENT_ID;
  const handler = await loadApiHandler();
  const vendor = { id: 'u-vendor', email: 'vendor@x.com', admin: false, manager: false, permissions: [] };
  globalThis.__who = vendor;
  globalThis.__queued = [];
  globalThis.__wlCalls = [];
  globalThis.__sql = fakeSql();

  const accept = await handler(post('waitlist-accept', { id: 'bk-1' }));
  assert.equal(accept.status, 200, 'vendor accept reaches the handler');
  assert.deepEqual(globalThis.__wlCalls.map(c => c.fn), ['accept']);
  assert.equal(globalThis.__wlCalls[0].id, 'bk-1');
  assert.equal(globalThis.__wlCalls[0].user.id, 'u-vendor', 'caller identity passed to the ownership check');

  const decline = await handler(post('waitlist-decline', { id: 'bk-1' }));
  assert.equal(decline.status, 200, 'vendor decline reaches the handler');
  assert.deepEqual(globalThis.__wlCalls.map(c => c.fn), ['accept', 'decline']);

  for (const action of ['staff-list', 'waitlist-offer', 'vendor-save', 'expense-save']) {
    const r = await handler(post(action, { id: 'bk-1' }));
    assert.equal(r.status, 403, action + ' stays staff-gated for vendors');
  }
});

// ---------------------------------------------------------------- B5
test('B5: home Attendees quick action routes to the Attendees section', () => {
  const home = read('public/v2/js/home.js');
  const line = home.split('\n').find(l => l.includes('<strong>Attendees</strong>'));
  assert.ok(line, 'Attendees quick action exists');
  assert.ok(line.includes('data-go="section" data-section="attendees"'), 'routes to the attendees section');
  assert.ok(!line.includes('data-go="event-day"'), 'no longer routes to Event Day');
});

// ---------------------------------------------------------------- PGlite harness (B1 + B2 ownership)
function pgliteSql(db) {
  const sql = async (strings, ...values) => {
    let text = '', params = [];
    strings.forEach((s, i) => { text += s; if (i < values.length) { params.push(values[i]); text += '$' + params.length; } });
    return (await db.query(text, params)).rows;
  };
  sql.json = v => JSON.stringify(v);
  sql.begin = async fn => {
    await db.exec('begin');
    try { const r = await fn(sql); await db.exec('commit'); return r; }
    catch (e) { await db.exec('rollback'); throw e; }
  };
  return sql;
}

async function seededDb() {
  const db = new PGlite();
  await db.exec('create role anon; create role authenticated; create schema storage; create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);');
  for (const f of ['database/setup.sql', 'database/codify-live-schema.sql', 'database/vendor-credits.sql', 'database/waitlist-offers.sql', 'database/vendor-profiles.sql']) {
    await db.exec(await readFile(join(root, f), 'utf8'));
  }
  const sql = pgliteSql(db);
  const [loc] = await sql`insert into market.locations(name,address,indoor_capacity,outdoor_capacity,indoor_price,outdoor_price) values('Hampton Inn Odessa Trinity','11780 State Rd 54',9,3,4500,3500) returning id`;
  await sql`update market.categories set vendor_limit = 10 where name = 'Bags'`;
  const cats = {};
  for (const row of await sql`select id,name from market.categories where name in ('Bags','Candles')`) cats[row.name] = row.id;
  return { db, sql, loc, cats };
}

const day = n => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);

// ---------------------------------------------------------------- B1 (behavioral)
test('B1 (behavioral): credit eligibility and redemption honor each space open/closed state', async () => {
  const { sql, loc, cats } = await seededDb();
  const vc = await import(new URL('../netlify/functions/vendor-credit.mjs', import.meta.url));
  const [srcEvent] = await sql`insert into market.events(location_id,date,indoor_capacity,outdoor_capacity,indoor_price,outdoor_price) values(${loc.id},${day(10)},2,2,4500,3000) returning *`;
  const [closedEvent] = await sql`insert into market.events(location_id,date,indoor_capacity,outdoor_capacity,indoor_price,outdoor_price,indoor_open,outdoor_open) values(${loc.id},${day(30)},2,2,4500,3000,false,true) returning *`;
  const [app] = await sql`insert into market.applications(user_id,name,email,phone,business,description,category_id,photos,agreements) values('11111111-1111-4111-8111-111111111111','Holly','holly@x.com','7275550100','Holly Bell Designs','Handmade jewelry',${cats.Bags},'{}','{}') returning id`;
  const [srcBooking] = await sql`insert into market.bookings(application_id,event_id,space,price,status) values(${app.id},${srcEvent.id},'indoor',4500,'approved') returning id`;
  const [credit] = await sql`insert into market.vendor_credits(email,category_id,source_type,source_id,source_event_id,original_amount,remaining_amount,issued_by) values('holly@x.com',${cats.Bags},'booking',${srcBooking.id},${srcEvent.id},4500,4500,'test') returning *`;
  const user = { email: 'holly@x.com' };

  const eligible = await vc.eligibleEvents(sql, credit, user);
  const closed = eligible.find(e => e.id === closedEvent.id);
  assert.ok(closed, 'event with one closed space is still listed');
  assert.deepEqual(closed.spaces, [{ space: 'outdoor', price: 3000 }], 'closed indoor space is not offered');
  assert.ok(!eligible.some(e => e.id === srcEvent.id), 'source event excluded');

  await assert.rejects(
    vc.redeemCredit(sql, { credit_id: credit.id, event_id: closedEvent.id, space: 'indoor' }, user),
    /Indoor spaces are closed/, 'redeem into the closed space is refused');
  const out = await vc.redeemCredit(sql, { credit_id: credit.id, event_id: closedEvent.id, space: 'outdoor' }, user);
  assert.equal(out.ok, true);
  assert.equal(out.remaining, 1500, 'outdoor price (3000) charged against the 4500 credit');
  const [row] = await sql`select space, payment_status from market.imported_attendees where id = ${out.booking_id}`;
  assert.equal(row.space, 'outdoor');
  assert.equal(row.payment_status, 'paid');
});

// ---------------------------------------------------------------- B2 (ownership, real handlers)
test('B2 (behavioral): acceptOffer/declineOffer enforce ownership through the real handlers', async () => {
  const { sql, loc, cats } = await seededDb();
  const wl = await import(new URL('../server/waitlist.mjs', import.meta.url));
  const [event] = await sql`insert into market.events(location_id,date,indoor_capacity,outdoor_capacity,indoor_price,outdoor_price) values(${loc.id},${day(20)},2,2,4500,3000) returning *`;
  async function offeredBooking(userId, email, name) {
    const [app] = await sql`insert into market.applications(user_id,name,email,phone,business,description,category_id,photos,agreements) values(${userId},${name},${email},'7275550100',${name + ' Biz'},'Goods',${cats.Bags},'{}','{}') returning id`;
    const [bk] = await sql`insert into market.bookings(application_id,event_id,space,price,status,waitlisted_at,waitlist_offered_at) values(${app.id},${event.id},'indoor',4500,'waitlist',now(),now()) returning id`;
    await sql`insert into market.waitlist_offers(booking_id,event_id,state,expires_at) values(${bk.id},${event.id},'offered',now() + interval '12 hours')`;
    return bk;
  }
  const owner = { id: '22222222-2222-4222-8222-222222222222', email: 'owner@x.com' };
  const other = { id: '33333333-3333-4333-8333-333333333333', email: 'other@x.com' };

  const bk1 = await offeredBooking(owner.id, 'owner@x.com', 'Owner');
  await assert.rejects(sql.begin(tx => wl.acceptOffer(tx, bk1.id, other)), /not yours/, 'non-owner accept refused');
  await assert.rejects(sql.begin(tx => wl.declineOffer(tx, bk1.id, other)), /not yours/, 'non-owner decline refused');
  const accepted = await sql.begin(tx => wl.acceptOffer(tx, bk1.id, owner));
  assert.equal(accepted.booking.status, 'approved', 'owner accept approves the booking');
  const [offer1] = await sql`select state from market.waitlist_offers where booking_id = ${bk1.id}`;
  assert.equal(offer1.state, 'accepted');

  const bk2 = await offeredBooking(owner.id, 'owner@x.com', 'Owner');
  await assert.rejects(sql.begin(tx => wl.declineOffer(tx, bk2.id, other)), /not yours/, 'non-owner decline refused (2nd offer)');
  await sql.begin(tx => wl.declineOffer(tx, bk2.id, owner));
  const [offer2] = await sql`select state from market.waitlist_offers where booking_id = ${bk2.id}`;
  assert.equal(offer2.state, 'declined', 'owner decline records the decline');
  const [bk2After] = await sql`select waitlist_offered_at from market.bookings where id = ${bk2.id}`;
  assert.equal(bk2After.waitlist_offered_at, null, 'declined booking leaves the offered state');
});
