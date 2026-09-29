-- Gap decisions become a three-way choice (album page, Resolve gaps, Tasks):
--   todo       "Add to my tasks": the owner confirmed the gap and will fix it.
--              gaps.recompute keeps it until the condition is gone, then marks
--              it resolved (accepted_at stays set, so it shows under Done).
--   dismissed  "Not a problem" (dismiss_reason not_interested) or "This is
--              wrong" (wrong_data): hidden, can be shown again.
--
-- Quality gaps were one row per album holding every flag, so hiding or
-- accepting applied to all of them at once. They become one row per flag,
-- keyed by the new `flag` column ('' for every other kind), each carrying
-- details {flags: {<flag>: <value>}} so the existing readers keep working.
alter table gaps drop constraint if exists gaps_state_check;
alter table gaps add constraint gaps_state_check
  check (state in ('open', 'todo', 'dismissed', 'resolved'));

alter table gaps add column if not exists flag varchar(50) not null default '';
alter table gaps add column if not exists accepted_at timestamptz;
alter table gaps add column if not exists note text;
alter table gaps add column if not exists decided_at timestamptz;

drop index if exists idx_gaps_natural;

-- one row per stored flag, keeping the row's state and dismissal
insert into gaps (library_id, kind, subject_type, subject_id, details, state,
                  dismiss_reason, first_seen_at, resolved_at, flag)
select g.library_id, g.kind, g.subject_type, g.subject_id,
       jsonb_build_object('flags', jsonb_build_object(f.key, f.value)),
       g.state, g.dismiss_reason, g.first_seen_at, g.resolved_at, f.key
  from gaps g
  cross join lateral jsonb_each(g.details -> 'flags') f
 where g.kind = 'quality' and g.flag = ''
   and jsonb_typeof(g.details -> 'flags') = 'object';

delete from gaps
 where kind = 'quality' and flag = ''
   and jsonb_typeof(details -> 'flags') = 'object';

create unique index if not exists idx_gaps_natural
  on gaps (library_id, kind, subject_type, subject_id, flag);

-- the Tasks list: accepted gaps, open and recently done
create index if not exists idx_gaps_tasks
  on gaps (library_id, accepted_at) where accepted_at is not null;
