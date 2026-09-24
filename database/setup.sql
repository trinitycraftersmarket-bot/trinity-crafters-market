-- Run once in a NEW, dedicated Supabase project's SQL editor.
create schema if not exists market;
revoke all on schema market from public, anon, authenticated;
create table market.locations(id uuid primary key default gen_random_uuid(), name text not null, address text not null, indoor_capacity int not null default 9 check(indoor_capacity>=0), outdoor_capacity int not null default 3 check(outdoor_capacity>=0), indoor_price int not null default 4500 check(indoor_price>=0), outdoor_price int not null default 3000 check(outdoor_price>=0));
create table market.categories(id uuid primary key default gen_random_uuid(), name text unique not null, active boolean not null default true, vendor_limit int not null default 1 check(vendor_limit>0));
create table market.events(id uuid primary key default gen_random_uuid(), location_id uuid not null references market.locations, date date not null, title text not null default 'Trinity Crafters Market', indoor_capacity int not null default 9 check(indoor_capacity>=0), outdoor_capacity int not null default 3 check(outdoor_capacity>=0), indoor_price int not null default 4500 check(indoor_price>=0), outdoor_price int not null default 3000 check(outdoor_price>=0), open boolean not null default true, sold_out boolean not null default false, calendar_id text unique, sync_alert text, unique(location_id,date));
create table market.bans(id uuid primary key default gen_random_uuid(), user_id uuid, name text not null, email text, phone text, reason text not null, active boolean not null default true, created_at timestamptz not null default now(), check(user_id is not null or email is not null or phone is not null));
create table market.applications(id uuid primary key default gen_random_uuid(), user_id uuid not null, name text not null, email text not null, phone text not null, billing_address text not null default '', business text not null, description text not null, category_id uuid not null references market.categories, exception_reason text not null default '', referral_source text not null default '', referral_group text not null default '', ban_flagged boolean not null default false, ban_match_reason text not null default '', review_notes text not null default '', photos jsonb not null, agreements jsonb not null, terms_version text not null default '2026-09-v3', created_at timestamptz not null default now());
create table market.bookings(id uuid primary key default gen_random_uuid(), application_id uuid not null references market.applications, event_id uuid not null references market.events, space text not null check(space in ('indoor','outdoor')), price int not null check(price>=0), status text not null default 'pending' check(status in ('pending','waitlist','approved','held','paid','expired','declined','cancelled')), category_exception boolean not null default false, checked_in boolean not null default false, no_show boolean not null default false, waitlist_offered_at timestamptz, payment_method text not null default '', hold_until timestamptz, invoice_reference text, payment_reference text, decision_reason text, paid_at timestamptz, unique(application_id,event_id));
create table market.audit(id bigint generated always as identity primary key, actor text not null, action text not null, detail jsonb not null default '{}', created_at timestamptz not null default now());
create table market.outbox(id uuid primary key default gen_random_uuid(), recipient text not null, subject text not null, body text not null, sent_at timestamptz, error text, created_at timestamptz not null default now());
create table market.settings(key text primary key, value text not null);
create table market.expenses(id uuid primary key default gen_random_uuid(), expense_date date not null default (now() at time zone 'America/New_York')::date, event_id uuid references market.events on delete set null, description text not null, category text not null default 'General', amount int not null check(amount>0), notes text not null default '', created_at timestamptz not null default now());
create index on market.bookings(event_id,status);
create index on market.applications(user_id);
create index on market.bans(email) where active;
create index on market.bans(phone) where active;
create index on market.expenses(expense_date);
-- No Data API access. Only authenticated Netlify server operations access this schema.
alter table market.locations enable row level security;
alter table market.categories enable row level security;
alter table market.events enable row level security;
alter table market.bans enable row level security;
alter table market.applications enable row level security;
alter table market.bookings enable row level security;
alter table market.audit enable row level security;
alter table market.outbox enable row level security;
alter table market.settings enable row level security;
alter table market.expenses enable row level security;
insert into market.locations(id,name,address) values('11111111-1111-4111-8111-111111111111','Hampton Inn Odessa Trinity','11780 State Rd 54, Odessa, FL 33556');
insert into market.events(location_id,date,calendar_id) select '11111111-1111-4111-8111-111111111111',d::date,'gj46qn83oia8ld9ccdngi5s8na_'||replace(d,'-','')||case when d<'2026-11-01' then 'T140000Z' else 'T150000Z' end from unnest(array['2026-09-26','2026-10-10','2026-10-24','2026-11-07','2026-11-21','2026-12-05','2026-12-19']) d;
insert into market.categories(name) values ('3D Printed Art');
insert into market.categories(name) values ('Accessories (No Jewelry)');
insert into market.categories(name) values ('Art (Home Decor)');
insert into market.categories(name) values ('Art (Wall Decor)');
insert into market.categories(name) values ('Aromatherapy');
insert into market.categories(name) values ('Bags');
insert into market.categories(name) values ('Body Scrubs');
insert into market.categories(name) values ('Bread Baked Goods');
insert into market.categories(name) values ('Cookies, Cinnamon Rolls etc.');
insert into market.categories(name) values ('Candles');
insert into market.categories(name) values ('Candy');
insert into market.categories(name) values ('Children’s Products');
insert into market.categories(name) values ('Clothing');
insert into market.categories(name) values ('Crochet Plush Toys');
insert into market.categories(name) values ('Crystals (No Jewelry)');
insert into market.categories(name) values ('Drinks (Non-alcoholic)');
insert into market.categories(name) values ('Handmade Jewelry (No Paparazzi)');
insert into market.categories(name) values ('Hats');
insert into market.categories(name) values ('International Treasures');
insert into market.categories(name) values ('Jams and Salsa');
insert into market.categories(name) values ('Lanterns');
insert into market.categories(name) values ('Mugs and Glassware (No Tumblers)');
insert into market.categories(name) values ('Other (Do not use for a sold-out category)');
insert into market.categories(name) values ('Perfume');
insert into market.categories(name) values ('Permanent Jewelry');
insert into market.categories(name) values ('Pet Supplies');
insert into market.categories(name) values ('Pet Treats');
insert into market.categories(name) values ('Pottery and Ceramics');
insert into market.categories(name) values ('Quilts');
insert into market.categories(name) values ('Resin Art (No Jewelry)');
insert into market.categories(name) values ('Scrap Books and Cards');
insert into market.categories(name) values ('Service Business / Non-Profit (No MLM)');
insert into market.categories(name) values ('Sewed Goods');
insert into market.categories(name) values ('Soap');
insert into market.categories(name) values ('Stained Glass');
insert into market.categories(name) values ('Toys (Not Crochet)');
insert into market.categories(name) values ('Wood Work Artist');
insert into market.categories(name) values ('Wood Work Practical');
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types) values('vendor-photos','vendor-photos',false,10485760,array['image/jpeg','image/png','image/webp']) on conflict(id) do nothing;

