import test from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {readFile} from 'node:fs/promises';
import {applyPrefill, claimImported, findImportedMatches, getProfile, organizerSaveProfile, presentProfile, profileCompleteness, saveProfile, upsertProfileFromApplication} from '../server/profiles.mjs';
import {createMoveRequest, loadMoveSource} from '../server/moves.mjs';

// Same postgres.js tagged-template adapter as tests/features-a.test.mjs.
function pgliteSql(db) {
  const sql = async (strings, ...values) => {
    let text = '', params = [];
    strings.forEach((s, i) => { text += s; if (i < values.length) { params.push(values[i]); text += '$' + params.length; } });
    return (await db.query(text, params)).rows;
  };
  sql.json = v => JSON.stringify(v); // core.audit() calls tx.json (postgres.js)
  return sql;
}

async function seededDb() {
  const db = new PGlite();
  await db.exec('create role anon; create role authenticated; create schema storage; create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);');
  await db.exec(await readFile('database/setup.sql', 'utf8'));
  await db.exec(await readFile('database/codify-live-schema.sql', 'utf8'));
  await db.exec(await readFile('database/move-requests.sql', 'utf8'));
  await db.exec(await readFile('database/vendor-profiles.sql', 'utf8'));
  const sql = pgliteSql(db);
  const [loc] = await sql`insert into market.locations(name,address,indoor_capacity,outdoor_capacity,indoor_price,outdoor_price) values('Test Hall','1 Test Way',2,1,4500,3500) returning id`;
  const cats = {};
  for (const row of await sql`select id,name from market.categories where name in ('Bags','Candles')`) cats[row.name] = row.id;
  async function event(date) {
    const [e] = await sql`insert into market.events(location_id,date,indoor_capacity,outdoor_capacity,indoor_price,outdoor_price) values(${loc.id},${date},2,1,4500,3500) returning *`;
    return e;
  }
  async function imported({event: ev, email, business = 'PDF Crafts', category = null, vendorId = null}) {
    const [i] = await sql`insert into market.imported_attendees(event_id,vendor_id,name,business,email,phone,category_id,space,invoice_amount,payment_status) values(${ev.id},${vendorId},'Vendor',${business},${email},'7275550100',${category},'indoor',4500,'paid') returning *`;
    return i;
  }
  return {db, sql, loc, cats, event, imported};
}

const user = email => ({id: crypto.randomUUID(), email});

test('profile: vendor self-save creates one row keyed by email, then updates it in place', async () => {
  const {sql, cats} = await seededDb();
  const u = user('Vendor@Example.com');
  const first = await saveProfile(sql, u, {business: 'Bee Crafts', name: 'Bee', category_id: cats.Bags, phone: '(727) 555-0100', description: 'Honey goods', space_preference: 'inside'});
  assert.equal(first.email, 'vendor@example.com'); // match key is lowercased
  assert.equal(first.user_id, u.id);
  assert.equal(first.phone, '7275550100');
  assert.equal(first.space_preference, 'indoor'); // label normalized
  const second = await saveProfile(sql, u, {business: 'Bee Crafts Co', website: 'https://bee.example'});
  assert.equal(second.id, first.id); // same row, not a second copy
  assert.equal(second.business, 'Bee Crafts Co');
  assert.equal(second.description, 'Honey goods'); // omitted fields are preserved
  assert.equal(second.website, 'https://bee.example');
  const rows = await sql`select * from market.vendor_profiles`;
  assert.equal(rows.length, 1);
});

test('profile: completeness counts filled fields and names what is missing', async () => {
  assert.deepEqual(profileCompleteness(null), {percent: 0, missing: ['business', 'name', 'category_id', 'description', 'phone', 'space_preference', 'website', 'social_links']});
  assert.deepEqual(profileCompleteness({business: 'B', name: 'N', category_id: 'x', description: 'D', phone: '1', space_preference: 'indoor', website: 'w', social_links: 's'}), {percent: 100, missing: []});
  const half = profileCompleteness({business: 'B', name: 'N', phone: '1', description: 'D'});
  assert.equal(half.percent, 50);
  assert.deepEqual(half.missing, ['category_id', 'space_preference', 'website', 'social_links']);
});

