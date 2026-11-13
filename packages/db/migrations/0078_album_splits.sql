-- Whole album in one file (vault "tagave - Split Album Images"). Some albums
-- are one long FLAC with no cue sheet, matched to a release of several
-- tracks. gaps.recompute lists them (kind one_file_album) in Library care ›
-- Attention; the owner splits each into one FLAC per track.
--
-- 1. gaps.kind gains one_file_album. The check is the inline one 0000 made
--    (Postgres names it gaps_kind_check); dropped and made again with the
--    new kind, so this file runs twice without harm.
alter table gaps drop constraint if exists gaps_kind_check;
alter table gaps add constraint gaps_kind_check check (kind in (
  'missing_track', 'incomplete_album', 'missing_album', 'physical_only', 'digital_only',
  'duplicate', 'quality', 'unidentified', 'parse_error', 'one_file_album'));

-- 2. One row per split the owner asked for. The file worker (files.split)
--    finds the cut points ('analyzing' → 'ready', plan filled), the owner
--    checks them and presses Split ('splitting'), the worker writes the
--    tracks and moves the source into the root's trash ('done', outputs
--    filled), or stops having changed nothing ('failed', error).
--
--    plan: SplitPlan (@tagave/shared › albumSplits.ts): the source's sample
--    rate and sample count, and per track its first and last sample, the
--    shift of its cut from the release's lengths and how sure the cut is.
--    outputs: the relative paths of the files the split wrote.
--
-- The album and the file may go after a split (the scan regroups the new
-- files, Empty trash drops the source): the row stays for the record.
-- Additive: older versions ignore the table and never write the new kind.
create table if not exists album_splits (
  id uuid primary key default gen_random_uuid(),
  library_id uuid not null references libraries(id) on delete cascade,
  local_album_id uuid references local_albums(id) on delete set null,
  file_id uuid references files(id) on delete set null,
  release_id uuid references releases(id) on delete set null,
  state text not null check (state in ('analyzing', 'ready', 'splitting', 'done', 'failed')),
  plan jsonb,
  outputs text[],
  error text,
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  finished_at timestamptz
);
create index if not exists idx_album_splits_album on album_splits (local_album_id, created_at desc);
