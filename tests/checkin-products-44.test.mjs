// §44 — Check-in cards show what the vendor sells (Oct 24, 2026).
// Scott, from the market-day check-in screenshot: "on the check in page,
// show what they sell." The Online Check-In cards showed business /
// contact / space / status but never the vendor's products.
// Fix: the setup-checkin function's admin list rows gain a `products`
// field — application bookings carry the application's CATEGORY NAME
// (join market.categories on applications.category_id; the free-text
// application description does NOT win), imported attendees carry
// coalesce(nullif(i.selling,''),nullif(i.category,''),'Local handmade
// goods') — the exact expression the vendor Directory query uses
// (api.mjs loadSetupRows). The v2 checkin card renders a
// "Sells: <products>" line under the space · status line, only when
// products are present.
import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = p => readFileSync(join(root, p), 'utf8');
const FN = read('netlify/functions/setup-checkin.mjs');
const CHECKIN = read('public/v2/js/checkin.js');
const IMPORTED_COALESCE = "coalesce(nullif(i.selling,''),nullif(i.category,''),'Local handmade goods') products";

// The admin list is the first GET branch of the function (the vendor
// list below it shares the row shape but is out of §44 scope).
const adminSection = src => src.slice(src.indexOf("if(admin){"), src.indexOf('const email=normalizedEmail'));

// ---------------------------------------------------------------- static pins
const productsPins = (fnSrc, checkinSrc) => {
  const admin = adminSection(fnSrc);
  assert.ok(admin.includes('c.name products'), 'the admin booking rows must carry the category name as products');
  assert.ok(admin.includes('join market.categories c on c.id=a.category_id'), 'the admin booking query must join categories on the application');
  assert.ok(admin.includes(IMPORTED_COALESCE), 'the admin imported rows must carry the Directory coalesce as products');
  assert.ok(!admin.includes('a.description products'), 'the application description must not be the booking products');
  assert.ok(checkinSrc.includes('${r.products ? `<div class="contact">Sells: ${esc(r.products)}</div>` : \'\'}'),
    'the card must render a Sells line with the escaped products value, only when present');
  return admin;
};

test('§44: the setup-checkin admin rows and the check-in card carry the products contract', () => {
  productsPins(FN, CHECKIN);
});

test('§44 (negative control): the pins fail if the coalesce, the category join, or the card line is broken', () => {
  const wrongFallback = FN.replace("'Local handmade goods') products", "'Assorted goods') products");
  assert.notEqual(wrongFallback, FN, 'the fallback mutation must change the source');
  assert.throws(() => productsPins(wrongFallback, CHECKIN), /Directory coalesce/);

  const swappedPrecedence = FN.replace(
    "coalesce(nullif(i.selling,''),nullif(i.category,''),'Local handmade goods') products",
    "coalesce(nullif(i.category,''),nullif(i.selling,''),'Local handmade goods') products");
  assert.notEqual(swappedPrecedence, FN, 'the precedence mutation must change the source');
  assert.throws(() => productsPins(swappedPrecedence, CHECKIN), /Directory coalesce/);

  const descriptionWins = FN.replace('c.name products', 'a.description products');
  assert.notEqual(descriptionWins, FN, 'the description mutation must change the source');
  assert.throws(() => productsPins(descriptionWins, CHECKIN), /category name as products/);

  const noCardLine = CHECKIN.replace('Sells: ${esc(r.products)}', 'Offers: ${esc(r.products)}');
  assert.notEqual(noCardLine, CHECKIN, 'the card-line mutation must change the source');
  assert.throws(() => productsPins(FN, noCardLine), /Sells line/);
});

// ---------------------------------------------------------------- behavioral harness
// The real setup-checkin.mjs default handler (imports stripped, core
// mocked onto one PGlite loaded with the real schema files) serving
// GET ?admin=1 for an organizer identity.
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

