-- XO-374: MusicBrainz recording + track ids on canonical tracks; a canonical
-- track's identity is (release, medium, position) so links from local_tracks
-- survive a re-fetch (upsertCanonical used to delete+reinsert every row).
alter table canonical_tracks
  add column if not exists recording_mbid varchar(36),
  add column if not exists track_mbid varchar(36);
update canonical_tracks set medium_no = 1 where medium_no is null;
alter table canonical_tracks alter column medium_no set default 1;
alter table canonical_tracks alter column medium_no set not null;
-- defensive dedupe of (release, medium, position) before the unique index:
-- keep the oldest row; re-point any link at the keeper; delete the rest.
-- (rows with NULL position cannot conflict; leave them.)
with ranked as (
  select id, first_value(id) over (partition by release_id, medium_no, position order by id) as keeper,
         row_number() over (partition by release_id, medium_no, position order by id) as rn
  from canonical_tracks where position is not null
)
update local_tracks lt set canonical_track_id = r.keeper
  from ranked r where lt.canonical_track_id = r.id and r.rn > 1;
delete from canonical_tracks ct using (
  select id from (select id, row_number() over (partition by release_id, medium_no, position order by id) rn
                  from canonical_tracks where position is not null) x where x.rn > 1) d
  where ct.id = d.id;
create unique index if not exists canonical_tracks_release_medium_position_uniq
  on canonical_tracks (release_id, medium_no, position);
create index if not exists idx_canonical_tracks_recording_mbid on canonical_tracks (recording_mbid);
-- links: a dropped canonical row must not leave a dangling id
alter table local_tracks drop constraint if exists local_tracks_canonical_track_id_fkey;
alter table local_tracks add constraint local_tracks_canonical_track_id_fkey
  foreign key (canonical_track_id) references canonical_tracks(id) on delete set null;
create index if not exists idx_local_tracks_canonical_track on local_tracks (canonical_track_id);
-- bookkeeping for the link sweep and the lazy track-id refresh
alter table local_albums add column if not exists tracks_linked_at timestamptz;
alter table releases add column if not exists tracks_refreshed_at timestamptz;
create index if not exists idx_local_albums_unlinked on local_albums (library_id)
  where state = 'matched' and tracks_linked_at is null;
