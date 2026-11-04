-- Move to album (vault "tagave - Move to Album"). In the album page's
-- Maintenance the owner picks songs whose files sit in the wrong album's
-- folder and moves them, files and tags, into another album's folder: an
-- album of the library, or a MusicBrainz release with no folder yet.
--
-- One row per move. The file worker (files.move) looks a release up
-- ('searching' → 'choosing', candidates filled), plans the move ('planning' →
-- 'ready', plan filled: per file its target track, new path and tag changes),
-- moves ('moving' → 'done', journal filled: per file its paths and its tags
-- before and after), and undoes it from the journal ('undoing' → 'undone').
-- A move that stops puts back what it changed ('failed', error).
--
-- source_track_ids: the local_tracks the owner picked (the plan names their
-- files). The albums may go after a move (the scan regroups the files): the
-- row stays for the record and for Undo, which works from the journal alone.
-- Additive: older versions ignore the table.
create table if not exists album_moves (
  id uuid primary key default gen_random_uuid(),
  library_id uuid not null references libraries(id) on delete cascade,
  source_album_id uuid references local_albums(id) on delete set null,
  target_album_id uuid references local_albums(id) on delete set null,
  release_id uuid references releases(id) on delete set null,
  release_mbid uuid,
  source_track_ids uuid[] not null,
  state text not null check (state in ('searching', 'choosing', 'planning', 'ready', 'moving', 'done', 'undoing', 'undone', 'failed')),
  query jsonb,
  candidates jsonb,
  plan jsonb,
  journal jsonb,
  error text,
  -- Undo pressed while the move was still running: the worker undoes it as it ends
  undo_requested boolean not null default false,
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  finished_at timestamptz,
  undone_at timestamptz
);
create index if not exists idx_album_moves_library on album_moves (library_id, created_at desc);
create index if not exists idx_album_moves_source on album_moves (source_album_id, created_at desc);
