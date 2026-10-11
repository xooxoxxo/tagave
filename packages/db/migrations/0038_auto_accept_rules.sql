-- Review matches › Auto-accept: the owner's rules, one row per library. A
-- library without a row uses the defaults (off). The worker applies enabled
-- rules to albums the matcher leaves for review and to the queue on request;
-- every decision it makes is an album_matches row whose reason starts with
-- 'auto-accept rules', which is how the rules dialog lists what they did.
create table if not exists auto_accept_rules (
  library_id uuid primary key references libraries(id) on delete cascade,
  enabled boolean not null default false,
  min_match integer not null default 95 check (min_match between 50 and 100),
  all_checks_agree boolean not null default true,
  clear_winner_gap integer not null default 5 check (clear_winner_gap between 0 and 50),
  prefer_source text not null default 'either' check (prefer_source in ('musicbrainz', 'discogs', 'either')),
  official_only boolean not null default true,
  updated_at timestamptz not null default now()
);
-- the rules dialog's "accepted by these rules" list
create index if not exists idx_album_matches_rules
  on album_matches (library_id, decided_at desc)
  where decided_by = 'system' and reason like 'auto-accept rules%';
