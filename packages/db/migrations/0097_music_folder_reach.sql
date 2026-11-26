-- Music folder reach (vault "tagave - Offline Library Spec" §3). On
-- 2026-11-24 the music share went silent and tagave could only guess from an
-- aborted scan whether the folder was there. A folder watch now records what
-- it last saw on each root: reach (unknown, online, offline, unmounted), since
-- when, when it last looked, and a fixed reason code (never host text). Work
-- that needs an offline folder waits in parked_jobs, one row per root, queue
-- and singleton key, and is sent again when the folder comes back. A tag plan
-- whose folder went offline mid-apply is 'waiting'.
--
-- No backfill: every root starts 'unknown', which reads as "Checking" until
-- the watch's first reading. Constant defaults: catalogue-only changes, no
-- table rewrite. Re-runnable. Older versions ignore the columns and the table.
set local lock_timeout = '20s';

alter table scan_roots
  add column if not exists reach varchar(16) not null default 'unknown',
  add column if not exists reach_since timestamptz,
  add column if not exists reach_checked_at timestamptz,
  add column if not exists reach_reason varchar(32);

alter table scan_roots drop constraint if exists scan_roots_reach_check;
alter table scan_roots add constraint scan_roots_reach_check
  check (reach in ('unknown','online','offline','unmounted'));

alter table scan_roots drop constraint if exists scan_roots_reach_reason_check;
alter table scan_roots add constraint scan_roots_reach_reason_check
  check (reach_reason is null or reach_reason in ('server_silent','timeout','io_error','stale','empty','not_mounted'));

create table if not exists parked_jobs (
  id uuid primary key default gen_random_uuid(),
  scan_root_id uuid not null references scan_roots(id) on delete cascade,
  queue varchar(64) not null,
  data jsonb not null,
  singleton_key varchar(255),
  parked_at timestamptz not null default now(),
  reason varchar(32) not null
);
create index if not exists idx_parked_jobs_root on parked_jobs (scan_root_id);
create unique index if not exists parked_jobs_root_queue_key on parked_jobs (scan_root_id, queue, singleton_key) where singleton_key is not null;

alter table tag_plans drop constraint if exists tag_plans_status_check;
alter table tag_plans add constraint tag_plans_status_check
  check (status in ('draft','previewed','applying','paused','waiting','cancelled','applied','partially_failed','reverted'));
