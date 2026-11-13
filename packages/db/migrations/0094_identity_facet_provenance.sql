-- album_matches → album.identity: also when who decided (decided_by and its
-- kind) or the decision's probability changes (a model accept, its undo, or
-- a person endorsing it), since Music Connections sends them as provenance
-- and confidence. Applied after 0093's backfill, so filling those columns
-- for history logged nothing.
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
             where (n.status, n.release_id, n.distance, n.source, n.local_album_id, n.decided_by, n.decided_kind, n.probability)
                   is distinct from (o.status, o.release_id, o.distance, o.source, o.local_album_id, o.decided_by, o.decided_kind, o.probability)
            union
            select o.local_album_id from new_rows n join old_rows o on o.id = n.id
             where (n.status, n.release_id, n.distance, n.source, n.local_album_id, n.decided_by, n.decided_kind, n.probability)
                   is distinct from (o.status, o.release_id, o.distance, o.source, o.local_album_id, o.decided_by, o.decided_kind, o.probability)) m
      join local_albums la on la.id = m.local_album_id
     where la.release_group_id is not null;
  end if;
  perform facet_log('album.identity@1', l, array_fill(null::uuid, array[coalesce(cardinality(k), 0)]), k);
  return null;
end $$;
