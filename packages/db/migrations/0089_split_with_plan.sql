-- Tagging splits a whole album in one file first (vault "tagave - Tag Flow").
-- A tag plan for an album that is one FLAC holding the whole album, matched
-- to a release of several tracks, splits it before it tags: the plan's apply
-- runs the split and writes the plan's values to the new tracks, and the
-- plan's revert undoes it (the source back from the trash, the new tracks
-- into it).
--
-- 1. album_splits.tag_plan_id: the plan that asked for the split (null for a
--    split from the album page's Split). As album_moves.tag_plan_id (0081).
alter table album_splits add column if not exists tag_plan_id uuid references tag_plans(id) on delete set null;
create index if not exists idx_album_splits_tag_plan on album_splits (tag_plan_id) where tag_plan_id is not null;

-- 2. album_splits.state gains 'undone': a plan's revert put the source back
--    and took the tracks away. The check is the inline one 0078 made
--    (Postgres names it album_splits_state_check); dropped and made again,
--    so this file runs twice without harm.
alter table album_splits drop constraint if exists album_splits_state_check;
alter table album_splits add constraint album_splits_state_check
  check (state in ('analyzing', 'ready', 'splitting', 'done', 'failed', 'undone'));
-- Additive: older versions ignore the column and never write the new state.
