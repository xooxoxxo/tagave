-- gaps are recomputed nightly; the natural key lets recompute upsert while
-- preserving dismissed state across runs (spec §11.3)
CREATE UNIQUE INDEX IF NOT EXISTS idx_gaps_natural
  ON gaps (library_id, kind, subject_type, subject_id);
