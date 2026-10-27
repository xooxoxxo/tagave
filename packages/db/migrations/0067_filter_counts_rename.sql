-- The filter rail's tables get names of their own (vault "tagave - Core
-- Platform Architecture", phase A0): "facet" now means a module's data about
-- an entity (facet_changes, packages/core/src/facets), so the album grid's
-- counts stop using the word.
--
--   album_facets  → album_filter_counts   one narrow row per album, rebuilt by facets.refresh (XO-363, 0018)
--   facet_state   → filter_rail_state     when the counts were rebuilt, when a bulk action made them stale
--
-- Columns stay as they are, and so does the queue (facets.refresh, which split
-- installs list in TAGAVE_QUEUES). Catalogue changes only: no row is copied.
-- An older worker still on the old names fails its next rebuild until it is
-- updated; the counts then come from the live queries, as they do while a
-- rebuild is due. Re-runnable.
set local lock_timeout = '20s';

alter table if exists album_facets rename to album_filter_counts;
alter table if exists facet_state rename to filter_rail_state;

do $$
declare
  r record;
begin
  for r in select * from (values
      ('album_filter_counts', 'album_facets_pkey', 'album_filter_counts_pkey'),
      ('album_filter_counts', 'album_facets_album_id_fkey', 'album_filter_counts_album_id_fkey'),
      ('album_filter_counts', 'album_facets_library_id_fkey', 'album_filter_counts_library_id_fkey'),
      ('filter_rail_state', 'facet_state_pkey', 'filter_rail_state_pkey'),
      ('filter_rail_state', 'facet_state_library_id_fkey', 'filter_rail_state_library_id_fkey')) as c(tbl, old_name, new_name)
  loop
    if exists (select 1 from pg_constraint where conrelid = format('public.%I', r.tbl)::regclass and conname = r.old_name) then
      execute format('alter table %I rename constraint %I to %I', r.tbl, r.old_name, r.new_name);
    end if;
  end loop;
end $$;

alter index if exists idx_album_facets_library rename to idx_album_filter_counts_library;
alter index if exists idx_album_facets_genres rename to idx_album_filter_counts_genres;
alter index if exists idx_album_facets_labels rename to idx_album_filter_counts_labels;
alter index if exists idx_album_facets_gap_kinds rename to idx_album_filter_counts_gap_kinds;

comment on table album_filter_counts is 'The album grid''s filter-rail counts: one narrow row per album, rebuilt by facets.refresh (0018, renamed in 0067).';
comment on table filter_rail_state is 'When a library''s filter-rail counts and artist list were rebuilt, and when a bulk action made them stale (0018, renamed in 0067).';