let db, sql, handler, event, bookingRow, impSelling, impCategory, impFallback;
test.before(async () => {
  db = new PGlite();
  await db.exec('create role anon; create role authenticated; create schema storage; create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);');
  await db.exec(await readFile(join(root, 'database/setup.sql'), 'utf8'));
  await db.exec(await readFile(join(root, 'database/codify-live-schema.sql'), 'utf8'));
  await db.exec(await readFile(join(root, 'database/vendor-credits.sql'), 'utf8'));
  await db.exec(await readFile(join(root, 'database/waitlist-offers.sql'), 'utf8'));
  await db.exec(await readFile(join(root, 'database/vendor-profiles.sql'), 'utf8'));
  sql = pgliteSql(db);
  globalThis.__sql = sql;
  globalThis.__who = { admin: true, manager: false, id: '00000000-0000-4000-8000-0000000000ad', email: 'organizer@example.com' };

  let source = await readFile(join(root, 'netlify/functions/setup-checkin.mjs'), 'utf8');
  source = source.replace(/^import .*$/gm, '');
  const mock = `
const db=()=>globalThis.__sql;
const identity=async()=>globalThis.__who;
const audit=async()=>{};
const queue=async()=>({});
const flushMail=async()=>({});
`;
  ({ default: handler } = await import('data:text/javascript;base64,' + Buffer.from(mock + source).toString('base64')));

  const [loc] = await sql`select id from market.locations order by name limit 1`;
  [event] = await sql`select id from market.events where location_id=${loc.id} and date='2026-11-07'`;
  assert.ok(event, 'the seeded Nov 7 market must exist');
  const [cat] = await sql`select id,name from market.categories where name='Candles'`;
  assert.ok(cat, 'the seeded Candles category must exist');
  bookingRow = { categoryName: cat.name };

  // Application booking: the description is deliberately distinctive so
  // the test proves the CATEGORY name wins, not the free-text description.
  const [app] = await sql`insert into market.applications(user_id,name,email,phone,business,description,category_id,photos,agreements)
    values('00000000-0000-4000-8000-0000000000a1','Clara Chandler','clara@example.com','5551234567','Clara Candles','ZZZ-DESCRIPTION-MUST-NOT-WIN',${cat.id},'[]'::jsonb,'{}'::jsonb) returning id`;
  const [bk] = await sql`insert into market.bookings(application_id,event_id,space,price,status)
    values(${app.id},${event.id},'indoor',4500,'paid') returning id`;
  bookingRow.id = bk.id;

  const mkImported = async (name, business, email, selling, category) => {
    const [row] = await sql`insert into market.imported_attendees(event_id,name,business,email,category,selling,space,payment_status,cancelled)
      values(${event.id},${name},${business},${email},${category},${selling},'Inside','paid',false) returning id`;
    return row.id;
  };
  impSelling = await mkImported('Sam Stone', 'Sam Stoneware', 'sam@example.com', 'Hand-thrown stoneware mugs', 'Pottery & Ceramics');
  impCategory = await mkImported('Wendy Wick', 'Wendy Wicks', 'wendy@example.com', '', 'Soy candles & melts');
  impFallback = await mkImported('Pat Plain', 'Pat Plain Goods', 'pat@example.com', null, null);
});
test.after(async () => { await db.close(); });

const adminRows = async () => {
  const res = await handler(new Request('https://market.test/.netlify/functions/setup-checkin?admin=1'));
  assert.equal(res.status, 200);
  return (await res.json()).rows;
};

test('§44 (behavioral): an application-booking row carries its category name as products', async () => {
  const rows = await adminRows();
  const row = rows.find(r => String(r.record_id) === String(bookingRow.id));
  assert.ok(row, 'the seeded booking must appear in the admin list');
  assert.equal(row.source, 'booking');
  assert.equal(row.products, bookingRow.categoryName, 'products must be the application category name');
  assert.notEqual(row.products, 'ZZZ-DESCRIPTION-MUST-NOT-WIN', 'the free-text description must not win');
});

test('§44 (behavioral): imported rows carry selling text first, then category, then the handmade fallback', async () => {
  const rows = await adminRows();
  const byId = id => rows.find(r => String(r.record_id) === String(id));
  assert.equal(byId(impSelling)?.source, 'imported');
  assert.equal(byId(impSelling)?.products, 'Hand-thrown stoneware mugs', 'selling text wins when present');
  assert.equal(byId(impCategory)?.products, 'Soy candles & melts', 'an empty selling falls back to the category text');
  assert.equal(byId(impFallback)?.products, 'Local handmade goods', 'no selling and no category falls back to Local handmade goods');
});
