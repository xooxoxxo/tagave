-- Matching evidence: what the matcher compared, kept beside each candidate
-- so a decider (the owner's rules, a decision model) reads the same facts
-- the score was made from. Additive: older versions ignore all of it.
--
-- match_candidates.evidence: { v, remote, tracks, align, unmatchedLocal,
-- missingRemote, capped } (core/matching/evidence.ts); null for a row
-- written before this version.
-- match_candidates.acoustid_coverage: the share of the album's fingerprints
-- that matched a recording on this release; null when not looked up.
-- album_evidence: the local side (album facts and tracks), once per album.
-- local_tracks.title_source: where the title came from: tag (file tags or a
-- cue sheet), filename, none (a generated "Track N"); null = not known.
-- local_albums.year_source: tag or folder; null = no year or not known.
-- local_albums.title_source: tag (an album tag or a cue sheet) or folder (no
-- file carries an album tag, so the album is titled after its folder);
-- null = not known.
alter table match_candidates add column if not exists evidence jsonb
  check (evidence is null or jsonb_typeof(evidence) = 'object');
alter table match_candidates add column if not exists acoustid_coverage numeric(5,4)
  check (acoustid_coverage is null or (acoustid_coverage >= 0 and acoustid_coverage <= 1));

create table if not exists album_evidence (
  local_album_id uuid primary key references local_albums(id) on delete cascade,
  v smallint not null,
  evidence jsonb not null check (jsonb_typeof(evidence) = 'object'),
  updated_at timestamptz not null default now()
);

alter table local_tracks add column if not exists title_source varchar(10)
  check (title_source is null or title_source in ('tag', 'filename', 'none'));
alter table local_albums add column if not exists year_source varchar(10)
  check (year_source is null or year_source in ('tag', 'folder'));
alter table local_albums add column if not exists title_source varchar(10)
  check (title_source is null or title_source in ('tag', 'filename', 'folder', 'none'));

-- Backfill, careful side first: a value counts as from the tags only when
-- the file's tags carry it. A cue album's year (its sheet's date, or else
-- the folder) is not known here and is marked folder until it is clustered
-- again.
update local_tracks lt
   set title_source = case
         when lt.origin = 'cue' and lt.title_guess ~ '^Track [0-9]+$' then 'none'
         when lt.origin = 'cue' then 'tag'
         when nullif(btrim(coalesce(f.tags_raw->'common'->>'title', '')), '') is not null then 'tag'
         else 'filename' end
  from files f
 where f.id = lt.audio_file_id and lt.title_source is null;

update local_albums la
   set year_source = case
         when exists (select 1 from local_tracks lt join files f on f.id = lt.audio_file_id
                       where lt.local_album_id = la.id and lt.origin = 'file'
                         and (jsonb_typeof(f.tags_raw->'common'->'year') = 'number'
                              or nullif(btrim(coalesce(f.tags_raw->'common'->>'date', '')), '') is not null))
           then 'tag' else 'folder' end
 where la.year_guess is not null and la.year_source is null;

-- An album's title: from the tags when any of its tracks is a cue track or
-- carries a non-empty album tag; from the folder when it has tracks and none
-- does (the same test as the "no album tags" flag). Albums without tracks
-- stay null.
update local_albums la
   set title_source = case when t.tagged > 0 then 'tag' else 'folder' end
  from (select lt.local_album_id,
               count(*) filter (where lt.origin = 'cue'
                                   or nullif(btrim(f.tags_raw->'common'->>'album'), '') is not null) as tagged
          from local_tracks lt join files f on f.id = lt.audio_file_id
         where lt.local_album_id is not null
         group by lt.local_album_id) t
 where t.local_album_id = la.id and la.title_source is null;
