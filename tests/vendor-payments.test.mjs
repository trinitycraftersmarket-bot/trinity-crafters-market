import test from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {readFile} from 'node:fs/promises';
import {vendorPaymentHistory, recordManualPayment} from '../server/vendor-payments.mjs';

// Same postgres.js tagged-template adapter as tests/vendor-credit.test.mjs.
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
  await db.exec(await readFile('database/setup.sql', 'utf8'));
  await db.exec(await readFile('database/codify-live-schema.sql', 'utf8'));
  await db.exec(await readFile('database/vendor-credits.sql', 'utf8'));
  await db.exec(await readFile('database/waitlist-offers.sql', 'utf8'));
  await db.exec(await readFile('database/vendor-profiles.sql', 'utf8'));
  const sql = pgliteSql(db);
  const [hampton] = await sql`insert into market.locations(name,address,indoor_capacity,outdoor_capacity,indoor_price,outdoor_price) values('Hampton Inn Odessa Trinity','11780 State Rd 54',9,3,4500,3000) returning id`;
  const cats = {};
  for (const row of await sql`select id,name from market.categories where name in ('Bags','Candles')`) cats[row.name] = row.id;
  async function event(date) {
    const [e] = await sql`insert into market.events(location_id,date,indoor_capacity,outdoor_capacity,indoor_price,outdoor_price) values(${hampton.id},${date},9,3,4500,3000) returning *`;
    return e;
  }
  async function application({email, business, category}) {
    const [a] = await sql`insert into market.applications(user_id,name,email,phone,business,description,category_id,photos,agreements) values(${crypto.randomUUID()},'Vendor',${email},'7275550100',${business},'Goods',${category},'{}','{}') returning *`;
    return a;
  }
  async function booking({app, ev, status = 'paid', price = 4500, space = 'indoor', method = '', reference = null}) {
    const [b] = await sql`insert into market.bookings(application_id,event_id,space,price,status,payment_method,payment_reference,paid_at) values(${app.id},${ev.id},${space},${price},${status},${method},${reference},${status === 'paid' ? new Date().toISOString() : null}) returning *`;
    return b;
  }
  async function imported({ev, email, business, category, amount = 4500, status = 'paid', method = 'cash', reference = null, space = 'Inside'}) {
    const [i] = await sql`insert into market.imported_attendees(event_id,name,business,email,phone,category_id,space,invoice_amount,payment_status,payment_method,payment_reference,selling) values(${ev.id},'Vendor',${business},${email},'7275550100',${category},${space},${amount},${status},${method},${reference},'Goods') returning *`;
    return i;
  }
  async function ledger({application_id = null, booking_id = null, imported_attendee_id = null, vendor_id = null, amount, method = 'cash', note = null}) {
    const [vp] = await sql`insert into market.vendor_payments(application_id,booking_id,imported_attendee_id,vendor_id,amount,payment_method,paid_at,note,recorded_by) values(${application_id},${booking_id},${imported_attendee_id},${vendor_id},${amount},${method},now(),${note},'org@example.com') returning *`;
    return vp;
  }
  const refFor = a => ({source: 'application', id: a.id, email: a.email, phone: a.phone, business: a.business, name: a.name});
  return {db, sql, cats, event, application, booking, imported, ledger, refFor};
}

const ORG = {email: 'org@example.com', admin: true};

test('history spans ALL of a vendor\'s applications, not just the latest one', async () => {
  const {sql, cats, event, application, booking, refFor} = await seededDb();
  const A = await event('2026-09-12'), B = await event('2026-10-24');
  const first = await application({email: 'multi@example.com', business: 'Multi Crafts', category: cats.Bags});
  const second = await application({email: 'multi@example.com', business: 'Multi Crafts', category: cats.Bags});
  await booking({app: first, ev: A});
  await booking({app: second, ev: B, price: 3000, space: 'outdoor'});
  // vendor-list represents this vendor by the LATEST application only;
  // the old code therefore showed just one of these two paid dates.
  const h = await vendorPaymentHistory(sql, refFor(second));
  const booth = h.lines.filter(l => l.kind === 'Booking');
  assert.equal(booth.length, 2);
  assert.equal(h.totals.shows, 2);
  assert.equal(h.totals.booking_spend, 7500);
  assert.ok(booth.every(l => l.amount_recorded && l.label.startsWith('Booth — ')));
});

