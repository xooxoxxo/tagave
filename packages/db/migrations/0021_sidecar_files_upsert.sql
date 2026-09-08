-- The scanner used to replace a root's sidecar inventory wholesale (delete +
-- insert). Once art fetch had created images rows with origin = 'sidecar',
-- that delete cascaded ON DELETE SET NULL into images and tripped its check
-- (origin = 'sidecar' requires sidecar_file_id) — every full scan failed at
-- the end (seen live 2026-09-08: "walk failed: new row for relation images
-- violates check constraint images_check"). The walker now upserts sidecars
-- by (scan_root_id, rel_path) and removes only the rows it did not see,
-- deleting their dependent images first.
alter table sidecar_files add column if not exists last_seen_at timestamptz not null default now();

-- Duplicates cannot normally exist (the old code rebuilt the inventory per
-- scan), but be safe: keep the lowest id per path, re-point images to it.
with ranked as (
  select id, scan_root_id, rel_path,
         row_number() over (partition by scan_root_id, rel_path order by id) as rn,
         first_value(id) over (partition by scan_root_id, rel_path order by id) as keep_id
    from sidecar_files
), dupes as (select id, keep_id from ranked where rn > 1)
update images i set sidecar_file_id = d.keep_id from dupes d where i.sidecar_file_id = d.id;

delete from sidecar_files s
 using (select id from (select id, row_number() over (partition by scan_root_id, rel_path order by id) as rn from sidecar_files) r where r.rn > 1) d
 where s.id = d.id;

create unique index if not exists sidecar_files_root_path_key on sidecar_files (scan_root_id, rel_path);
