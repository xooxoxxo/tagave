-- cluster.dir does rel_path LIKE 'dir/%' per directory; without a
-- text_pattern_ops index every job seq-scans 240k rows.
CREATE INDEX IF NOT EXISTS idx_audio_files_relpath_prefix
  ON audio_files (scan_root_id, rel_path text_pattern_ops);
