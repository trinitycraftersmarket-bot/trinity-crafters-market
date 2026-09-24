-- Vendor live chat
-- Applied to the production Supabase project on 2026-09-24.
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
