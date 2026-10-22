-- Waitlist auto-offer (AUDIT.md §12, owner decision §13.6: 12-hour window).
-- bookings.waitlisted_at records when a booking entered the waitlist; queue
-- order is waitlisted_at. market.waitlist_offers is the offer history: one row
-- per offer made (auto scan or organizer override), with its outcome. The
-- history doubles as the exclusion list for "the same opening" — a vendor
-- whose offer expired or was declined is not re-offered that opening.
-- Canonical definition; server/waitlist.mjs also ensures both objects lazily
-- (create/add if not exists) so the feature works on deploy, per the
-- bug-reports precedent. Access is server-side only.

alter table market.bookings
  add column if not exists waitlisted_at timestamptz;

create table if not exists market.waitlist_offers (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null references market.bookings(id),
  event_id uuid not null references market.events(id),
  offered_at timestamptz not null default now(),
  expires_at timestamptz not null,
  state text not null default 'offered'
    check (state in ('offered','accepted','declined','expired','superseded')),
  offered_by text not null default 'auto' check (offered_by in ('auto','organizer')),
  override boolean not null default false,
  created_at timestamptz not null default now()
);

create index if not exists waitlist_offers_booking_idx
  on market.waitlist_offers(booking_id, created_at desc);

create index if not exists waitlist_offers_event_state_idx
  on market.waitlist_offers(event_id, state, expires_at);

alter table market.waitlist_offers enable row level security;
revoke all on market.waitlist_offers from anon, authenticated;
