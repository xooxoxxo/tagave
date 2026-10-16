-- Music Connections, landing what tagave pulls (Facets and Connectors design
-- §5, §10): critic scores, identity and wantlist suggestions from a linked
-- app, each in the module's own table, keyed by (link, remote key), and the
-- ledger of the core facts a module filled in. The landing code is worker ›
-- jobs/mcLanding.ts; revoking a link or removing the module deletes exactly
-- these rows (@tagave/db › mcUnplug.ts).
--
-- Each module row carries the link it came from (cascade), the person who
-- made the link, the remote's key, the item's album identity as the remote
-- sent it, and its data (schema-checked, length-capped, no prose). The
-- release group is null while tagave has no album to put it on ("parked");
-- parked rows attach once that album is matched. Core tables never point at
-- these.

-- ── The gap-fill ledger (core) ─────────────────────────────────────────────
-- A core fact a module filled because it was empty: which entity and field,
-- the value, and the module and link (by name and id only; core never has a
-- foreign key to a module). A fill is reverted when its link is revoked or
-- its module removed, unless a person has confirmed it since (confirmed_at,
-- or a later decision on that album's match, or a field lock), and only
-- while the field still holds the filled value.
create table if not exists identity_fills (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('album')),
  -- album: the release group (the only kind v1 fills)
  entity_id uuid not null references release_groups(id) on delete cascade,
  field text not null check (field in ('mbid')),
  value text not null,
  module text not null,
  source_ref uuid,
  created_at timestamptz not null default now(),
  confirmed_at timestamptz,
  confirmed_by uuid references users(id) on delete set null,
  unique (kind, entity_id, field)
);
create index if not exists idx_identity_fills_source on identity_fills (module, source_ref);

-- ── Critic scores (album.critic-scores@1, person) ─────────────────────────
create table if not exists mc_critic_scores (
  id uuid primary key default gen_random_uuid(),
  link_id uuid not null references mc_links(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  key text not null,
  release_group_id uuid references release_groups(id) on delete set null,
  album jsonb not null,
  data jsonb not null,
  remote_updated_at timestamptz not null,
  updated_at timestamptz not null default now(),
  -- a parked row: when tagave last tried to find its album (the oldest try goes first)
  last_tried_at timestamptz,
  unique (link_id, key)
);
create index if not exists idx_mc_critic_scores_rg on mc_critic_scores (release_group_id, user_id);
create index if not exists idx_mc_critic_scores_parked on mc_critic_scores (last_tried_at nulls first) where release_group_id is null;

-- ── Identity (album.identity@1): incoming facts and what became of them ────
--   parked            no local album yet
--   agrees            tagave already has the same MBID
--   filled            the MBID filled an empty release group (identity_fills)
--   conflict          another release group already has that MBID
--   suggested         a candidate in the identify queue (match_candidates, source mc:<link>)
--   awaiting_release  a suggestion whose release tagave fetches first
--   unresolved        nothing to suggest (no release named, or no album of it here)
create table if not exists mc_identity (
  id uuid primary key default gen_random_uuid(),
  link_id uuid not null references mc_links(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  key text not null,
  release_group_id uuid references release_groups(id) on delete set null,
  album jsonb not null,
  data jsonb not null,
  state text not null check (state in ('parked', 'agrees', 'filled', 'conflict', 'suggested', 'awaiting_release', 'unresolved')),
  remote_updated_at timestamptz not null,
  updated_at timestamptz not null default now(),
  last_tried_at timestamptz,
  unique (link_id, key)
);
create index if not exists idx_mc_identity_state on mc_identity (state, last_tried_at nulls first) where state in ('parked', 'awaiting_release');

-- ── Wantlist suggestions (album.wantlist-suggestion@1, person) ────────────
-- decision: the person's Accept or Dismiss, told to the remote first. A
-- decided row is the person's: a tombstone or a fresh snapshot leaves it.
create table if not exists mc_wantlist_suggestions (
  id uuid primary key default gen_random_uuid(),
  link_id uuid not null references mc_links(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  key text not null,
  release_group_id uuid references release_groups(id) on delete set null,
  album jsonb not null,
  data jsonb not null,
  remote_updated_at timestamptz not null,
  updated_at timestamptz not null default now(),
  decision text check (decision in ('accepted', 'dismissed')),
  decided_at timestamptz,
  wantlist_item_id uuid references wantlist_items(id) on delete set null,
  last_tried_at timestamptz,
  unique (link_id, key)
);
create index if not exists idx_mc_wantlist_user on mc_wantlist_suggestions (user_id, decision);
create index if not exists idx_mc_wantlist_parked on mc_wantlist_suggestions (last_tried_at nulls first) where release_group_id is null;

-- A snapshot in progress per capability ({ "<capability>": "<started at>" }):
-- when it completes, the link's rows of that capability the snapshot did
-- not resend are swept (a key the remote dropped while tagave's cursor was
-- too old to see its tombstone).
alter table mc_links add column if not exists snapshot_since jsonb not null default '{}'::jsonb;
-- Parked rows a link may keep (5000 per table): beyond that the oldest go,
-- and this counts them for the link's status.
alter table mc_links add column if not exists parked_dropped integer not null default 0;

-- ── The wantlist (built-in collection module) ─────────────────────────────
-- These columns belong to the wantlist, not to Music Connections: another
-- module adds an entry only through the wantlist's command (@tagave/db ›
-- wantlist.ts, wantlist.add), which records where it came from in origin.
-- An entry accepted from a suggestion lives in tagave alone: under a
-- collection source of its own (provider 'tagave'), which collection.sync
-- never reads (it syncs provider 'discogs' only) and collection.push never
-- writes. The album's names travel with it, for albums tagave has no
-- release group of; origin says where it came from (mc:<link id>), as text.
alter table wantlist_items add column if not exists release_group_mbid varchar(36);
alter table wantlist_items add column if not exists title varchar(300);
alter table wantlist_items add column if not exists artist varchar(300);
alter table wantlist_items add column if not exists origin text;