test('profile: application submit creates the profile; a later submit refreshes it', async () => {
  const {sql, cats} = await seededDb();
  const u = user('apply@example.com');
  const [master] = await sql`insert into market.vendors(name,business,email,phone) values('Ann','Ann Arts','apply@example.com','7275550100') returning id`;
  // Profile-only extras saved from My Profile must survive an application.
  await saveProfile(sql, u, {website: 'https://ann.example', space_preference: 'outdoor'});
  await upsertProfileFromApplication(sql, {user: u, vendorId: master.id, fields: {name: 'Ann', business: 'Ann Arts', phone: '7275550100', description: 'Paintings', category_id: cats.Bags}});
  let p = await getProfile(sql, {email: 'apply@example.com'});
  assert.equal(p.business, 'Ann Arts');
  assert.equal(p.category_id, cats.Bags);
  assert.equal(p.vendor_id, master.id);
  assert.equal(p.website, 'https://ann.example');
  assert.equal(p.space_preference, 'outdoor');
  await upsertProfileFromApplication(sql, {user: u, vendorId: master.id, fields: {name: 'Ann', business: 'Ann Arts & Crafts', phone: '7275550100', description: 'Paintings and prints', category_id: cats.Candles}});
  p = await getProfile(sql, {email: 'apply@example.com'});
  assert.equal(p.business, 'Ann Arts & Crafts');
  assert.equal(p.category_id, cats.Candles);
  const rows = await sql`select * from market.vendor_profiles`;
  assert.equal(rows.length, 1); // still one row per vendor
});

test('profile: applyPrefill maps the stored profile to the application form fields', async () => {
  const {sql, cats} = await seededDb();
  const u = user('prefill@example.com');
  const saved = await saveProfile(sql, u, {business: 'Prefill Co', name: 'Pat', category_id: cats.Candles, phone: '7275550100', description: 'Candles', space_preference: 'none', website: 'https://p.example'});
  assert.deepEqual(applyPrefill(saved), {name: 'Pat', business: 'Prefill Co', phone: '7275550100', description: 'Candles', category_id: cats.Candles, space_preference: 'none'});
  assert.equal(applyPrefill(null), null);
  assert.equal(presentProfile(saved).completeness.percent, 88); // 7 of 8 (social links empty)
});

test('imported match: verified email matches imported rows across events; a different email matches none', async () => {
  const {sql, cats, event, imported} = await seededDb();
  const A = await event('2027-03-06'), B = await event('2027-03-13');
  // PDF-imported emails can be messy: mixed case and a trailing comma.
  await imported({event: A, email: 'Imp@Example.com,', category: cats.Bags});
  await imported({event: B, email: 'imp@example.com', category: cats.Bags});
  await imported({event: A, email: 'someone-else@example.com', category: cats.Bags});
  const matches = await findImportedMatches(sql, 'imp@example.com');
  assert.equal(matches.length, 2); // both events
  assert.deepEqual(matches.map(m => m.event_id).sort(), [A.id, B.id].sort());
  assert.equal((await findImportedMatches(sql, 'nobody@example.com')).length, 0);
});

test('claim: first match links imported ids and the account onto the profile, idempotently', async () => {
  const {sql, cats, event, imported} = await seededDb();
  const A = await event('2027-03-06'), B = await event('2027-03-13');
  const u = user('imp@example.com');
  await saveProfile(sql, u, {business: 'PDF Crafts', description: 'Wood signs'});
  const i1 = await imported({event: A, email: 'imp@example.com', category: cats.Bags});
  const i2 = await imported({event: B, email: 'imp@example.com', category: cats.Bags});
  const claim = await claimImported(sql, u);
  assert.equal(claim.matched, 2);
  assert.deepEqual([...claim.profile.linked_imported_ids].sort(), [i1.id, i2.id].sort());
  assert.equal(claim.profile.user_id, u.id);
  assert.ok(claim.profile.claimed_at);
  assert.equal(claim.profile.business, 'PDF Crafts'); // claiming never overwrites profile data
  const again = await claimImported(sql, u);
  assert.equal(again.matched, 2);
  assert.deepEqual([...again.profile.linked_imported_ids].sort(), [i1.id, i2.id].sort()); // no duplicates
  const rows = await sql`select * from market.vendor_profiles`;
  assert.equal(rows.length, 1);
  // Imported rows were NOT merged into bookings.
  assert.equal((await sql`select count(*)::int as n from market.bookings`)[0].n, 0);
});

