-- Files core, step 1 (vault "tagave - Core Platform Architecture", phase A1;
-- owner decision 4, 2026-10-27). audio_files becomes files: the one table
-- every file type shares, each row read and written by a file-type handler
-- (packages/core/src/files/handlers.ts). Today every row is an audio file.
--
-- Everything here is a catalogue change: the rename, the constraint, index,
-- trigger and function renames, and `handler` (added with a constant default,
-- so existing rows read 'audio' without a rewrite). No row is copied.
-- Re-runnable: each step checks what is already done.

do $$
begin
  if exists (select 1 from pg_class where relname = 'audio_files' and relnamespace = 'public'::regnamespace and relkind = 'r') then
    alter table audio_files rename to files;
  end if;
end $$;

-- The table's own names follow it, so only the compatibility view below still
-- says audio_files. Renaming the primary and unique keys renames their indexes.
-- The foreign keys that point at files (local_tracks, cluster_overrides,
-- tag_plan_items, images) keep their names: those name their column,
-- audio_file_id, which stays.
do $$
declare
  r record;
begin
  for r in select * from (values
      ('audio_files_pkey', 'files_pkey'),
      ('audio_files_scan_root_id_rel_path_key', 'files_scan_root_id_rel_path_key'),
      ('audio_files_status_check', 'files_status_check'),
      ('audio_files_library_id_fkey', 'files_library_id_fkey'),
      ('audio_files_scan_root_id_fkey', 'files_scan_root_id_fkey')) as c(old_name, new_name)
  loop
    if exists (select 1 from pg_constraint where conrelid = 'public.files'::regclass and conname = r.old_name) then
      execute format('alter table files rename constraint %I to %I', r.old_name, r.new_name);
    end if;
  end loop;
end $$;

alter index if exists idx_audio_files_library rename to idx_files_library;
alter index if exists idx_audio_files_scan_root rename to idx_files_scan_root;
alter index if exists idx_audio_files_status rename to idx_files_status;
alter index if exists idx_audio_files_relpath_prefix rename to idx_files_relpath_prefix;
alter index if exists idx_audio_files_unfingerprinted rename to idx_files_unfingerprinted;
alter index if exists idx_audio_files_present_root rename to idx_files_present_root;
alter index if exists idx_audio_files_library_size rename to idx_files_library_size;
alter index if exists idx_audio_files_reconcile_hold rename to idx_files_reconcile_hold;
alter index if exists idx_audio_files_digest_backfill rename to idx_files_digest_backfill;
alter index if exists idx_audio_files_missing_held rename to idx_files_missing_held;

-- The album.collection@1 change-log trigger (0048) stays on the table; only its names change.
do $$
begin
  if exists (select 1 from pg_trigger where tgrelid = 'public.files'::regclass and tgname = 'facet_audio_files_upd') then
    alter trigger facet_audio_files_upd on files rename to facet_files_upd;
  end if;
  if exists (select 1 from pg_proc where proname = 'facet_trg_audio_files' and pronamespace = 'public'::regnamespace) then
    alter function facet_trg_audio_files() rename to facet_trg_files;
  end if;
end $$;

-- Which file-type handler reads (and may write) the file: 'audio' for every
-- row so far. New rows name theirs (the walk); there is no default, so a
-- writer that forgets fails instead of filing a book as audio.
alter table files add column if not exists handler text not null default 'audio';
alter table files alter column handler drop default;
-- The handler's MIME type for the file (audio/flac, audio/mpeg …). The walk
-- sets it on every file it sees, so rows fill in on the first scan after this;
-- rows no scan sees again (missing ones) keep null.
alter table files add column if not exists media_type text;

-- album.collection@1's "do we still have the files" check (0048), reading the table by its new name.
create or replace function facet_present(fct text, lib uuid, usr uuid, k text) returns boolean
language plpgsql stable as $$
declare
  uuid_re constant text := '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
  rg uuid;
  day date;
begin
  if fct = 'album.rating@1' then
    if k !~ uuid_re then return false; end if;
    return exists (select 1 from user_reviews r
                    where r.library_id = lib and r.user_id = usr and r.release_group_id = k::uuid and r.rating is not null);
  elsif fct = 'album.listens@1' then
    if split_part(k, ':', 1) !~ uuid_re or split_part(k, ':', 2) !~ '^\d{4}-\d{2}-\d{2}$' then return false; end if;
    rg := split_part(k, ':', 1)::uuid;
    day := split_part(k, ':', 2)::date;
    return exists (select 1 from listens l
                    where l.library_id = lib and l.user_id = usr and l.release_group_id = rg
                      and l.listened_at >= (day::timestamp at time zone 'UTC')
                      and l.listened_at < ((day + 1)::timestamp at time zone 'UTC'));
  elsif fct = 'album.identity@1' then
    if k !~ uuid_re then return false; end if;
    return exists (select 1 from local_albums la
                    where la.library_id = lib and la.state = 'matched' and la.release_group_id = k::uuid);
  elsif fct = 'album.collection@1' then
    if k ~ uuid_re then
      return exists (select 1 from collection_items ci
                      where ci.library_id = lib and ci.removed_at is null and ci.release_group_id = k::uuid)
          or exists (select 1 from local_albums la
                      where la.library_id = lib and la.state = 'matched' and la.release_group_id = k::uuid
                        and exists (select 1 from local_tracks lt join files af on af.id = lt.audio_file_id
                                     where lt.local_album_id = la.id and af.status not in ('missing', 'archived')));
    elsif k ~ '^discogs-release:\d{1,10}$' then
      return exists (select 1 from collection_items ci
                      where ci.library_id = lib and ci.removed_at is null and ci.release_group_id is null
                        and ci.discogs_release_id = substr(k, 17)::bigint);
    elsif k ~ ('^collection-item:' || substr(uuid_re, 2)) then
      return exists (select 1 from collection_items ci
                      where ci.library_id = lib and ci.removed_at is null and ci.release_group_id is null
                        and ci.discogs_release_id is null and ci.id = substr(k, 17)::uuid);
    end if;
    return false;
  end if;
  return false;
end $$;

-- For one release, for readers outside tagave (scripts, dashboards, ad-hoc
-- SQL): the audio rows with audio_files' columns as of 0057, in its order.
-- tagave itself reads and writes files. Read-only: a write fails loudly
-- instead of landing through the view.
create or replace view audio_files as
  select id, library_id, scan_root_id, rel_path, size_bytes, mtime, inode, container, codec, lossless, duration_ms,
         sample_rate, bit_depth, channels, bitrate_kbps, has_embedded_art, tags_raw, tags_digest, tags_read_at,
         audio_hash, audio_hash_at, fingerprint, fingerprint_duration, status, parse_error, first_seen_at, last_seen_at,
         fingerprinted_at, fingerprint_error, core_tags_digest, reconcile_hold_at, missing_held_at
    from files
   where handler = 'audio';
comment on view audio_files is 'Read-only view of files (handler audio) with the columns audio_files had before 0058. Kept for one release; read files.';

create or replace function audio_files_read_only() returns trigger language plpgsql as $$
begin
  raise exception 'audio_files is a read-only view since 0058; write to files'
    using errcode = 'feature_not_supported';
end $$;

drop trigger if exists audio_files_read_only on audio_files;
create trigger audio_files_read_only instead of insert or update or delete on audio_files
  for each row execute function audio_files_read_only();
