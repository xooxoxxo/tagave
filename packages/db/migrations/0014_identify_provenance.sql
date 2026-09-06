-- XO-309: identification provenance for the embedded-MBID fast-path metrics.
-- album_matches.source: provenance of the chosen candidate
--   mbid | mb_search | discogs_search | user_mbid | user_discogs
-- local_albums.embedded_mbid: first MusicBrainz release id found in the
--   album's file tags (IDN-1a fast path); eligible / hit / fell-through counts
alter table album_matches add column if not exists source varchar(50);
alter table local_albums add column if not exists embedded_mbid varchar(36);

-- live matches take the source of the candidate row that produced them
-- (candidate rows survive until the album is re-identified)
update album_matches am
   set source = mc.source
  from match_candidates mc
 where mc.local_album_id = am.local_album_id
   and mc.release_id = am.release_id
   and am.source is null;

-- embedded ids from file tags, lowest disc/track with a valid id first;
-- mirrors worker embeddedIdsOf: first element of an array-valued tag,
-- trimmed, lower-cased, must look like a UUID (241k-file prod library: ~0.3 s)
update local_albums la
   set embedded_mbid = sub.mbid
  from (select distinct on (local_album_id) local_album_id, mbid
          from (select lt.local_album_id, lt.disc_no, lt.track_no,
                       lower(trim(case jsonb_typeof(af.tags_raw->'common'->'musicbrainz_albumid')
                                    when 'array' then af.tags_raw->'common'->'musicbrainz_albumid'->>0
                                    else af.tags_raw->'common'->>'musicbrainz_albumid'
                                  end)) as mbid
                  from local_tracks lt
                  join audio_files af on af.id = lt.audio_file_id
                 where af.tags_raw->'common' ? 'musicbrainz_albumid') t
         where mbid ~ '^[0-9a-f-]{36}$'
         order by local_album_id, disc_no nulls first, track_no nulls first) sub
 where sub.local_album_id = la.id
   and la.embedded_mbid is null;

create index if not exists idx_album_matches_live_source
    on album_matches (library_id, source) where status in ('auto', 'confirmed');
create index if not exists idx_local_albums_embedded_mbid
    on local_albums (library_id) where embedded_mbid is not null;
