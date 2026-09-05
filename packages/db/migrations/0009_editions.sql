-- Add editions_fetched_at column to release_groups (spec ENR-1, BRW-2)
-- on-demand, 30-day TTL applied by the job.
alter table release_groups
  add column editions_fetched_at timestamptz;
