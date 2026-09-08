-- XO-372 (IDN-5): Chromaprint fingerprints + AcoustID lookups for unidentified albums.
-- audio_files.fingerprint / fingerprint_duration exist since 0000; these columns let the
-- sweep skip files that were tried and albums that were looked up already.
alter table audio_files
  add column if not exists fingerprinted_at timestamptz,
  add column if not exists fingerprint_error text;
create index if not exists idx_audio_files_unfingerprinted
  on audio_files (library_id) where fingerprint is null and fingerprinted_at is null;

alter table local_albums
  add column if not exists fingerprinted_at timestamptz,
  add column if not exists acoustid_result varchar(20);
comment on column local_albums.acoustid_result is 'matched | no_candidates | no_fingerprints | error — outcome of the last AcoustID lookup';
