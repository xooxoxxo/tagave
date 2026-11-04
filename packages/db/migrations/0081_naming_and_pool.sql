-- Naming rules and the drop pool (vault "tagave - Naming Rules and Drop
-- Pool"). The rules themselves live in libraries.settings (naming,
-- dropPool); this file holds what the moves and the pool keep.
--
-- 1. album_moves (0080) moves more than songs into another album: a kind.
--      move      Maintenance › Move to album (0080)
--      organize  an album's files to the path the naming rules give: after a
--                tag plan writes its tags (tag_plan_id), or from Library care
--                › Organize
--      import    a dropped album out of the drop pool into the library
--    The same journal and Undo for all three. The check is dropped and made
--    again, so this file runs twice without harm.
alter table album_moves add column if not exists kind text not null default 'move';
alter table album_moves drop constraint if exists album_moves_kind_check;
alter table album_moves add constraint album_moves_kind_check check (kind in ('move', 'organize', 'import'));
alter table album_moves add column if not exists tag_plan_id uuid references tag_plans(id) on delete set null;
create index if not exists idx_album_moves_tag_plan on album_moves (tag_plan_id) where tag_plan_id is not null;

-- 2. A tag plan's preview shows each file's path under the rules next to its
--    tag changes: path_before is where it is, path_after where the rules put
--    it (null: it stays), path_state why it cannot go (clash: the name is
--    taken; unwritable: the folder cannot be written; null: it can).
alter table tag_plan_items add column if not exists path_before text;
alter table tag_plan_items add column if not exists path_after text;
alter table tag_plan_items add column if not exists path_state text;
alter table tag_plan_items drop constraint if exists tag_plan_items_path_state_check;
alter table tag_plan_items add constraint tag_plan_items_path_state_check check (path_state is null or path_state in ('clash', 'unwritable'));

-- 3. The drop pool: one row per album folder dropped into it. The pool is a
--    folder inside a writable music folder that the scan skips, so nothing in
--    it is in the library until it is imported.
--
--    waiting      seen; its files still change (a download in progress), or
--                 they have not been still for two minutes yet
--    identifying  identify's search is running on it
--    inbox        waits for the owner (Library care › Inbox): reason says why
--                 (unsure, unidentified, in_library, failed)
--    importing    tagged and moved by the file worker (move_id)
--    imported     in the library now
--    skipped      the owner skipped it: the files stay in the pool
--
--    signature: the folder's files (count, bytes, newest mtime); stable_since:
--    when it last changed. files, candidates, pairing: what Inbox shows.
--    existing_album_id: the album of the library that already holds this
--    release group (reason in_library).
create table if not exists pool_items (
  id uuid primary key default gen_random_uuid(),
  library_id uuid not null references libraries(id) on delete cascade,
  scan_root_id uuid not null references scan_roots(id) on delete cascade,
  dir_path text not null,
  state text not null check (state in ('waiting', 'identifying', 'inbox', 'importing', 'imported', 'skipped')),
  reason text check (reason is null or reason in ('unsure', 'unidentified', 'in_library', 'failed', 'undone')),
  signature text,
  stable_since timestamptz,
  files jsonb,
  candidates jsonb,
  best_release_id uuid references releases(id) on delete set null,
  best_percent int,
  pairing jsonb,
  existing_album_id uuid references local_albums(id) on delete set null,
  move_id uuid references album_moves(id) on delete set null,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  decided_at timestamptz,
  unique (scan_root_id, dir_path)
);
create index if not exists idx_pool_items_library on pool_items (library_id, state);
