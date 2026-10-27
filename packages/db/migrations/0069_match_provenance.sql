-- Who or what decided each album match, kept apart from the reason text.
--   decided_kind: user (a person), system (the matcher's own thresholds),
--     rule (the owner's auto-accept rules), model (a decision model),
--     unknown (an older row whose reason was replaced when it was superseded).
--   decided_by stays 'system' | 'user' for every older reader.
--   decided_by_user_id: the person, when known (null for history).
--   decider_id, decider_version: which decider and which dated model.
--   probability: the decider's probability for the chosen tracklist.
--   batch_id: the accept batch (decider_batches); no foreign key, so a
--     batch can go without touching matches.
-- Additive: an older version ignores the columns; its inserts get 'unknown'.
-- The Music Connections trigger (0048) does not compare these columns yet,
-- so this backfill logs no album.identity change; a later migration adds
-- decided_kind and probability to what it compares.
alter table album_matches
  add column if not exists decided_kind varchar(10) not null default 'unknown',
  add column if not exists decided_by_user_id uuid references users(id) on delete set null,
  add column if not exists decider_id varchar(40),
  add column if not exists decider_version varchar(80),
  add column if not exists probability numeric(5,4),
  add column if not exists batch_id uuid;

do $$ begin
  alter table album_matches add constraint album_matches_decided_kind_check
    check (decided_kind in ('user', 'system', 'rule', 'model', 'unknown'));
exception when duplicate_object then null; end $$;
do $$ begin
  alter table album_matches add constraint album_matches_probability_check
    check (probability is null or (probability >= 0 and probability <= 1));
exception when duplicate_object then null; end $$;

create index if not exists idx_album_matches_batch on album_matches (batch_id) where batch_id is not null;

update album_matches set decided_kind = case
    when reason like 'superseded by %' then 'unknown'
    when decided_by = 'user' then 'user'
    when reason like 'auto-accept rules%' then 'rule'
    when reason like 'auto-accept:%' or reason like 'chip-rule%' or reason like 'first-candidate%'
      or reason like 'acoustid auto-accept%' then 'system'
    when decided_by = 'system' then 'system'
    else 'unknown' end
 where decided_kind = 'unknown';
