-- Vendor cancellation credits and self-service redemption.
-- Credit values are stored in cents. These tables are accessed only by authenticated
-- server-side functions; direct anon/authenticated table access is revoked.

create table if not exists market.vendor_credits(
  id uuid primary key default gen_random_uuid(),
  vendor_id uuid references market.vendors(id) on delete set null,
  email text not null,
  category_id uuid not null references market.categories(id),
  source_type text not null check(source_type in ('booking','imported')),
  source_id uuid not null,
  source_event_id uuid not null references market.events(id),
  original_amount integer not null check(original_amount > 0),
  remaining_amount integer not null check(remaining_amount >= 0 and remaining_amount <= original_amount),
  status text not null default 'available' check(status in ('available','used','void')),
  issued_by text not null,
  issued_at timestamptz not null default now(),
  note text not null default '',
  last_redeemed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(source_type,source_id)
);

create table if not exists market.vendor_credit_redemptions(
  id uuid primary key default gen_random_uuid(),
  credit_id uuid not null references market.vendor_credits(id) on delete restrict,
  imported_attendee_id uuid not null references market.imported_attendees(id) on delete restrict,
  event_id uuid not null references market.events(id) on delete restrict,
  amount integer not null check(amount > 0),
  created_at timestamptz not null default now(),
  unique(imported_attendee_id)
);

create index if not exists vendor_credits_email_available_idx
  on market.vendor_credits(lower(email),status)
  where remaining_amount > 0;

create index if not exists vendor_credit_redemptions_credit_idx
  on market.vendor_credit_redemptions(credit_id,created_at desc);

alter table market.vendor_credits enable row level security;
alter table market.vendor_credit_redemptions enable row level security;
revoke all on market.vendor_credits, market.vendor_credit_redemptions from anon, authenticated;
