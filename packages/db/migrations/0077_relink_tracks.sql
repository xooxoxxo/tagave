-- Track links repaired (2026-11). linkAlbumTracks aligned an album's tracks
-- sorted by (disc, track) but wrote the pairs back onto the rows in the
-- order the database returned them, so wherever that order differed from
-- the track order a file was linked to another file's canonical track. Tag
-- plans then wrote the wrong title, track number and recording id.
--
-- 1. Every linked album links again. Clearing tracks_linked_at puts it back
--    in the tracks.link sweep (worker › jobs/tracksLink.ts), which relinks
--    in batches from the database alone, no provider calls. The old links
--    stay in place until each album's own relink replaces them in one
--    statement, so the album page, the player and playlists keep reading a
--    link the whole time. A tag preview relinks the albums it reads first.
update local_albums set tracks_linked_at = null where tracks_linked_at is not null;

-- 2. Previews made from the old links hold wrong items. A previewed plan
--    goes back to draft: Apply is not offered and opening the plan previews
--    it again from the repaired links. Manual and revert plans do not read
--    track links.
update tag_plans set status = 'draft'
 where status = 'previewed'
   and coalesce(case jsonb_typeof(policy) when 'string' then (policy #>> '{}')::jsonb ->> 'preset' else policy ->> 'preset' end, '') not in ('manual', 'revert');

-- 3. A paused apply would resume onto files from the same old preview. Its
--    unwritten items are skipped; what it already wrote stays (a new plan on
--    those albums shows any correction as an ordinary change).
update tag_plan_items i set status = 'skipped', error = 'Track links repaired'
  from tag_plans p
 where p.id = i.tag_plan_id
   and p.status = 'paused'
   and coalesce(case jsonb_typeof(p.policy) when 'string' then (p.policy #>> '{}')::jsonb ->> 'preset' else p.policy ->> 'preset' end, '') not in ('manual', 'revert')
   and i.status in ('pending', 'applying');

-- 4. Each previewed file carries the release track it was paired with and
--    how close the pairing was, so the plan page can show it. No foreign
--    key: a refetched release replaces canonical rows, and a key would make
--    every such delete scan this table; the page joins and shows nothing
--    for a track that is gone.
alter table tag_plan_items
  add column if not exists canonical_track_id uuid,
  add column if not exists match_distance numeric(5, 4);
