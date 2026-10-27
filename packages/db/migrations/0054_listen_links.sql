-- Listen elsewhere: the listen-links module (vault "tagave - External
-- Players Scoping", phase 1). Links from an album to the streaming platforms
-- each person picks (Qobuz, Spotify, Apple Music, …), found by the worker's
-- listenLinks.resolve job in MusicBrainz url relationships, Wikidata and
-- Apple's keyless barcode lookup. Only URLs are stored: no artwork, no
-- metadata copied from a platform.
--
-- The module's own tables (Module Composition Principle rule 1): each keyed
-- to a core row with ON DELETE CASCADE and tagged with its source; no core
-- table references them. Turning the module off stops the job and hides the
-- links; "Delete its data" (api › routes/listenLinks.ts) empties these five
-- tables and nothing else. Search links are built when shown, never stored.

-- An album's exact link on a platform: one per album and platform.
create table if not exists listen_links (
  release_group_id uuid not null references release_groups(id) on delete cascade,
  platform text not null check (platform in ('qobuz', 'spotify', 'apple', 'youtube-music', 'tidal', 'bandcamp', 'amazon', 'deezer')),
  url text not null check (url ~ '^https://'),
  source text not null check (source in ('mb-release', 'wikidata', 'itunes-upc')),
  resolved_at timestamptz not null default now(),
  primary key (release_group_id, platform)
);

-- An artist's page on a platform: the fallback when an album has no link.
create table if not exists listen_artist_links (
  artist_id uuid not null references artists(id) on delete cascade,
  platform text not null check (platform in ('qobuz', 'spotify', 'apple', 'youtube-music', 'tidal', 'bandcamp', 'amazon', 'deezer')),
  url text not null check (url ~ '^https://'),
  source text not null check (source in ('mb-artist', 'wikidata')),
  resolved_at timestamptz not null default now(),
  primary key (artist_id, platform)
);

-- When each album and artist was last looked up, for which platforms, and
-- how many links it found, so a miss is not asked again for a while (found:
-- 30 days, nothing found: 14 days). A platform someone picks later is looked
-- up at once.
create table if not exists listen_album_checks (
  release_group_id uuid primary key references release_groups(id) on delete cascade,
  checked_at timestamptz not null default now(),
  platforms text[] not null default '{}',
  found integer not null default 0
);

create table if not exists listen_artist_checks (
  artist_id uuid primary key references artists(id) on delete cascade,
  checked_at timestamptz not null default now(),
  platforms text[] not null default '{}',
  found integer not null default 0
);

-- Each person's own platforms, in their order. None until they choose.
create table if not exists listen_prefs (
  user_id uuid primary key references users(id) on delete cascade,
  platforms text[] not null default '{}',
  updated_at timestamptz not null default now()
);
