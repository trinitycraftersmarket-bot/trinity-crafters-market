-- Vendor My Profile (AUDIT.md §13.7) + imported-vendor email match (§13.5).
-- One row per vendor, keyed by the lowercased account/match email. The
-- profile holds the vendor's reusable application answers (business,
-- category, products, phone, space preference, links) so applying pre-fills
-- from it and submitting an application refreshes it. It is also the link
-- record for imported-vendor claiming: imported_attendees has no user_id
-- column, so when a signed-in vendor's verified email matches imported rows,
-- the matched imported ids are recorded in linked_imported_ids here (the
-- imported rows themselves are never merged into bookings — the twin model
-- and server/counts.mjs dedupe stay as they are).
-- Canonical definition; server/profiles.mjs also creates this table lazily
-- (create if not exists) so the feature works on deploy, per the
-- bug-reports / move-requests precedent. Access is server-side only
-- (service role via Netlify functions); direct anon/authenticated access is
-- revoked.

create table if not exists market.vendor_profiles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid,
  email text not null unique,
  vendor_id uuid references market.vendors(id),
  name text not null default '',
  business text not null default '',
  category_id uuid references market.categories(id),
  description text not null default '',
  phone text not null default '',
  space_preference text not null default ''
    check (space_preference in ('', 'indoor', 'outdoor', 'none')),
  website text not null default '',
  social_links text not null default '',
  linked_imported_ids jsonb not null default '[]'::jsonb,
  claimed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists vendor_profiles_user_idx
  on market.vendor_profiles(user_id);

alter table market.vendor_profiles enable row level security;
revoke all on market.vendor_profiles from anon, authenticated;
