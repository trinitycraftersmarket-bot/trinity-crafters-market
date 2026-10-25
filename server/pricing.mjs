// server/pricing.mjs — regular-vendor pricing (AUDIT.md §50).
//
// Scott's rate card (Oct 24, 2026): vendors flagged REGULAR pay a
// per-location indoor rate instead of the standard indoor price —
// $40 at Hampton Inn (Trinity), $60 at Hilton Garden Inn (Lutz),
// against standard $45 / $100. The rate is DATA, not code: it lives on
// market.locations.regular_indoor_price, edited in Setup → Locations,
// seeded by venue match below. A location with no regular price set
// prices regular vendors at the standard rate, exactly as before §50.
//
// Outdoor: Scott has not set a regular outdoor rate — regular vendors
// pay the standard outdoor price until he does (assumption surfaced in
// the §50 build report).
//
// The regular FLAG itself stays in the §47 canonical stores —
// market.applications.regular_vendor for application-sourced vendors,
// market.vendor_profiles.regular_vendor for imported vendors — and
// isRegularVendor reads BOTH (plus any application under the vendor's
// email), the same union the §46 ladder reads. This module owns only
// the price math and the locations column; it never writes flags.
//
// No retroactive repricing: every caller prices NEW work only (a new
// booking, a new invoice charge, a new redemption, a space move's
// reprice). Stored amounts on existing records are never touched here.

// Same normalization as server/profiles.mjs emailKey (kept local so
// this module stays import-free for the test harnesses that inline
// it; the distinct name avoids a collision when a harness inlines
// both modules into one scope).
const pricingEmailKey = e => String(e || '').trim().toLowerCase().replace(/,+$/, '');

const pricingEnsured = new WeakSet();

// The locations column + the venue-match seed. Idempotent (the seed
// only fills rows whose regular price is still unset, so a rate Scott
// edits in Setup is never overwritten). Codified in
// database/codify-live-schema.sql §50; this lazy heal follows the
// codebase's ensure* pattern so live installs gain it without a
// separate migration step.
export async function ensureLocationRegularPrice(sql) {
  if (pricingEnsured.has(sql)) return;
  await sql`alter table market.locations add column if not exists regular_indoor_price integer`;
  await sql`update market.locations set regular_indoor_price = 4000
    where regular_indoor_price is null
      and (lower(name) like '%hampton%' or lower(coalesce(market_name, '')) like '%hampton%')`;
  await sql`update market.locations set regular_indoor_price = 6000
    where regular_indoor_price is null
      and (lower(name) like '%hilton%' or lower(coalesce(market_name, '')) like '%hilton%')`;
  pricingEnsured.add(sql);
}

// Is this vendor regular-flagged in a canonical store? applicationId
// checks that application row directly (monthly billing, move-space);
// email checks the profile store and any application under the email
// (apply, manual booking, credit redeem — paths where the vendor is
// identified by email before a specific application row exists).
export async function isRegularVendor(sql, {email = null, applicationId = null} = {}) {
  if (applicationId) {
    const [a] = await sql`select regular_vendor from market.applications where id = ${applicationId}`;
    if (a?.regular_vendor === true) return true;
  }
  const key = pricingEmailKey(email || '');
  if (key) {
    const [p] = await sql`select regular_vendor from market.vendor_profiles where email = ${key}`;
    if (p?.regular_vendor === true) return true;
    const [a] = await sql`select 1 as x from market.applications where lower(trim(email)) = ${key} and regular_vendor limit 1`;
    if (a) return true;
  }
  return false;
}

// The location's regular indoor price in cents, or null when the
// location carries none (→ caller falls back to the standard price).
export async function regularIndoorPriceFor(sql, locationId) {
  if (!locationId) return null;
  await ensureLocationRegularPrice(sql);
  const [l] = await sql`select regular_indoor_price from market.locations where id = ${locationId}`;
  return l && l.regular_indoor_price != null ? Number(l.regular_indoor_price) : null;
}

// The price (cents) for one space on one event: a regular vendor
// indoors at a location with a regular price pays that price; every
// other combination pays the event's standard price for the space.
// indoorPrice/outdoorPrice are the event's standard prices — except
// in monthly-invoice create-from-bookings, which passes the BOOKING's
// stored price as both, so only the regular override ever moves a
// number there (existing bookings are never repriced by §50).
export async function regularAwarePrice(sql, {locationId = null, space, indoorPrice, outdoorPrice, regular = false} = {}) {
  const indoor = !String(space || '').toLowerCase().startsWith('out');
  if (!indoor) return Number(outdoorPrice || 0);
  if (regular) {
    const rp = await regularIndoorPriceFor(sql, locationId);
    if (rp != null) return rp;
  }
  return Number(indoorPrice || 0);
}
