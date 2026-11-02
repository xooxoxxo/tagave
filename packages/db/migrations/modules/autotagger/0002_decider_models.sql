-- The local decider's trained models (module-owned, like 0001's tables).
--
-- decider_models: one row per training of a library's model. `model` is the
--   whole model as the decider reads it (standardisation, coefficients,
--   isotonic calibration, feature schema); `version` is the hash a decision
--   names (decider_version), so a batch or an undo knows which model decided.
--   `data_hash` is over the training labels, `counts` what the training saw
--   (albums, rows, owner, auto, rejections) and `metrics` the held-out
--   figures per band. One model per library and decider is active: a new one
--   replaces it for new runs; older rows stay for the record.
create table if not exists decider_models (
  id uuid primary key default gen_random_uuid(),
  library_id uuid not null references libraries(id) on delete cascade,
  decider varchar(16) not null default 'local',
  version varchar(40) not null,
  features_schema_hash char(64) not null,
  model jsonb not null,
  data_hash char(64) not null,
  counts jsonb not null default '{}',
  metrics jsonb not null default '{}',
  active boolean not null default false,
  created_at timestamptz not null default now()
);
create unique index if not exists decider_models_one_active on decider_models (library_id, decider) where active;
create index if not exists idx_decider_models_library on decider_models (library_id, decider, created_at desc);
