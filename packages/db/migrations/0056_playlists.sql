-- Playlists, a module of their own (Module Composition Principle): each
-- person's private lists of tracks, kept in two tables of the module's own.
-- Keyed to core rows (users on delete cascade; local_tracks on delete set
-- null, so a track that leaves the library stays in the list as "Missing");
-- no core table references them. Each item keeps what it was (title,
-- artist, album, MusicBrainz ids, disc and track) so an export can be
-- matched again on another install and a missing track can still be named.
--
-- Turning the module off (libraries.settings.modules.playlists.enabled =
-- false) hides it; "Delete its data" (api › routes/playlists.ts, doctor ›
-- purge-module playlists) empties these two tables and nothing else.
create table if not exists playlists (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  name text not null check (length(btrim(name)) between 1 and 200),
  source text not null default 'tagave' check (source in ('tagave', 'import')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_playlists_user on playlists (user_id, updated_at desc);

create table if not exists playlist_items (
  id uuid primary key default gen_random_uuid(),
  playlist_id uuid not null references playlists(id) on delete cascade,
  position integer not null,
  local_track_id uuid references local_tracks(id) on delete set null,
  recording_mbid varchar(36),
  release_mbid varchar(36),
  disc_no integer,
  track_no integer,
  title text not null,
  artist text,
  album text,
  duration_ms integer,
  added_at timestamptz not null default now()
);
create index if not exists idx_playlist_items_order on playlist_items (playlist_id, position);
create index if not exists idx_playlist_items_track on playlist_items (local_track_id) where local_track_id is not null;
