-- tags.apply marks every pending item 'applying' before it writes, but the
-- 0000 check on tag_plan_items.status allowed only pending/applied/failed/
-- skipped, so the first item update failed and the plan sat in 'applying'
-- with nothing written (seen live 2026-09-08, job 22155684). Allow it.
alter table tag_plan_items drop constraint if exists tag_plan_items_status_check;
alter table tag_plan_items add constraint tag_plan_items_status_check
  check (status in ('pending', 'applying', 'applied', 'failed', 'skipped'));
