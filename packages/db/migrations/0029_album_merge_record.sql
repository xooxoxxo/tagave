-- "Treat as one album" keeps a record of what it merged, so "Split back"
-- can restore it: the kept album's identification before the merge, and for
-- every album merged into it its id, cluster key, identification, files and
-- the album-level locks that were turned into per-file locks. Null on every
-- album that was not built by a merge.
alter table local_albums add column if not exists merged_from jsonb;
