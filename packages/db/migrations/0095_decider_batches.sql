-- Accept batches (core): one row per batch the owner (or the rules) accepted
-- at once, and one row per album in it with the snapshot undo restores.
-- decided_kind: rule (the owner's auto-accept rules) or model (a decider
-- run, run_id in the module's decider_runs, no foreign key: the module can be
-- removed and its batches stay undoable). local_album_id has no foreign key
-- either, so an album merged away meanwhile is reported, not lost.
-- album_matches.batch_id (0093) points here without a foreign key too.
-- Additive: older versions ignore both tables.
create table if not exists decider_batches (
  id uuid primary key default gen_random_uuid(),
  library_id uuid not null references libraries(id) on delete cascade,
  decider_id varchar(40) not null,
  decider_version varchar(80),
  decided_kind varchar(10) not null check (decided_kind in ('rule', 'model')),
  run_id uuid,
  band varchar(10),
  -- states an album may be accepted from: review, and for a run over weak
  -- unidentified albums also unidentified
  accept_from text[] not null default '{needs_review}',
  state varchar(16) not null default 'queued'
    check (state in ('queued', 'accepting', 'accepted', 'undoing', 'undone', 'failed')),
  message text,
  started_by_user_id uuid references users(id) on delete set null,
  undo_by_user_id uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  accepted_at timestamptz,
  undo_requested_at timestamptz,
  undone_at timestamptz
);
create index if not exists idx_decider_batches_library on decider_batches (library_id, created_at desc);
-- is a batch running in this library
create index if not exists idx_decider_batches_active on decider_batches (library_id)
  where state in ('queued', 'accepting', 'undoing');

create table if not exists decider_batch_items (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null references decider_batches(id) on delete cascade,
  -- the item's place in its batch, in the order the batch was given
  position int not null,
  local_album_id uuid not null,
  release_id uuid not null,
  distance numeric(5,4) not null,
  source varchar(50),
  probability numeric(5,4) check (probability is null or (probability >= 0 and probability <= 1)),
  evidence_hash char(64),
  expect_last_identify_at timestamptz,
  reason text not null,
  status varchar(10) not null default 'pending' check (status in ('pending', 'accepted', 'skipped', 'undone', 'left')),
  -- why an item was skipped (accept) or left (undo); set exactly then
  skip_reason varchar(24)
    check (skip_reason is null or skip_reason in ('gone', 'state', 'reidentified', 'release_gone', 'evidence_changed',
                                                  'state_changed', 'newer_decision', 'locks', 'tag_plan')),
  match_id uuid,
  prior_state varchar(20),
  prior_identify_reason varchar(40),
  prior_release_id uuid,
  prior_release_group_id uuid,
  prior_identified_at timestamptz,
  prior_match_id uuid,
  prior_match_status varchar(20),
  prior_match_reason text,
  accepted_at timestamptz,
  undone_at timestamptz,
  created_at timestamptz not null default now(),
  unique (batch_id, local_album_id),
  constraint decider_batch_items_skip_reason_set check ((status in ('skipped', 'left')) = (skip_reason is not null))
);
create index if not exists idx_decider_batch_items_album on decider_batch_items (local_album_id);
create index if not exists idx_decider_batch_items_status on decider_batch_items (batch_id, status, position);
