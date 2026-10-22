-- Bug / problem reports submitted from the website and Android app
-- ("Report a problem" — public/bug-report.js + the api.mjs bug-report action).
-- The action also creates this table lazily if missing; this file is the
-- canonical definition for the rebuild's schema codification.
create table if not exists market.bug_reports (
  id uuid primary key default gen_random_uuid(),
  reporter text,
  description text not null,
  page text,
  app_version text,
  user_agent text,
  created_at timestamptz not null default now()
);

alter table market.bug_reports enable row level security;
