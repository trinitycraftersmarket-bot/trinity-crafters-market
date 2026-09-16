create table if not exists market.staff(email text primary key check(email=lower(email)), name text not null, active boolean not null default true);
create table if not exists market.shopper_rsvps(id uuid primary key default gen_random_uuid(), event_id uuid not null references market.events, user_id uuid not null, name text not null, email text not null, party_size integer not null check(party_size between 1 and 20), referral_source text not null, referral_group text not null default '', created_at timestamptz not null default now(), unique(event_id,user_id));
create table if not exists market.vendor_messages(id uuid primary key default gen_random_uuid(), application_id uuid not null references market.applications, sender text not null, body text not null, created_at timestamptz not null default now());
alter table market.staff enable row level security;
alter table market.shopper_rsvps enable row level security;
alter table market.vendor_messages enable row level security;
revoke all on market.staff,market.shopper_rsvps,market.vendor_messages from anon,authenticated;
