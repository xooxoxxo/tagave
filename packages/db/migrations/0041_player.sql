-- The opt-in player module (0.8): tagave plays albums through a Navidrome
-- (bundled, compose profile "player") or another Subsonic-compatible server
-- the owner already runs. These tables exist whether the module is on or off;
-- they stay empty when it is off and no catalogue query reads them.
-- Additive: older versions ignore them.

-- Which song on the player server is which local track. Resolved on demand
-- (release MBID finds the album, the file path pins the exact copy, the
-- recording MBID and position are the fallback) and cached here. A tag write
-- drops the rows of the files it touched, since the server may give the
-- re-read file a new id. server_key names the server the row belongs to, so
-- pointing tagave at another server never reuses another server's ids.
create table if not exists player_track_map (
  local_track_id uuid primary key references local_tracks(id) on delete cascade,
  server_key text not null,
  song_id text not null,
  server_album_id text,
  server_path text,
  matched_by text not null check (matched_by in ('path', 'recording', 'position')),
  resolved_at timestamptz not null default now()
);
create index if not exists idx_player_track_map_server on player_track_map (server_key);

-- What the web player reported: a track started, finished or was skipped.
-- Recorded as it came, with the ids that were current at the time, so the
-- next round can turn them into listens (>= 50% of an album within 6 h) and
-- scrobbles without guessing. processed_at is for that consumer.
create table if not exists player_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  library_id uuid not null references libraries(id) on delete cascade,
  local_track_id uuid references local_tracks(id) on delete set null,
  local_album_id uuid references local_albums(id) on delete set null,
  release_id uuid references releases(id) on delete set null,
  recording_mbid varchar(36),
  server_key text,
  server_song_id text,
  queue_id uuid not null,
  kind text not null check (kind in ('now_playing', 'completed', 'skipped')),
  played_ms integer not null check (played_ms >= 0),
  position_ms integer not null check (position_ms >= 0),
  duration_ms integer,
  occurred_at timestamptz not null,
  received_at timestamptz not null default now(),
  processed_at timestamptz
);
create index if not exists idx_player_events_user_time on player_events (user_id, occurred_at desc);
create index if not exists idx_player_events_unprocessed on player_events (occurred_at) where processed_at is null;

-- Folders the player server should re-read: written after a tag plan writes
-- files (and when a queue finds files the server has not seen), drained by
-- the debounced player.scan job. folder is relative to the music root; ''
-- means the whole library.
create table if not exists player_scan_requests (
  library_id uuid not null references libraries(id) on delete cascade,
  folder text not null,
  requested_at timestamptz not null default now(),
  primary key (library_id, folder)
);
