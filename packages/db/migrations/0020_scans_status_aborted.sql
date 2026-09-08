-- scan.root has reported 'aborted' (unreadable or unmounted root) since M0 and
-- scan.sweep marks never-finished scans the same way, but the 0000 check
-- allowed only running/completed/failed/paused — every such write failed
-- (seen live 2026-09-08: scan.sweep failing every 10 minutes on the stale
-- 2026-09-01 row). Allow it.
alter table scans drop constraint if exists scans_status_check;
alter table scans add constraint scans_status_check
  check (status in ('running', 'completed', 'failed', 'paused', 'aborted'));
