// Vendor profiles (AUDIT.md §13.7) and imported-vendor claiming (§13.5).
//
// market.vendor_profiles holds one row per vendor, keyed by the lowercased
// account email. It serves two features:
//
// 1. My Profile — the vendor's reusable application answers. The apply flow
//    pre-fills from the profile and upserts it on submit, so a returning
//    vendor's business / category / products / phone are already filled in.
//    The organizer edits the SAME row from the Vendors panel — there is no
//    second copy of this data.
//
// 2. Imported-vendor claiming — imported_attendees has no user_id column,
//    so when a signed-in vendor's verified email matches imported rows (the
//    same match the `mine` payload already uses), the link is recorded here:
//    the profile gains the account's user_id and the matched imported ids
//    in linked_imported_ids. The imported rows themselves are never merged
//    into bookings — the twin model stays, and server/counts.mjs dedupes.
import {audit} from './core.mjs';
import {normalizePhone} from './rules.mjs';

export const emailKey = e => String(e || '').trim().toLowerCase().replace(/,+$/, '');

// The fields that make a profile "complete" (§13.7): everything the apply
// form asks for that a profile can answer, plus the profile-only extras.
export const COMPLETENESS_FIELDS = ['business', 'name', 'category_id', 'description', 'phone', 'address', 'space_preference', 'website', 'social_links'];

export const SPACE_PREFERENCES = ['', 'indoor', 'outdoor', 'none'];

export async function ensureProfileSchema(sql) {
  await sql`create table if not exists market.vendor_profiles(
    id uuid primary key default gen_random_uuid(),
    user_id uuid,
    email text not null unique,
    vendor_id uuid references market.vendors(id),
    name text not null default '',
    business text not null default '',
    category_id uuid references market.categories(id),
    description text not null default '',
    phone text not null default '',
    address text not null default '',
    space_preference text not null default '' check (space_preference in ('', 'indoor', 'outdoor', 'none')),
    website text not null default '',
    social_links text not null default '',
    linked_imported_ids jsonb not null default '[]'::jsonb,
    claimed_at timestamptz,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now())`;
  // Address shipped after the table first did — add it to existing tables.
  await sql`alter table market.vendor_profiles add column if not exists address text not null default ''`;
  await sql`create index if not exists vendor_profiles_user_idx on market.vendor_profiles(user_id)`;
}

export function profileCompleteness(profile) {
  if (!profile) return {percent: 0, missing: [...COMPLETENESS_FIELDS]};
  const missing = COMPLETENESS_FIELDS.filter(f => {
    const v = profile[f];
    return v == null || (typeof v === 'string' && !v.trim());
  });
  return {percent: Math.round(100 * (COMPLETENESS_FIELDS.length - missing.length) / COMPLETENESS_FIELDS.length), missing};
}

export function presentProfile(row) {
  if (!row) return null;
  return {
    id: row.id, user_id: row.user_id || null, email: row.email, vendor_id: row.vendor_id || null,
    name: row.name || '', business: row.business || '', category_id: row.category_id || null,
    description: row.description || '', phone: row.phone || '', address: row.address || '',
    space_preference: row.space_preference || '', website: row.website || '', social_links: row.social_links || '',
    linked_imported_ids: Array.isArray(row.linked_imported_ids) ? row.linked_imported_ids : [],
    claimed_at: row.claimed_at || null, updated_at: row.updated_at || null,
    completeness: profileCompleteness(row)
  };
}

// The subset the application form pre-fills (§13.7).
export function applyPrefill(row) {
  if (!row) return null;
  return {name: row.name || '', business: row.business || '', phone: row.phone || '', address: row.address || '', description: row.description || '', category_id: row.category_id || null, space_preference: row.space_preference || ''};
}

const cleanText = (v, max) => v == null ? undefined : String(v).trim().slice(0, max);

export function normalizeSpacePreference(v) {
  if (v == null) return undefined;
  const s = String(v).trim().toLowerCase();
  if (s === '' ) return '';
  if (s === 'indoor' || s === 'inside') return 'indoor';
  if (s === 'outdoor' || s === 'outside') return 'outdoor';
  if (s === 'none' || s === 'no preference' || s === 'either') return 'none';
  throw Error('Choose a space preference: indoor, outdoor, or no preference.');
}