test('claim: an account email change re-matches by the new verified email', async () => {
  const {sql, cats, event, imported} = await seededDb();
  const A = await event('2027-03-06');
  const uid = crypto.randomUUID();
  const oldRow = await imported({event: A, email: 'old@example.com', category: cats.Bags});
  const newRow = await imported({event: A, email: 'new@example.com', category: cats.Bags});
  const first = await claimImported(sql, {id: uid, email: 'old@example.com'});
  assert.deepEqual(first.profile.linked_imported_ids, [oldRow.id]);
  const second = await claimImported(sql, {id: uid, email: 'new@example.com'});
  // Same profile row (found by user_id), now carrying both matches.
  assert.equal(second.profile.id, first.profile.id);
  assert.deepEqual([...second.profile.linked_imported_ids].sort(), [oldRow.id, newRow.id].sort());
  assert.equal(second.profile.email, 'new@example.com');
});

test('imported self-service: a move request can be created from a claimed imported record', async () => {
  const {sql, cats, event, imported} = await seededDb();
  const A = await event('2027-03-06'), B = await event('2027-03-20');
  const u = user('imp@example.com');
  const row = await imported({event: A, email: 'imp@example.com', category: cats.Bags});
  const claim = await claimImported(sql, u);
  assert.deepEqual(claim.profile.linked_imported_ids, [row.id]);
  const source = await loadMoveSource(sql, 'imported', row.id);
  const {request} = await createMoveRequest(sql, {source, targetEventId: B.id, reason: 'Schedule conflict', user: u});
  assert.equal(request.status, 'pending');
  assert.equal(request.source_type, 'imported');
  assert.equal(request.vendor_email, 'imp@example.com');
});

test('organizer: profile can be created for an account-less vendor, then claimed on sign-in', async () => {
  const {sql, cats} = await seededDb();
  const ORG = {email: 'org@example.com'};
  const saved = await organizerSaveProfile(sql, {actor: ORG, email: 'WalkIn@Example.com', fields: {business: 'Walk-In Wares', space_preference: 'outdoor', category_id: cats.Bags}});
  assert.equal(saved.user_id, null); // no account yet
  assert.equal(saved.email, 'walkin@example.com');
  const auditRows = await sql`select * from market.audit where action = 'vendor profile updated'`;
  assert.equal(auditRows.length, 1);
  // The vendor later signs in with that email and edits from My Profile:
  // the same row gains the account link instead of a second row appearing.
  const mine = await saveProfile(sql, user('walkin@example.com'), {phone: '7275550100'});
  assert.equal(mine.id, saved.id);
  assert.ok(mine.user_id);
  assert.equal(mine.business, 'Walk-In Wares');
  const rows = await sql`select * from market.vendor_profiles`;
  assert.equal(rows.length, 1);
});

test('wiring: api.mjs claims on mine and upserts on apply; vendor-profile function exposes the actions', async () => {
  const api = await readFile('netlify/functions/api.mjs', 'utf8');
  assert.ok(api.includes('claimImported(sql,u)'), 'mine payload records the imported claim');
  assert.ok(api.includes('upsertProfileFromApplication(tx,'), 'apply upserts the profile');
  assert.ok(api.includes('from market.vendor_profiles p where p.email='), 'vendor-list carries the profile');
  const fn = await readFile('netlify/functions/vendor-profile.mjs', 'utf8');
  for (const action of ["'get'", "'save'", "'organizer-get'", "'organizer-save'"]) assert.ok(fn.includes(`p.action === ${action}`), `vendor-profile handles ${action}`);
  const migration = await readFile('database/vendor-profiles.sql', 'utf8');
  assert.ok(migration.includes('create table if not exists market.vendor_profiles'));
});