test('booking/imported twins dedupe to one booth line; the booking wins', async () => {
  const {sql, cats, event, application, booking, imported, refFor} = await seededDb();
  const A = await event('2026-10-24'), B = await event('2026-11-14');
  const app = await application({email: 'twin@example.com', business: 'Twin Goods', category: cats.Bags});
  await booking({app, ev: A});
  await imported({ev: A, email: 'twin@example.com', business: 'Twin Goods', category: cats.Bags}); // twin of the booking
  await imported({ev: B, email: 'twin@example.com', business: 'Twin Goods', category: cats.Bags}); // import-only date
  const h = await vendorPaymentHistory(sql, refFor(app));
  const booth = h.lines.filter(l => ['Booking', 'Import', 'Credit'].includes(l.kind));
  assert.equal(booth.length, 2);
  assert.equal(booth.filter(l => l.kind === 'Booking').length, 1);
  assert.equal(booth.filter(l => l.kind === 'Import').length, 1);
  assert.equal(h.totals.shows, 2);
  assert.equal(h.totals.booking_spend, 9000);
});

test('a paid line with a $0/missing amount is kept, shown as not recorded', async () => {
  const {sql, cats, event, imported} = await seededDb();
  const A = await event('2026-10-24');
  const row = await imported({ev: A, email: 'barter@example.com', business: 'Barter Co', category: cats.Bags, amount: 0, method: 'cash'});
  const h = await vendorPaymentHistory(sql, {source: 'pdf', id: row.id, email: row.email, phone: row.phone, business: row.business, name: row.name});
  assert.equal(h.lines.length, 1);
  assert.equal(h.lines[0].kind, 'Import');
  assert.equal(h.lines[0].amount, null);
  assert.equal(h.lines[0].amount_recorded, false);
  assert.equal(h.totals.shows, 1);
  assert.equal(h.totals.booking_spend, 0);
});

test('credit-paid lines are shown with their CREDIT trace', async () => {
  const {sql, cats, event, application, booking, imported, refFor} = await seededDb();
  const A = await event('2026-11-28'), B = await event('2026-12-12');
  const app = await application({email: 'credit@example.com', business: 'Credit Crafts', category: cats.Candles});
  await booking({app, ev: A, method: 'Credit', reference: 'CREDIT-ABC12345'});
  // The automatic redeem shape: an imported attendee paid from credit.
  await imported({ev: B, email: 'credit@example.com', business: 'Credit Crafts', category: cats.Candles, method: 'Credit', reference: 'CREDIT-XYZ98765'});
  const h = await vendorPaymentHistory(sql, refFor(app));
  const credits = h.lines.filter(l => l.kind === 'Credit');
  assert.equal(credits.length, 2);
  assert.deepEqual(credits.map(l => l.reference).sort(), ['CREDIT-ABC12345', 'CREDIT-XYZ98765']);
  assert.equal(h.totals.booking_spend, 9000);
});

test('a ledger row settling a booth line attaches as its receipt — never double-counted', async () => {
  const {sql, cats, event, application, booking, ledger, refFor} = await seededDb();
  const A = await event('2026-10-24');
  const app = await application({email: 'ledger@example.com', business: 'Ledger LLC', category: cats.Bags});
  const b = await booking({app, ev: A});
  const vp = await ledger({application_id: app.id, booking_id: b.id, amount: 4500});
  await ledger({application_id: app.id, amount: 2000, method: 'check', note: 'Extra table fee'});
  const h = await vendorPaymentHistory(sql, refFor(app));
  const booth = h.lines.filter(l => l.kind === 'Booking');
  assert.equal(booth.length, 1);
  assert.equal(booth[0].payment_id, vp.id);
  const standalone = h.lines.filter(l => l.kind === 'Recorded payment');
  assert.equal(standalone.length, 1);
  assert.equal(standalone[0].note, 'Extra table fee');
  assert.equal(h.totals.booking_spend, 4500);
  assert.equal(h.totals.recorded_payments, 2000);
});

