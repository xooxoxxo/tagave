-- Get missing albums through Lidarr: the lidarr module (vault "tagave - Get
-- Missing Albums", part B). One row per missing album the owner asked
-- Lidarr for, followed by the worker's lidarr.poll until tagave's own scan
-- finds the album (then: done).
--
--   wanted       Lidarr monitors the album and searches for it
--   downloading  it is in Lidarr's queue (progress: 0-100 when Lidarr knows the size)
--   imported     Lidarr has its files; tagave scans the folder they are in
--   done         tagave holds a local album of this release group
--   not_found    three days of searching found nothing; Retry searches again
--
-- lidarr_album_id: Lidarr's id for the album (null until Lidarr has it).
-- lidarr_path: the folder Lidarr imported into, as Lidarr sees it;
-- outside_roots: that folder is in none of tagave's music folders (Settings
-- warns). requested_at starts the Not found wait; Retry sets it again.
-- Cancel unmonitors the album in Lidarr and deletes the row.
--
-- The module's own table (Module Composition Principle rule 1): keyed to
-- core rows with ON DELETE CASCADE, no core table references it. Its
-- connection lives in installed_modules.settings ('lidarr'), the key sealed
-- with APP_SECRET. Additive: older versions ignore the table.
create table if not exists lidarr_requests (
  id uuid primary key default gen_random_uuid(),
  library_id uuid not null references libraries(id) on delete cascade,
  release_group_id uuid not null references release_groups(id) on delete cascade,
  state text not null default 'wanted' check (state in ('wanted', 'downloading', 'imported', 'done', 'not_found')),
  progress smallint check (progress between 0 and 100),
  lidarr_album_id integer,
  lidarr_artist_id integer,
  lidarr_path text,
  outside_roots boolean not null default false,
  scan_requested_at timestamptz,
  last_error text check (length(last_error) <= 300),
  requested_by uuid references users(id) on delete set null,
  requested_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  done_at timestamptz,
  unique (library_id, release_group_id)
);
create index if not exists idx_lidarr_requests_open on lidarr_requests (library_id, state) where state <> 'done';
