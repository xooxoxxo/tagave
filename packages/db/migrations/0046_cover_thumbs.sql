-- Cover thumbnails move out of images.thumb_bytes into their own table, and
-- every backup leaves that table's rows out (pg_dump --exclude-table-data).
-- They were ~46 % of each dump; the worker rebuilds them from the full-size
-- originals on its cache volume (art.thumb, swept by art.thumbSweep), so a
-- restored database shows placeholders for a few minutes and then its covers.
--
-- They stay in the database, not in files: a split install (app on one
-- computer, worker-files on the music computer) has no shared disk, and the
-- database is the one place both sides reach (see 0003).
--
-- images.thumb_bytes stays in this release, unused and emptied, so nothing
-- that reads the column breaks mid-update. The next release drops it and
-- reclaims the space with VACUUM FULL images. Going back to the older build
-- means restoring the backup taken before this migration, which still holds
-- every thumbnail in thumb_bytes.
--
-- The move runs at boot, after the pre-migration backup, in this file's one
-- transaction: a failure rolls it all back and the next start runs it again.
-- Every statement is safe to re-run (a restored pre-0046 dump comes back
-- through here and moves its thumbnails again). Disk needed while it runs:
-- about three times the thumbnails' size (the new table, plus about twice
-- that in WAL); the app checks for that room before it migrates
-- (COVER_THUMBS_SPACE_FACTOR in @tagave/doctor). The old copy's space comes
-- back only with the next release's vacuum.
CREATE TABLE IF NOT EXISTS cover_thumbs (
  image_id   uuid NOT NULL REFERENCES images(id) ON DELETE CASCADE,
  size       smallint NOT NULL DEFAULT 300,
  bytes      bytea NOT NULL,
  -- the content hash: the ETag the api serves the thumbnail with
  sha256     bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (image_id, size)
);
-- JPEG does not compress: skip pglz and store the bytes out of line.
ALTER TABLE cover_thumbs ALTER COLUMN bytes SET STORAGE EXTERNAL;

INSERT INTO cover_thumbs (image_id, size, bytes, sha256)
  SELECT id, 300, thumb_bytes, sha256(thumb_bytes)
    FROM images
   WHERE thumb_bytes IS NOT NULL
  ON CONFLICT (image_id, size) DO NOTHING;

UPDATE images SET thumb_bytes = NULL WHERE thumb_bytes IS NOT NULL;

COMMENT ON COLUMN images.thumb_bytes IS
  'Unused since 0046 (thumbnails live in cover_thumbs); dropped in the next release.';

-- What the cover rebuild did, for limits that hold across sweeps and
-- processes: 'refetch' (an album whose original was gone, sent back to
-- art.fetch; at most 200 a day per install) and 'sweep' (the api asked
-- worker-files for a sweep; at most one per 30 minutes). Rows older than a
-- week are pruned as new ones are written. Kept in backups (a few KB), so a
-- restore does not reset the daily limit.
CREATE TABLE IF NOT EXISTS cover_rebuild_log (
  id       bigserial PRIMARY KEY,
  kind     text NOT NULL CHECK (kind IN ('refetch', 'sweep')),
  album_id uuid,
  at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_cover_rebuild_log_kind_at ON cover_rebuild_log (kind, at);
