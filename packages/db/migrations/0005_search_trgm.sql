-- BRW-4 search: trigram indexes for typo-tolerant substring match.
-- Direct-query v1; search_documents materialization (§12.7) comes later if
-- p95 demands it.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX IF NOT EXISTS idx_local_albums_title_trgm
  ON local_albums USING gin (title_guess gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_local_albums_artist_trgm
  ON local_albums USING gin (artist_guess gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_local_tracks_title_trgm
  ON local_tracks USING gin (title_guess gin_trgm_ops);
