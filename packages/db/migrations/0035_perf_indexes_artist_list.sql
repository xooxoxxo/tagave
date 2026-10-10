-- Performance audit 2026-10-10: indexes for the per-request queries that read
-- far more than they return, and a precomputed artists list.

-- "Needs attention" badge and list: open gaps of a library newest first, and
-- the open count per kind. Both scanned all ~71k open gaps per request.
create index if not exists idx_gaps_library_state_seen
  on gaps (library_id, state, first_seen_at desc);
create index if not exists idx_gaps_library_state_kind
  on gaps (library_id, state, kind);

-- Scan-root counts (Settings › Library, plan page): present files per root
-- and the albums they cluster into, answered from two narrow indexes instead
-- of a sequential scan of the ~500 MB audio_files heap.
create index if not exists idx_audio_files_present_root
  on audio_files (library_id, scan_root_id) include (id) where status = 'present';
create index if not exists idx_local_tracks_file_album
  on local_tracks (audio_file_id) include (local_album_id);

-- provider_cache purge (cache.purge, nightly) finds expired rows by date.
create index if not exists idx_provider_cache_expires
  on provider_cache (expires_at) where expires_at is not null;

-- The artists list, one row per artist row the page shows (canonical artists
-- and unresolved album-artist names), rebuilt by facets.refresh with the
-- album facets. The A–Z order follows rules SQL collation cannot express
-- (@liner/shared artistLabels), so the worker sorts in JS and stores each
-- row's position per sort; the API then pages with an index range instead
-- of aggregating and sorting ~14.5k artists on every request.
create table if not exists artist_list (
  library_id uuid not null references libraries(id) on delete cascade,
  -- 0-based, dense: position in the A–Z list / by album count / by recency
  pos_name integer not null,
  pos_albums integer not null,
  pos_recent integer not null,
  artist_id uuid,
  name text not null,
  sort_name text,
  resolved boolean not null,
  album_count integer not null,
  track_count integer not null,
  year_from integer,
  year_to integer,
  added_at timestamptz,
  -- ARTIST_GROUP_ORDER key ("A", "0-9", "other", "#") for the jump bar
  group_key text not null,
  primary key (library_id, pos_name)
);
create unique index if not exists idx_artist_list_albums on artist_list (library_id, pos_albums);
create unique index if not exists idx_artist_list_recent on artist_list (library_id, pos_recent);
create index if not exists idx_artist_list_group on artist_list (library_id, group_key, pos_name);

-- when artist_list was last rebuilt for the library (null: never; the API
-- then computes the list live)
alter table facet_state add column if not exists artists_at timestamptz;