test('manual past entry: created without any booking, appears in history + totals with its note', async () => {
  const {sql, cats, event, application, refFor} = await seededDb();
  const past = await event('2026-10-03');
  const app = await application({email: 'door@example.com', business: 'Door Cash Co', category: cats.Bags});
  const saved = await recordManualPayment(sql, ORG, {
    application_id: app.id, amount: 45, paid_at: '2026-10-03', payment_method: 'cash',
    event_id: past.id, note: 'Booth fee, October market — paid cash at the door'
  });
  assert.equal(saved.manual_entry, true);
  assert.equal(saved.amount, 4500);
  const h = await vendorPaymentHistory(sql, refFor(app));
  const line = h.lines.find(l => l.kind === 'Manual entry');
  assert.ok(line, 'manual entry line present');
  assert.equal(line.amount, 4500);
  assert.equal(line.note, 'Booth fee, October market — paid cash at the door');
  assert.ok(line.label.startsWith('Booth — '), 'label names the linked market date: ' + line.label);
  assert.equal(h.totals.recorded_payments, 4500);
  // No booking was created or needed.
  const bookings = await sql`select count(*)::int n from market.bookings where application_id=${app.id}`;
  assert.equal(bookings[0].n, 0);
});

test('manual entry for a PDF vendor anchors on the imported row', async () => {
  const {sql, cats, event, imported} = await seededDb();
  const A = await event('2026-08-15');
  const row = await imported({ev: A, email: 'pdf@example.com', business: 'PDF Pots', category: cats.Candles, amount: 0});
  await recordManualPayment(sql, ORG, {imported_attendee_id: row.id, amount: 45, paid_at: '2026-08-15', payment_method: 'GoDaddy Payments', note: 'Booth fee offset — tumblers'});
  const h = await vendorPaymentHistory(sql, {source: 'pdf', id: row.id, email: row.email, phone: row.phone, business: row.business, name: row.name});
  const line = h.lines.find(l => l.kind === 'Manual entry');
  assert.ok(line);
  assert.equal(line.note, 'Booth fee offset — tumblers');
  assert.equal(h.totals.recorded_payments, 4500);
});

test('manual entry rejects non-organizers, bad amounts, impossible dates and unknown methods', async () => {
  const {sql, cats, application} = await seededDb();
  const app = await application({email: 'guard@example.com', business: 'Guard Goods', category: cats.Bags});
  await assert.rejects(recordManualPayment(sql, {email: 'vendor@example.com', admin: false}, {application_id: app.id, amount: 45}), /Organizer access only/);
  await assert.rejects(recordManualPayment(sql, ORG, {application_id: app.id, amount: 0}), /valid payment amount/);
  await assert.rejects(recordManualPayment(sql, ORG, {application_id: app.id, amount: -5}), /valid payment amount/);
  await assert.rejects(recordManualPayment(sql, ORG, {application_id: app.id, amount: 'abc'}), /valid payment amount/);
  await assert.rejects(recordManualPayment(sql, ORG, {application_id: app.id, amount: 45, paid_at: '2027-02-30'}), /valid date paid/);
  await assert.rejects(recordManualPayment(sql, ORG, {application_id: app.id, amount: 45, payment_method: 'Bitcoin'}), /payment method/);
  await assert.rejects(recordManualPayment(sql, ORG, {application_id: crypto.randomUUID(), amount: 45}), /Vendor not found/);
  const rows = await sql`select count(*)::int n from market.vendor_payments`;
  assert.equal(rows[0].n, 0);
});
