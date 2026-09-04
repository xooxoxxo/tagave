-- Split-host dev (worker on g9, api on Mac) has no shared cache volume yet;
-- 300px thumbnails ride in the DB so the api can serve them anywhere.
-- Originals stay on the worker's disk at images.local_path.
ALTER TABLE images ADD COLUMN IF NOT EXISTS thumb_bytes bytea;
ALTER TABLE images ADD COLUMN IF NOT EXISTS local_album_id uuid REFERENCES local_albums(id) ON DELETE CASCADE;
CREATE UNIQUE INDEX IF NOT EXISTS idx_images_local_album_front
  ON images (local_album_id) WHERE kind = 'front';
