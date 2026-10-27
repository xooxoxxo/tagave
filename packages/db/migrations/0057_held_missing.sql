-- A scan that would mark more files missing than the hold threshold marks
-- none of them and stamps them here instead. A later scan that still finds a
-- stamped file gone 24 hours or more after the stamp marks it missing, so a
-- large deletion does not stay held for ever. Cleared once the file is seen
-- again or marked missing.
alter table audio_files add column if not exists missing_held_at timestamptz;
-- Stamped rows are few; each scan looks them up per root.
create index if not exists idx_audio_files_missing_held on audio_files (scan_root_id) where missing_held_at is not null;