// Clean a partial profile payload. Only keys actually present in `p` come
// back — callers merge them over the stored row, so an omitted field is
// never cleared by accident. '' clears a text field on purpose.
export function cleanProfileFields(p = {}) {
  const out = {};
  if ('name' in p) out.name = cleanText(p.name, 200) ?? '';
  if ('business' in p) out.business = cleanText(p.business, 200) ?? '';
  if ('description' in p) out.description = cleanText(p.description, 5000) ?? '';
  if ('address' in p) out.address = cleanText(p.address, 500) ?? '';
  if ('website' in p) out.website = cleanText(p.website, 500) ?? '';
  if ('social_links' in p) out.social_links = cleanText(p.social_links, 1000) ?? '';
  if ('phone' in p) {
    const raw = String(p.phone ?? '').trim();
    if (!raw) out.phone = '';
    else {
      const phone = normalizePhone(raw);
      if (phone.length < 10 || phone.length > 15) throw Error('Enter a valid phone number.');
      out.phone = phone;
    }
  }
  if ('space_preference' in p) out.space_preference = normalizeSpacePreference(p.space_preference);
  if ('category_id' in p) {
    const c = p.category_id == null ? '' : String(p.category_id).trim();
    out.category_id = c || null;
  }
  return out;
}

async function assertCategory(sql, categoryId, {activeOnly = false} = {}) {
  if (!categoryId) return;
  const [cat] = await sql`select id, active from market.categories where id = ${categoryId}`;
  if (!cat || (activeOnly && !cat.active)) throw Error('Choose an active category.');
}

export async function getProfile(sql, {userId = null, email = null} = {}) {
  if (userId) {
    const [byUser] = await sql`select * from market.vendor_profiles where user_id = ${userId}`;
    if (byUser) return byUser;
  }
  if (email) {
    const [byEmail] = await sql`select * from market.vendor_profiles where email = ${emailKey(email)}`;
    if (byEmail) return byEmail;
  }
  return null;
}

// Full-column write of a merged row (insert when `existing` is null). The
// merge happens in JS so every save path shares the exact same semantics
// (and the PGlite test adapter needs no dynamic-SQL helpers).
async function writeProfile(sql, existing, row) {
  if (existing) {
    const [saved] = await sql`update market.vendor_profiles set
      user_id = ${row.user_id}, email = ${row.email}, vendor_id = ${row.vendor_id}, name = ${row.name}, business = ${row.business},
      category_id = ${row.category_id}, description = ${row.description}, phone = ${row.phone}, address = ${row.address},
      space_preference = ${row.space_preference}, website = ${row.website}, social_links = ${row.social_links},
      linked_imported_ids = ${JSON.stringify(row.linked_imported_ids || [])}::jsonb,
      claimed_at = ${row.claimed_at}, updated_at = now()
      where id = ${existing.id} returning *`;
    return saved;
  }
  const [saved] = await sql`insert into market.vendor_profiles
    (user_id, email, vendor_id, name, business, category_id, description, phone, address, space_preference, website, social_links, linked_imported_ids, claimed_at)
    values (${row.user_id}, ${row.email}, ${row.vendor_id}, ${row.name}, ${row.business}, ${row.category_id}, ${row.description}, ${row.phone}, ${row.address}, ${row.space_preference}, ${row.website}, ${row.social_links}, ${JSON.stringify(row.linked_imported_ids || [])}::jsonb, ${row.claimed_at})
    returning *`;
  return saved;
}

const blankRow = email => ({user_id: null, email, vendor_id: null, name: '', business: '', category_id: null, description: '', phone: '', address: '', space_preference: '', website: '', social_links: '', linked_imported_ids: [], claimed_at: null});

// Find the canonical profile for an account: the row keyed by the current
// verified email wins; a row found only by user_id is the same vendor
// before an account email change and gets re-keyed on write. If both
// exist as separate rows (email changed AND an organizer stub was created
// under the new email), fold the stale row into the current-email row and
// delete it — there is always exactly one profile per vendor.
export async function resolveProfile(sql, {userId = null, email = null} = {}) {
  const byEmail = email ? await getProfile(sql, {email}) : null;
  const byUser = userId ? await getProfile(sql, {userId}) : null;
  if (byEmail && byUser && byEmail.id !== byUser.id) {
    const merged = {...byEmail};
    for (const f of ['name', 'business', 'description', 'phone', 'address', 'space_preference', 'website', 'social_links']) if (!merged[f]) merged[f] = byUser[f] || '';
    merged.category_id = byEmail.category_id || byUser.category_id || null;
    merged.vendor_id = byEmail.vendor_id || byUser.vendor_id || null;
    merged.linked_imported_ids = [...new Set([...(byEmail.linked_imported_ids || []), ...(byUser.linked_imported_ids || [])].map(String))];
    merged.claimed_at = byEmail.claimed_at || byUser.claimed_at || null;
    merged.user_id = userId;
    await sql`delete from market.vendor_profiles where id = ${byUser.id}`;
    return merged;
  }
  return byEmail || byUser || null;
}