create table if not exists market.staff(email text primary key check(email=lower(email)), name text not null, active boolean not null default true);
create table if not exists market.shopper_rsvps(id uuid primary key default gen_random_uuid(), event_id uuid not null references market.events, user_id uuid not null, name text not null, email text not null, party_size integer not null check(party_size between 1 and 20), referral_source text not null, referral_group text not null default '', created_at timestamptz not null default now(), unique(event_id,user_id));
create table if not exists market.vendor_messages(id uuid primary key default gen_random_uuid(), application_id uuid not null references market.applications, sender text not null, body text not null, created_at timestamptz not null default now());
alter table market.staff enable row level security;
alter table market.shopper_rsvps enable row level security;
alter table market.vendor_messages enable row level security;
revoke all on market.staff,market.shopper_rsvps,market.vendor_messages from anon,authenticated;


-- Website vendor live chat
create table if not exists market.chat_sessions (
  id uuid primary key default gen_random_uuid(),
  client_token uuid not null default gen_random_uuid() unique,
  vendor_id uuid references market.vendors(id) on delete set null,
  visitor_name text not null,
  visitor_email text not null,
  visitor_phone text not null,
  normalized_phone text not null default '',
  selling text not null,
  status text not null default 'open' check (status in ('open','offline','closed')),
  started_at timestamptz not null default now(),
  last_message_at timestamptz not null default now(),
  admin_seen_at timestamptz,
  closed_at timestamptz
);
create table if not exists market.chat_messages (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references market.chat_sessions(id) on delete cascade,
  sender text not null check (sender in ('visitor','organizer','system')),
  body text not null,
  attachment_path text,
  attachment_name text,
  attachment_type text,
  attachment_size bigint,
  created_at timestamptz not null default now()
);
create index if not exists chat_sessions_vendor_idx on market.chat_sessions(vendor_id,last_message_at desc);
create index if not exists chat_sessions_email_idx on market.chat_sessions(lower(visitor_email),last_message_at desc);
create index if not exists chat_sessions_phone_idx on market.chat_sessions(normalized_phone,last_message_at desc);
create index if not exists chat_sessions_status_idx on market.chat_sessions(status,last_message_at desc);
create index if not exists chat_messages_session_idx on market.chat_messages(session_id,created_at);
alter table market.chat_sessions enable row level security;
alter table market.chat_messages enable row level security;
revoke all on market.chat_sessions from anon,authenticated;
revoke all on market.chat_messages from anon,authenticated;
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values('chat-attachments','chat-attachments',false,10485760,array['image/jpeg','image/png','image/webp','image/gif','application/pdf'])
on conflict(id) do update set public=false,file_size_limit=excluded.file_size_limit,allowed_mime_types=excluded.allowed_mime_types;
insert into market.settings(key,value) values('chat_open','false') on conflict(key) do nothing;
