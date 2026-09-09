-- cluster_key is a local album's identity inside a library, but nothing
-- enforced it. clusterDirJob looked the row up and then inserted when the
-- lookup missed, and a multi-disc album now has several directories that all
-- resolve to the same scope ("Album CD1"/"Album CD2"), so two cluster.dir jobs
-- can build the same cluster at the same time: both select, both miss, both
-- insert, and the library grows a duplicate album no later run can reconcile.
-- With this index the second one takes the ON CONFLICT branch instead.

-- Defensive only: prod has zero duplicate (library_id, cluster_key) pairs
-- today. Drop the later copies that hold no tracks -- a duplicate that owns
-- track rows is a real album and must be looked at by hand, so let the index
-- fail loudly rather than delete anything that matters.
delete from local_albums la
 using (
   select id from (
     select id,
            row_number() over (partition by library_id, cluster_key
                               order by created_at, id) as rn
       from local_albums
   ) r where r.rn > 1
 ) d
 where la.id = d.id
   and not exists (select 1 from local_tracks lt where lt.local_album_id = la.id);

create unique index if not exists local_albums_library_cluster_key_uniq
  on local_albums (library_id, cluster_key);