// Vendor self-save from My Profile. Keyed by the verified account email;
// links the account (user_id) and, when known, the master vendor row.
export async function saveProfile(sql, user, fields = {}) {
  await ensureProfileSchema(sql);
  const clean = cleanProfileFields(fields);
  if ('category_id' in clean) await assertCategory(sql, clean.category_id, {activeOnly: true});
  const existing = await resolveProfile(sql, {userId: user.id, email: user.email});
  const row = {...blankRow(emailKey(user.email)), ...(existing || {}), ...clean, email: emailKey(user.email), user_id: user.id};
  if (!row.vendor_id) {
    const [master] = await sql`select id from market.vendors where lower(trim(email)) = ${row.email} limit 1`;
    if (master) row.vendor_id = master.id;
  }
  return writeProfile(sql, existing, row);
}

// Apply-flow upsert (§13.7): submitting an application refreshes the
// profile with the values the vendor actually used. The five form fields
// are all required by the form, so they overwrite; profile-only fields
// (space preference, website, social links) are left alone. The form's
// Billing address becomes the profile address when the application
// provides one — a blank billing address never clears a saved address.
export async function upsertProfileFromApplication(sql, {user, vendorId = null, fields = {}}) {
  await ensureProfileSchema(sql);
  const appFields = {name: fields.name, business: fields.business, phone: fields.phone, description: fields.description, category_id: fields.category_id};
  if (typeof fields.billing_address === 'string' && fields.billing_address.trim()) appFields.address = fields.billing_address;
  const clean = cleanProfileFields(appFields);
  const existing = await resolveProfile(sql, {userId: user.id, email: user.email});
  const row = {...blankRow(emailKey(user.email)), ...(existing || {}), ...clean, email: emailKey(user.email), user_id: user.id, vendor_id: vendorId || existing?.vendor_id || null};
  return writeProfile(sql, existing, row);
}

// Organizer save from the Vendors panel. Keyed by the vendor's email; may
// create a profile for a vendor who has no account yet (user_id stays
// null until they sign in and the row is claimed by email).
export async function organizerSaveProfile(sql, {actor, email, fields = {}}) {
  await ensureProfileSchema(sql);
  const key = emailKey(email);
  if (!key) throw Error('Vendor email is required.');
  const clean = cleanProfileFields(fields);
  if ('category_id' in clean) await assertCategory(sql, clean.category_id);
  const existing = await getProfile(sql, {email: key});
  const row = {...blankRow(key), ...(existing || {}), ...clean, email: key};
  if (!row.vendor_id) {
    const [master] = await sql`select id from market.vendors where lower(trim(email)) = ${key} limit 1`;
    if (master) row.vendor_id = master.id;
  }
  const saved = await writeProfile(sql, existing, row);
  await audit(sql, actor, 'vendor profile updated', {email: key, fields: Object.keys(clean)});
  return saved;
}

// Imported rows belonging to an email — the exact match the `mine` payload
// uses (case-insensitive; PDF-imported emails may carry stray spaces or a
// trailing comma). ONLY ever call this with the verified account email
// from identity(), never with user-typed input (§13.5 safety rule).
export async function findImportedMatches(sql, email) {
  const key = emailKey(email);
  if (!key) return [];
  return sql`select i.* from market.imported_attendees i where lower(trim(both ' ,' from i.email)) = ${key} order by i.created_at`;
}

// Record the claim (§13.5): the matched imported rows attach to the
// vendor's profile. Creates the profile stub on first match, links the
// account, and unions the matched imported ids into linked_imported_ids.
// Existing profile data is never overwritten by a claim.
export async function claimImported(sql, user) {
  await ensureProfileSchema(sql);
  const matches = await findImportedMatches(sql, user.email);
  const existing = await resolveProfile(sql, {userId: user.id, email: user.email});
  if (!matches.length) return {profile: existing ? presentProfile(existing) : null, matched: 0, importedIds: []};
  const ids = matches.map(r => String(r.id));
  const linked = [...new Set([...(existing?.linked_imported_ids || []).map(String), ...ids])];
  const vendorIds = [...new Set(matches.map(r => r.vendor_id).filter(Boolean).map(String))];
  const row = {...blankRow(emailKey(user.email)), ...(existing || {}), email: emailKey(user.email),
    user_id: user.id,
    vendor_id: existing?.vendor_id || (vendorIds.length === 1 ? vendorIds[0] : null),
    linked_imported_ids: linked,
    claimed_at: existing?.claimed_at || new Date()};
  let saved;
  try {
    saved = await writeProfile(sql, existing, row);
  } catch (e) {
    // Live-data guard: an imported row can carry a vendor_id that no longer
    // resolves in market.vendors (merged/deleted vendor records). The claim
    // itself must not fail over a dangling link — retry unlinked.
    if (row.vendor_id == null) throw e;
    console.error('claimImported: write failed with vendor_id, retrying unlinked', e);
    saved = await writeProfile(sql, existing, {...row, vendor_id: null});
  }
  return {profile: presentProfile(saved), matched: matches.length, importedIds: ids};
}
