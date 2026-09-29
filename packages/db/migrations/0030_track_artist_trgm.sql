-- Search finds tracks by their own artist (compilations credit a different
-- artist per track), with the same typo tolerance as titles.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX IF NOT EXISTS idx_local_tracks_artist_trgm
  ON local_tracks USING gin (artist_guess gin_trgm_ops);
