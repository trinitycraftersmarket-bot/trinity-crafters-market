-- Vendor date-move requests (AUDIT.md §9, owner decisions §13.3/§13.4).
-- A vendor asks to move a confirmed booking to a different market date; an
-- organizer (admin, or staff holding the `moves:approve` permission) approves
-- or declines. The booking itself does not change until approval.
-- Canonical definition; netlify/functions/move-requests.mjs also creates this
-- table lazily (create if not exists) so the feature works on deploy, per the
-- bug-reports precedent. Access is server-side only (service role via
-- Netlify functions); direct anon/authenticated access is revoked.

create table if not exists market.move_requests (
  id uuid primary key default gen_random_uuid(),
  source_type text not null check (source_type in ('booking','imported')),
  source_id uuid not null,
  vendor_email text not null,
  from_event_id uuid not null references market.events(id),
  to_event_id uuid not null references market.events(id),
  space text not null check (space in ('indoor','outdoor')),
  reason text not null default '',
  status text not null default 'pending'
    check (status in ('pending','approved','declined','cancelled')),
  requested_at timestamptz not null default now(),
  decided_at timestamptz,
  decided_by text,
  decision_note text not null default ''
);

-- One live (pending) request per source record; decided history is kept.
create unique index if not exists move_requests_one_pending_idx
  on market.move_requests(source_type, source_id)
  where status = 'pending';

create index if not exists move_requests_status_idx
  on market.move_requests(status, requested_at);

alter table market.move_requests enable row level security;
revoke all on market.move_requests from anon, authenticated;
