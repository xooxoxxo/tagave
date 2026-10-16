-- The player module per person (0.9): each tagave person gets their own
-- account on the player server, their plays become their listens, and they
-- scrobble to their own Last.fm / ListenBrainz. All of it is keyed by
-- users(id) and goes with the person (on delete cascade). The tables stay
-- empty while the player module is off. Additive: older versions ignore them.

-- Accounts can be disabled or closed (the users-and-roles migration, 0043,
-- adds the same columns; whichever runs first makes them).
alter table users add column if not exists disabled_at timestamptz;
alter table users add column if not exists removed_at timestamptz;

-- The person's account on the player server. On the bundled Navidrome
-- tagave creates it ("managed") with a random password sealed with
-- APP_SECRET; the person may set their own password for phone apps, which
-- is stored the same way and never shown again. On a server the owner runs,
-- the person enters their own login there ("person"). A disabled tagave
-- account locks its player account (a new random password nobody knows).
create table if not exists player_users (
  user_id uuid not null references users(id) on delete cascade,
  server_key text not null,
  username text not null,
  server_user_id text,
  password_sealed text not null,
  source text not null check (source in ('managed', 'person')),
  phone_password boolean not null default false,
  state text not null default 'active' check (state in ('active', 'disabled')),
  -- a server of the owner's that already scrobbles for this person: tagave
  -- then sends nothing to Last.fm or ListenBrainz itself (no double scrobbles)
  server_scrobbles boolean not null default false,
  last_error text,
  last_error_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, server_key)
);
create unique index if not exists player_users_server_name on player_users (server_key, lower(username));

-- Each person's Last.fm session key or ListenBrainz token, sealed.
create table if not exists scrobble_accounts (
  user_id uuid not null references users(id) on delete cascade,
  service text not null check (service in ('lastfm', 'listenbrainz')),
  account_name text not null,
  secret_sealed text not null,
  connected_at timestamptz not null default now(),
  last_ok_at timestamptz,
  last_error text,
  last_error_at timestamptz,
  primary key (user_id, service)
);

-- An album listen made from plays: >= 50% of the album's tracks heard
-- within 6 hours. listen_id is the row in listens it wrote (albums with a
-- release group); deleting that listen by hand keeps this row, so the same
-- plays never write it again.
create table if not exists player_listens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  library_id uuid not null references libraries(id) on delete cascade,
  local_album_id uuid not null references local_albums(id) on delete cascade,
  release_id uuid references releases(id) on delete set null,
  release_group_id uuid references release_groups(id) on delete set null,
  started_at timestamptz not null,
  ended_at timestamptz not null,
  tracks_heard integer not null,
  tracks_total integer not null,
  listen_id uuid references listens(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (user_id, local_album_id, started_at)
);
create index if not exists idx_player_listens_user on player_listens (user_id, started_at desc);

-- One play of one track by one person, from tagave's web player (a
-- completed or skipped event) or from another app through the player server
-- (seen in that person's play counts). dedupe_key makes it exactly one row
-- however often the same play is seen:
--   event:<player_events.id>                     web player
--   server:<server_key>:<song id>:<play count>   the n-th play the server counted
create table if not exists player_plays (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  library_id uuid references libraries(id) on delete cascade,
  dedupe_key text not null,
  source text not null check (source in ('web', 'server')),
  local_track_id uuid references local_tracks(id) on delete set null,
  local_album_id uuid references local_albums(id) on delete set null,
  release_id uuid references releases(id) on delete set null,
  server_key text,
  server_song_id text,
  title text not null,
  artist text,
  album text,
  album_artist text,
  track_no integer,
  recording_mbid varchar(36),
  release_mbid varchar(36),
  duration_ms integer,
  played_ms integer,
  started_at timestamptz not null,
  -- heard half the track or four minutes (album listens)
  heard boolean not null,
  -- heard and longer than 30 s (Last.fm's rule; scrobbled)
  scrobbles boolean not null,
  -- a web play told to the player server as this person (its play counts)
  server_report text not null default 'none' check (server_report in ('none', 'pending', 'done', 'failed')),
  player_listen_id uuid references player_listens(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (user_id, dedupe_key)
);
create index if not exists idx_player_plays_user_time on player_plays (user_id, started_at desc);
create index if not exists idx_player_plays_unlistened on player_plays (user_id, local_album_id, started_at) where player_listen_id is null and heard;

-- One scrobble per play per service; the primary key is what makes it once.
create table if not exists player_scrobbles (
  play_id uuid not null references player_plays(id) on delete cascade,
  service text not null check (service in ('lastfm', 'listenbrainz')),
  status text not null default 'pending' check (status in ('pending', 'sending', 'sent', 'ignored', 'failed')),
  attempts integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  claimed_at timestamptz,
  last_error text,
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  primary key (play_id, service)
);
create index if not exists idx_player_scrobbles_due on player_scrobbles (next_attempt_at) where status in ('pending', 'sending');

-- What tagave last saw of each person's play count per song on the player
-- server, so a new play from another app shows as the count going up.
create table if not exists player_song_counts (
  user_id uuid not null references users(id) on delete cascade,
  server_key text not null,
  song_id text not null,
  play_count integer not null,
  played_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (user_id, server_key, song_id)
);

-- Where each person's poll of the player server stands. baseline_at is the
-- first poll, which only records counts (plays from before tagave looked are
-- not turned into listens or scrobbles).
create table if not exists player_poll_state (
  user_id uuid not null references users(id) on delete cascade,
  server_key text not null,
  baseline_at timestamptz,
  cursor_at timestamptz,
  last_poll_at timestamptz,
  last_error text,
  last_error_at timestamptz,
  primary key (user_id, server_key)
);

-- Ratings and favourite tracks tagave pushed to the player server, per
-- person and album, so only changes are sent.
create table if not exists player_rating_sync (
  user_id uuid not null references users(id) on delete cascade,
  server_key text not null,
  library_id uuid not null references libraries(id) on delete cascade,
  release_group_id uuid not null references release_groups(id) on delete cascade,
  rating_sent integer,
  favorites_sent text[] not null default '{}',
  review_updated_at timestamptz,
  synced_at timestamptz not null default now(),
  primary key (user_id, server_key, library_id, release_group_id)
);

-- Listens the player made are marked, so the album page can tell them from
-- the ones logged by hand.
alter table listens add column if not exists source text not null default 'manual';
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'listens_source_check') then
    alter table listens add constraint listens_source_check check (source in ('manual', 'player'));
  end if;
end
$$;
