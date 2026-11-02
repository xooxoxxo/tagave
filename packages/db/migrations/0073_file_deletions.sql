-- Deleting songs and albums (vault "tagave - Deleting Songs and Albums").
-- One row per file the owner deleted from tagave, in one of two modes:
--
--   mark   the file is untouched; the owner deletes it on the server with the
--          command Library care › Deleting shows. A scan that finds it gone
--          drops its rows right away (no 24 h hold).
--   trash  the file worker renames it into <scan root>/.tagave-trash/<date>/
--          <original relative path> (same filesystem only). Restore renames it
--          back; Empty trash, or 30 days, deletes it for real.
--
-- While a row exists the file's tracks (and an album whose every track has a
-- row) leave the library, search, counts and the player, but nothing attached
-- to them is touched: matches, ratings, plays, locks, collection links stay
-- until the file row itself goes, so Unmark / Restore loses nothing.
--
-- state (trash only): moving (queued for the worker), trashed (in the trash
-- folder), restoring (queued to go back). A mark row is always 'marked'.
-- rel_path is the file's place in its root when it was deleted; trash_rel_path
-- where the worker put it. error: the last move or restore that failed.
--
-- Keyed to files with ON DELETE CASCADE: the row goes with the file.
-- Additive and re-runnable: older versions ignore the table.
create table if not exists file_deletions (
  file_id uuid primary key references files(id) on delete cascade,
  library_id uuid not null references libraries(id) on delete cascade,
  scan_root_id uuid not null references scan_roots(id) on delete cascade,
  kind text not null check (kind in ('mark', 'trash')),
  state text not null check (state in ('marked', 'moving', 'trashed', 'restoring')),
  rel_path text not null,
  trash_rel_path text,
  error text,
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  trashed_at timestamptz,
  constraint file_deletions_kind_state check ((kind = 'mark') = (state = 'marked'))
);
create index if not exists idx_file_deletions_library on file_deletions (library_id, kind);

-- Where the scan root is on the computer that holds the music, as the file
-- worker sees it (TAGAVE_MUSIC_HOST_DIR, which compose fills from MUSIC_DIR).
-- The Marked list's delete command runs there. Null: not known; the command
-- uses the root's own path.
alter table scan_roots add column if not exists host_path text;
