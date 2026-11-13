create table if not exists maintenance_tasks (
  id uuid primary key default gen_random_uuid(),
  library_id uuid not null references libraries(id) on delete cascade,
  kind text not null check (kind in ('cover', 'split', 'empty-trash', 'flac-upgrade')),
  scope_key text not null,
  subject_id uuid,
  queue text not null,
  input jsonb not null,
  state text not null check (state in ('waiting', 'running', 'interrupted', 'review', 'done', 'failed', 'cancelled')),
  stage text not null,
  progress jsonb,
  error text,
  checkpoint jsonb,
  attempt_id uuid not null default gen_random_uuid(),
  attempt integer not null default 1,
  history jsonb not null default '[]',
  dispatched_at timestamptz,
  dispatch_after timestamptz not null default now(),
  cancel_requested boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists maintenance_tasks_open_scope
  on maintenance_tasks (library_id, kind, scope_key) where state not in ('done', 'cancelled');
create index if not exists maintenance_tasks_activity
  on maintenance_tasks (library_id, updated_at desc);
create index if not exists maintenance_tasks_outbox
  on maintenance_tasks (updated_at) where state in ('waiting', 'running');

alter table album_splits add column if not exists write_checkpoint jsonb;

alter table file_deletions add column if not exists purge_task_id uuid references maintenance_tasks(id) on delete set null;
alter table file_deletions drop constraint if exists file_deletions_state_check;
alter table file_deletions add constraint file_deletions_state_check
  check (state in ('marked', 'moving', 'trashed', 'restoring', 'purged', 'holding'));
create index if not exists file_deletions_purge_task on file_deletions (purge_task_id) where purge_task_id is not null;
alter table file_deletions add column if not exists trash_mount text;
