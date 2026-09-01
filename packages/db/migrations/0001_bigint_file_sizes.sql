-- size_bytes as int4 overflows on files > 2 GiB (DSD, full-album images);
-- mtime as int4 dies in 2038. Widen both wherever file facts are stored.
ALTER TABLE audio_files ALTER COLUMN size_bytes TYPE bigint;
ALTER TABLE audio_files ALTER COLUMN mtime TYPE bigint;
ALTER TABLE sidecar_files ALTER COLUMN size_bytes TYPE bigint;
ALTER TABLE sidecar_files ALTER COLUMN mtime TYPE bigint;
