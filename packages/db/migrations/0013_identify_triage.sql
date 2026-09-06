-- XO-309: identify triage + coverage metrics.
-- identify_reason: why an album is unidentified / needs review
--   no_tags | no_candidates | weak_candidates | ambiguous | provider_errors
-- identify_attempts / last_identify_at: sweep top-up eligibility and triage
-- identified_at: per-day identified-% series (G1: 95% by day 30)
alter table local_albums add column if not exists identify_reason varchar(40);
alter table local_albums add column if not exists identify_attempts integer not null default 0;
alter table local_albums add column if not exists last_identify_at timestamptz;
alter table local_albums add column if not exists identified_at timestamptz;

update local_albums la
   set identified_at = m.decided_at
  from album_matches m
 where m.local_album_id = la.id
   and m.status in ('auto', 'confirmed')
   and la.state = 'matched'
   and la.identified_at is null;

-- albums decided before this migration carry their decision time in updated_at
update local_albums set last_identify_at = updated_at, identify_attempts = 1
 where state <> 'pending' and last_identify_at is null;

create index if not exists idx_local_albums_identified_at on local_albums (library_id, identified_at);
