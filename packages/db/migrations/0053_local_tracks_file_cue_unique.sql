-- local_tracks are upserted in place from now on (move-safe scanning §2), keyed
-- by (audio_file_id, cue_start_ms). Plain files have cue_start_ms NULL, which
-- an ordinary unique index treats as distinct, hence NULLS NOT DISTINCT (PG 15+).
--
-- Existing duplicates are folded first. Per key the kept row is the one linked
-- to a canonical track, then one the player mapped, then the smallest id.
-- Plays, player events and favourite tracks pointing at a dropped twin move
-- to the kept row; the twin's player_track_map row cascades away.
create temp table _lt_dupes on commit drop as
select id, keep_id from (
  select lt.id,
         first_value(lt.id) over w as keep_id,
         row_number() over w as rn
    from local_tracks lt
  window w as (partition by lt.audio_file_id, lt.cue_start_ms
               order by (lt.canonical_track_id is not null) desc,
                        (exists (select 1 from player_track_map p where p.local_track_id = lt.id)) desc,
                        lt.id)
) r
where rn > 1;

update player_plays p set local_track_id = d.keep_id from _lt_dupes d where p.local_track_id = d.id;
update player_events e set local_track_id = d.keep_id from _lt_dupes d where e.local_track_id = d.id;
update user_reviews u
   set favorite_track_ids = (select array_agg(distinct coalesce(d.keep_id, f))
                               from unnest(u.favorite_track_ids) f
                               left join _lt_dupes d on d.id = f)
 where u.favorite_track_ids && (select coalesce(array_agg(id), '{}') from _lt_dupes);
delete from local_tracks lt using _lt_dupes d where lt.id = d.id;

alter table local_tracks drop constraint if exists local_tracks_file_cue_key;
alter table local_tracks add constraint local_tracks_file_cue_key
  unique nulls not distinct (audio_file_id, cue_start_ms);
