-- Move-safe scanning, release A. A moved file keeps its row (old id wins):
-- reconciliation pairs a vanished row with a new one by dev:ino + size, or
-- size + mtime + name (Tier 1), or size + duration + core_tags_digest (Tier 2).

-- Tier 2's normalized tag signature (artist, album artist, album, title,
-- track, disc, year, MusicBrainz ids). Filled by scan.parse, tags.apply and
-- the files.backfillDigest job (from tags_raw, so ghosts get one too).
alter table audio_files add column if not exists core_tags_digest varchar(64);

-- Set on a new row whose size equals a missing row's: cluster.dir leaves its
-- folder alone until Tier 2 has looked at it, at most one hour.
alter table audio_files add column if not exists reconcile_hold_at timestamptz;

-- Candidates are looked up by size within a library.
create index if not exists idx_audio_files_library_size on audio_files (library_id, size_bytes);
-- Held rows are few; cluster.dir and scan.parse look them up per root.
create index if not exists idx_audio_files_reconcile_hold on audio_files (scan_root_id) where reconcile_hold_at is not null;
-- files.backfillDigest runs at every boot; after the first run only untagged
-- rows match, so its keyset select reads this small index, not the table.
-- The predicate must stay identical to the job's.
create index if not exists idx_audio_files_digest_backfill on audio_files (id) where core_tags_digest is null and tags_raw is not null;

-- tags.apply stored mtime in milliseconds while the walk stores seconds, so
-- every tag write looked like a change to the next walk. 1e11 seconds is the
-- year 5138, 1e11 milliseconds is 1973: nothing real sits on the wrong side.
update audio_files set mtime = mtime / 1000 where mtime > 100000000000;

-- An image read from a file or a sidecar goes with that row. ON DELETE SET
-- NULL could never succeed: the origin CHECK requires the reference.
alter table images drop constraint if exists images_audio_file_id_fkey;
alter table images add constraint images_audio_file_id_fkey
  foreign key (audio_file_id) references audio_files(id) on delete cascade;
alter table images drop constraint if exists images_sidecar_file_id_fkey;
alter table images add constraint images_sidecar_file_id_fkey
  foreign key (sidecar_file_id) references sidecar_files(id) on delete cascade;
