-- Likes (owner, 2026-11-04: "can we like albums, like songs etc?"): each
-- person's hearts on songs, albums and artists. Liked songs is a built-in
-- list, newest first; Liked is a filter of the albums and artists lists.
-- Keyed to users with ON DELETE CASCADE, so a person's likes go with them.
--
-- What a like points at, and why it survives the library changing under it:
--
--   song    local_tracks(id), set null when the row goes, and the recording
--           MBID. A rescan and Move to album keep the row (it is keyed to the
--           file, and a moved file keeps its files row), so the id holds. A
--           split, a re-import or a file replaced by a better copy makes a new
--           row: the recording MBID finds the song again, and the like points
--           at the new row the next time it is read. A song is liked when
--           either matches, so the same recording on a compilation is liked
--           too (Spotify's convention).
--   album   the release group, else (an album not identified yet) the local
--           album, set null when either goes. Ratings and reviews are per
--           release group too: re-identifying the album to another edition,
--           re-clustering its folder, splitting it by format or moving songs
--           out of it keeps the like, and every copy of the album is liked.
--           A like made before the album was identified gains its release
--           group when the album gets one.
--   artist  artists(id), cascade: an artist that leaves tagave takes its like.
--
-- title, artist and album remember what a song was, so Liked songs can name
-- a song that left the library and Last.fm can be told about it.
create table if not exists likes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  kind text not null check (kind in ('song', 'album', 'artist')),
  local_track_id uuid references local_tracks(id) on delete set null,
  recording_mbid varchar(36),
  release_group_id uuid references release_groups(id) on delete set null,
  local_album_id uuid references local_albums(id) on delete set null,
  artist_id uuid references artists(id) on delete cascade,
  title text,
  artist text,
  album text,
  liked_at timestamptz not null default now(),
  constraint likes_target check (
    (kind = 'song' and release_group_id is null and local_album_id is null and artist_id is null)
    or (kind = 'album' and local_track_id is null and recording_mbid is null and artist_id is null)
    or (kind = 'artist' and artist_id is not null and local_track_id is null and recording_mbid is null
        and release_group_id is null and local_album_id is null)
  )
);
-- One like per person and thing, whichever key names it.
create unique index if not exists likes_song_track on likes (user_id, local_track_id) where kind = 'song' and local_track_id is not null;
create unique index if not exists likes_song_recording on likes (user_id, recording_mbid) where kind = 'song' and recording_mbid is not null;
create unique index if not exists likes_album_group on likes (user_id, release_group_id) where kind = 'album' and release_group_id is not null;
create unique index if not exists likes_album_local on likes (user_id, local_album_id) where kind = 'album' and release_group_id is null and local_album_id is not null;
create unique index if not exists likes_artist on likes (user_id, artist_id) where kind = 'artist';
create index if not exists idx_likes_user_time on likes (user_id, kind, liked_at desc);
create index if not exists idx_likes_track on likes (local_track_id) where local_track_id is not null;
-- a liked recording finds its songs through canonical_tracks (indexed) or
-- the recording a fingerprint named
create index if not exists idx_local_tracks_recording on local_tracks (recording_id) where recording_id is not null;

-- An unlike, kept a week: the player's two-way sync compares it with the
-- time a Subsonic app starred the same thing (last write wins). The same
-- keys as likes.
create table if not exists like_removals (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  kind text not null check (kind in ('song', 'album', 'artist')),
  local_track_id uuid references local_tracks(id) on delete set null,
  recording_mbid varchar(36),
  release_group_id uuid references release_groups(id) on delete set null,
  local_album_id uuid references local_albums(id) on delete set null,
  artist_id uuid references artists(id) on delete cascade,
  removed_at timestamptz not null default now()
);
create index if not exists idx_like_removals_user on like_removals (user_id, removed_at desc);

-- The player module: likes mirrored to the person's account on the player
-- server as stars, both ways. One row per starred server item tagave and the
-- server last agreed on; a star gone from one side since then was removed
-- there. target names the tagave side (song:<local track>, album:<release
-- group or local album>, artist:<artist>).
create table if not exists player_like_sync (
  user_id uuid not null references users(id) on delete cascade,
  server_key text not null,
  kind text not null check (kind in ('song', 'album', 'artist')),
  server_id text not null,
  target text not null,
  synced_at timestamptz not null default now(),
  primary key (user_id, server_key, kind, server_id)
);

-- A liked or unliked song told to Last.fm (track.love / track.unlove) and
-- ListenBrainz (recording feedback, score 1 or 0), once per change, retried
-- like scrobbles.
create table if not exists player_loves (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  service text not null check (service in ('lastfm', 'listenbrainz')),
  love boolean not null,
  title text not null,
  artist text not null,
  recording_mbid varchar(36),
  status text not null default 'pending' check (status in ('pending', 'sending', 'sent', 'ignored', 'failed')),
  attempts integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  claimed_at timestamptz,
  last_error text,
  sent_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists idx_player_loves_due on player_loves (next_attempt_at) where status in ('pending', 'sending');

-- Each connection's Off/On for loves (Settings › Modules › Player,
-- Listening): on from the start.
alter table scrobble_accounts add column if not exists send_loves boolean not null default true;
