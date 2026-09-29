-- What happened to each identification the owner asked for (a pasted
-- MusicBrainz / Discogs id, a release-group pick, a re-identify). The worker
-- used to only log a failed manual match ("pinned id not found") and mark the
-- job completed, so the album page kept showing the request as queued and the
-- owner never learned why nothing changed. One row per finished attempt; the
-- album page reads the newest one next to the live pg-boss job state.
create table if not exists identify_runs (
  id uuid primary key default gen_random_uuid(),
  library_id uuid not null references libraries(id) on delete cascade,
  local_album_id uuid not null references local_albums(id) on delete cascade,
  job_id uuid,
  kind text not null,
  pinned text,
  outcome text not null,
  message text not null,
  detail jsonb,
  finished_at timestamptz not null default now()
);
create index if not exists idx_identify_runs_album on identify_runs (local_album_id, finished_at desc);
create index if not exists idx_identify_runs_job on identify_runs (job_id);
