-- Worker heartbeats used to be job_runs rows, and job_runs.library_id is
-- required. On a fresh install no library exists until the owner account is
-- created, so running workers wrote nothing and the setup wizard's system
-- check reported "no live workers" right after the installer had shown them
-- connected. Heartbeats belong to the installation, not to a library.
create table if not exists worker_heartbeats (
  worker_id text primary key,
  seen_at timestamptz not null default now(),
  info jsonb not null default '{}'::jsonb
);
create index if not exists idx_worker_heartbeats_seen_at on worker_heartbeats (seen_at);
delete from job_runs where type = 'worker.heartbeat';
