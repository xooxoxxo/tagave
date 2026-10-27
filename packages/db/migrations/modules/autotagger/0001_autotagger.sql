-- The autotagger module's own tables (off by default; Settings › Modules ›
-- Autotagger). Its switch is the module ledger's row 'autotagger'
-- (installed_modules). "Delete its data" (doctor purge-module autotagger)
-- empties exactly these. Core accept batches (decider_batches,
-- decider_batch_items) and match provenance (album_matches) are not the
-- module's: accepted batches stay undoable without it. No core table points
-- at these by foreign key (decider_batches.run_id has none on purpose).
--
-- decider_library_settings: per library, the sealed API key, its hint and
--   the module's settings. The key is sealed before it is written (with the
--   app secret, as the other provider keys); the checks refuse a plain one
--   and a hint longer than the last four characters.
-- decider_prices: what a model costs, per million input tokens (output is
--   free); model '*' prices every model of the decider.
-- decider_runs: one owner-started run over a population; pinned to one
--   dated model once the first answer names it.
-- decider_calls: every billed call, unique per album, evidence, question
--   spec and dated model, so a retry or a re-run never pays twice. A call
--   that got no answer after a server error or a timeout may still have
--   been billed: it is kept as possibly_billed at its estimate, with no
--   answers, counts toward the month's spend and is never reused.
-- decider_decisions: what a run decided per album.
-- decider_spot_checks: the owner's verdict on random decisions per band.
create table if not exists decider_library_settings (
  library_id uuid primary key references libraries(id) on delete cascade,
  sealed_key text check (sealed_key is null or sealed_key like 'enc:_%'),
  key_hint varchar(8) check (key_hint is null or char_length(key_hint) <= 4),
  config jsonb not null default '{}',
  updated_at timestamptz not null default now()
);

create table if not exists decider_prices (
  decider_id varchar(40) not null,
  model varchar(80) not null,
  per_million_input numeric(12,6) not null check (per_million_input >= 0),
  currency char(3) not null,
  updated_at timestamptz not null default now(),
  primary key (decider_id, model)
);

create table if not exists decider_runs (
  id uuid primary key default gen_random_uuid(),
  library_id uuid not null references libraries(id) on delete cascade,
  decider_id varchar(40) not null,
  spec_hash varchar(80) not null,
  model_requested varchar(80) not null,
  decider_version varchar(80),
  population varchar(16) not null check (population in ('needs_review', 'weak', 'backtest', 'measure')),
  state varchar(16) not null default 'queued' check (state in ('queued', 'running', 'paused', 'done', 'cancelled', 'failed')),
  pause_reason varchar(24),
  message text,
  seed integer not null default floor(random() * 2147483647)::int,
  started_by_user_id uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz
);
create index if not exists idx_decider_runs_library on decider_runs (library_id, created_at desc);

create table if not exists decider_calls (
  id uuid primary key default gen_random_uuid(),
  library_id uuid not null references libraries(id) on delete cascade,
  local_album_id uuid not null references local_albums(id) on delete cascade,
  run_id uuid references decider_runs(id) on delete set null,
  evidence_hash char(64) not null,
  spec_hash varchar(80) not null,
  decider_id varchar(40) not null,
  decider_version varchar(80) not null,
  request_bytes integer not null,
  input_tokens integer not null,
  cost numeric(12,6) not null,
  currency char(3) not null,
  answers jsonb,
  possibly_billed boolean not null default false,
  created_at timestamptz not null default now(),
  check (possibly_billed = (answers is null))
);
create unique index if not exists decider_calls_answer_key on decider_calls (local_album_id, evidence_hash, spec_hash, decider_version)
  where not possibly_billed;
create index if not exists idx_decider_calls_library_month on decider_calls (library_id, created_at);

create table if not exists decider_decisions (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references decider_runs(id) on delete cascade,
  local_album_id uuid not null references local_albums(id) on delete cascade,
  call_id uuid references decider_calls(id) on delete set null,
  evidence_hash char(64),
  last_identify_at timestamptz,
  outcome varchar(16) not null check (outcome in ('pick', 'none', 'too_large', 'no_candidates', 'rejected', 'error')),
  group_label varchar(4),
  group_release_ids uuid[] not null default '{}',
  release_id uuid,
  distance numeric(5,4),
  source varchar(50),
  probability numeric(5,4) check (probability is null or (probability >= 0 and probability <= 1)),
  margin numeric(5,4),
  band varchar(10),
  reason text,
  request_bytes integer,
  created_at timestamptz not null default now(),
  unique (run_id, local_album_id)
);
create index if not exists idx_decider_decisions_band on decider_decisions (run_id, band) where outcome = 'pick';

create table if not exists decider_spot_checks (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references decider_runs(id) on delete cascade,
  decision_id uuid not null unique references decider_decisions(id) on delete cascade,
  band varchar(10) not null,
  verdict varchar(8) not null default 'pending' check (verdict in ('pending', 'correct', 'wrong', 'unsure')),
  checked_by_user_id uuid references users(id) on delete set null,
  drawn_at timestamptz not null default now(),
  checked_at timestamptz
);
create index if not exists idx_decider_spot_checks_band on decider_spot_checks (run_id, band, verdict);
