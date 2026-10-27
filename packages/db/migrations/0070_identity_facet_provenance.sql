-- album_matches → album.identity: also when the decision's kind or its
-- probability changes (a model accept, or its undo), since Music
-- Connections sends both as provenance and confidence. Applied after 0069's
-- backfill, so filling those columns for history logged nothing.
create or replace function facet_trg_album_matches() returns trigger language plpgsql as $$
declare l uuid[]; k text[];
begin
  if tg_op = 'INSERT' then
    select array_agg(la.library_id), array_agg(la.release_group_id::text) into l, k
      from (select distinct local_album_id from new_rows) m join local_albums la on la.id = m.local_album_id
     where la.release_group_id is not null;
  elsif tg_op = 'DELETE' then
    select array_agg(la.library_id), array_agg(la.release_group_id::text) into l, k
      from (select distinct local_album_id from old_rows) m join local_albums la on la.id = m.local_album_id
     where la.release_group_id is not null;
  else
    select array_agg(la.library_id), array_agg(la.release_group_id::text) into l, k
      from (select n.local_album_id from new_rows n join old_rows o on o.id = n.id
             where (n.status, n.release_id, n.distance, n.source, n.local_album_id, n.decided_kind, n.probability)
                   is distinct from (o.status, o.release_id, o.distance, o.source, o.local_album_id, o.decided_kind, o.probability)
            union
            select o.local_album_id from new_rows n join old_rows o on o.id = n.id
             where (n.status, n.release_id, n.distance, n.source, n.local_album_id, n.decided_kind, n.probability)
                   is distinct from (o.status, o.release_id, o.distance, o.source, o.local_album_id, o.decided_kind, o.probability)) m
      join local_albums la on la.id = m.local_album_id
     where la.release_group_id is not null;
  end if;
  perform facet_log('album.identity@1', l, array_fill(null::uuid, array[coalesce(cardinality(k), 0)]), k);
  return null;
end $$;
