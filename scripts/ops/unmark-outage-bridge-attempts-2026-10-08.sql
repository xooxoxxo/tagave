-- One-off: give back the releases the 2026-10-08 internet outage marked as
-- "bridge attempted".
--
-- From 04:00:18 to 08:01:33 CEST (02:00–06:02 UTC) every MusicBrainz/Discogs
-- call of the nightly enrich sweep timed out, and enrich.release stamped
-- bridge_attempted_at on each release anyway (632 warnings, 637 rows stamped
-- in the window). enrich.sweep skips a stamped release for 30 days, so those
-- releases would not be retried before ~2026-11-07. The worker no longer
-- stamps on network errors (enrichErrorIsRetryable); this clears the stamps
-- the outage left behind so the next nightly sweep (02:00–06:00) retries them.
--
-- Safe to run more than once: a cleared row no longer matches, and a release
-- re-attempted since then carries a newer stamp outside the window. Only
-- releases still missing one side of the bridge are touched (a release that
-- has both ids needs nothing). Prints the count before and after; aborts
-- without changing anything if the window holds far more rows than the
-- outage explains.
--
-- Run (prod, as the owner, after the fix is deployed):
--   docker compose -f docker-compose.prod.yml exec -T postgres \
--     sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1' \
--     < scripts/ops/unmark-outage-bridge-attempts-2026-10-08.sql
-- Expected output: "to_unmark 637" (or fewer if some were retried since),
-- then UPDATE <n>, then "left_in_window 0".
-- Rollback: not needed — the worst case is that the sweep retries a release
-- a month early. To see what changed, the ids are listed before the update.

\set ON_ERROR_STOP on
begin;

select count(*) as to_unmark
  from releases
 where bridge_attempted_at >= timestamptz '2026-10-08 02:00:00+00'
   and bridge_attempted_at <  timestamptz '2026-10-08 06:03:00+00'
   and (discogs_release_id is null or mbid is null);

-- the ids, for the record
select id from releases
 where bridge_attempted_at >= timestamptz '2026-10-08 02:00:00+00'
   and bridge_attempted_at <  timestamptz '2026-10-08 06:03:00+00'
   and (discogs_release_id is null or mbid is null)
 order by id;

do $$
declare n int;
begin
  select count(*) into n from releases
   where bridge_attempted_at >= timestamptz '2026-10-08 02:00:00+00'
     and bridge_attempted_at <  timestamptz '2026-10-08 06:03:00+00'
     and (discogs_release_id is null or mbid is null);
  if n > 1000 then
    raise exception 'refusing: % rows in the outage window, expected about 637', n;
  end if;
end $$;

update releases
   set bridge_attempted_at = null
 where bridge_attempted_at >= timestamptz '2026-10-08 02:00:00+00'
   and bridge_attempted_at <  timestamptz '2026-10-08 06:03:00+00'
   and (discogs_release_id is null or mbid is null);

select count(*) as left_in_window
  from releases
 where bridge_attempted_at >= timestamptz '2026-10-08 02:00:00+00'
   and bridge_attempted_at <  timestamptz '2026-10-08 06:03:00+00'
   and (discogs_release_id is null or mbid is null);

commit;
