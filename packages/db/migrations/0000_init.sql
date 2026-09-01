-- Enable extensions
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS unaccent;

-- Platform tables (not library-scoped)
CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email varchar(255) NOT NULL UNIQUE,
  display_name varchar(255),
  password_hash varchar(255) NOT NULL,
  role varchar(20) NOT NULL DEFAULT 'owner' CHECK (role IN ('owner', 'viewer')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE libraries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name varchar(255) NOT NULL,
  settings jsonb DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE provider_state (
  provider varchar(50) NOT NULL PRIMARY KEY,
  window_started_at timestamptz,
  requests_used integer DEFAULT 0,
  circuit_open_until timestamptz,
  last_429_at timestamptz,
  last_error text
);

CREATE TABLE job_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  library_id uuid NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  pgboss_id varchar(255),
  type varchar(50) NOT NULL,
  subject_type varchar(50),
  subject_id uuid,
  state varchar(20) NOT NULL DEFAULT 'created',
  progress jsonb DEFAULT '{"done": 0, "total": 0}',
  started_at timestamptz,
  finished_at timestamptz,
  error text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_job_runs_library ON job_runs(library_id);

-- Observed layer (per library)
CREATE TABLE scan_roots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  library_id uuid NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  path varchar(2048) NOT NULL,
  display_name varchar(255) NOT NULL,
  writable boolean NOT NULL DEFAULT true,
  enabled boolean NOT NULL DEFAULT true,
  poll_interval_s integer NOT NULL DEFAULT 21600,
  last_scan_at timestamptz,
  last_status varchar(50),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_scan_roots_library ON scan_roots(library_id);

CREATE TABLE scans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scan_root_id uuid NOT NULL REFERENCES scan_roots(id) ON DELETE CASCADE,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  status varchar(20) NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'completed', 'failed', 'paused')),
  stats jsonb DEFAULT '{}',
  cursor jsonb
);

CREATE INDEX idx_scans_scan_root ON scans(scan_root_id);

CREATE TABLE audio_files (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  library_id uuid NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  scan_root_id uuid NOT NULL REFERENCES scan_roots(id) ON DELETE CASCADE,
  rel_path varchar(2048) NOT NULL,
  size_bytes bigint,
  mtime bigint,
  inode varchar(100),
  container varchar(20),
  codec varchar(50),
  lossless boolean,
  duration_ms integer,
  sample_rate integer,
  bit_depth integer,
  channels integer,
  bitrate_kbps integer,
  has_embedded_art boolean DEFAULT false,
  tags_raw jsonb,
  tags_digest varchar(64),
  tags_read_at timestamptz,
  audio_hash varchar(64),
  audio_hash_at timestamptz,
  fingerprint varchar(255),
  fingerprint_duration integer,
  status varchar(20) NOT NULL DEFAULT 'present' CHECK (status IN ('present', 'missing', 'archived', 'error')),
  parse_error text,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (scan_root_id, rel_path)
);

CREATE INDEX idx_audio_files_library ON audio_files(library_id);
CREATE INDEX idx_audio_files_scan_root ON audio_files(scan_root_id);
CREATE INDEX idx_audio_files_status ON audio_files(status);

CREATE TABLE sidecar_files (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  library_id uuid NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  scan_root_id uuid NOT NULL REFERENCES scan_roots(id) ON DELETE CASCADE,
  rel_path varchar(2048) NOT NULL,
  kind varchar(20) NOT NULL CHECK (kind IN ('image', 'cue', 'log', 'text', 'other')),
  size_bytes bigint,
  mtime bigint
);

CREATE INDEX idx_sidecar_files_library ON sidecar_files(library_id);

CREATE TABLE local_albums (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  library_id uuid NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  cluster_key varchar(512) NOT NULL,
  dir_paths text[] NOT NULL DEFAULT '{}',
  title_guess varchar(255),
  artist_guess varchar(255),
  year_guess integer,
  disc_count integer,
  track_count integer,
  total_duration_ms integer,
  formats text[] DEFAULT '{}',
  state varchar(20) NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'needs_review', 'unidentified', 'matched', 'as_is', 'ignored')),
  release_id uuid,
  release_group_id uuid,
  quality_flags jsonb DEFAULT '[]',
  preferred boolean DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_local_albums_library ON local_albums(library_id);
CREATE INDEX idx_local_albums_cluster_key ON local_albums(cluster_key);
CREATE INDEX idx_local_albums_state ON local_albums(state);
CREATE INDEX idx_local_albums_release_group_id ON local_albums(release_group_id);

CREATE TABLE local_tracks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  local_album_id uuid REFERENCES local_albums(id) ON DELETE CASCADE,
  audio_file_id uuid NOT NULL REFERENCES audio_files(id) ON DELETE CASCADE,
  disc_no integer,
  track_no integer,
  title_guess varchar(255),
  artist_guess varchar(255),
  duration_ms integer,
  canonical_track_id uuid,
  recording_id uuid,
  match_distance numeric(5,4),
  state varchar(20) DEFAULT 'unmatched'
);

CREATE INDEX idx_local_tracks_album ON local_tracks(local_album_id);
CREATE INDEX idx_local_tracks_audio_file ON local_tracks(audio_file_id);

CREATE TABLE cluster_overrides (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  library_id uuid NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  audio_file_id uuid NOT NULL REFERENCES audio_files(id) ON DELETE CASCADE,
  local_album_id uuid REFERENCES local_albums(id) ON DELETE CASCADE,
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_cluster_overrides_library ON cluster_overrides(library_id);

-- Canonical layer (global cache)
CREATE TABLE artists (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  mbid varchar(36),
  discogs_id integer,
  name varchar(255) NOT NULL,
  sort_name varchar(255),
  disambiguation text,
  type varchar(50),
  country varchar(2),
  begin_date date,
  end_date date,
  bio jsonb,
  fetched_at timestamptz,
  UNIQUE (mbid),
  UNIQUE (discogs_id),
  CHECK (bio IS NULL OR (bio->>'license' IS NOT NULL))
);

CREATE INDEX idx_artists_mbid ON artists(mbid);

CREATE TABLE release_groups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  mbid varchar(36) NOT NULL UNIQUE,
  discogs_master_id integer UNIQUE,
  title varchar(255) NOT NULL,
  primary_type varchar(50),
  secondary_types text[] DEFAULT '{}',
  first_release_date date,
  artist_credit jsonb,
  fetched_at timestamptz
);

CREATE INDEX idx_release_groups_mbid ON release_groups(mbid);

CREATE TABLE releases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  release_group_id uuid NOT NULL REFERENCES release_groups(id) ON DELETE CASCADE,
  mbid varchar(36) UNIQUE,
  discogs_release_id integer UNIQUE,
  title varchar(255) NOT NULL,
  status varchar(50),
  date date,
  country varchar(2),
  barcode varchar(50),
  labels jsonb DEFAULT '[]',
  media jsonb DEFAULT '[]',
  track_count integer,
  packaging varchar(50),
  source_of_truth varchar(20) DEFAULT 'musicbrainz' CHECK (source_of_truth IN ('musicbrainz', 'discogs')),
  fetched_at timestamptz
);

CREATE INDEX idx_releases_release_group ON releases(release_group_id);
CREATE INDEX idx_releases_mbid ON releases(mbid);

CREATE TABLE canonical_tracks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  release_id uuid NOT NULL REFERENCES releases(id) ON DELETE CASCADE,
  medium_no integer,
  position integer,
  number varchar(20),
  title varchar(255) NOT NULL,
  artist_credit jsonb,
  recording_id uuid,
  length_ms integer,
  is_data_track boolean DEFAULT false,
  is_video boolean DEFAULT false
);

CREATE INDEX idx_canonical_tracks_release ON canonical_tracks(release_id);

CREATE TABLE recordings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  mbid varchar(36) UNIQUE,
  title varchar(255) NOT NULL,
  length_ms integer,
  isrcs text[] DEFAULT '{}',
  acoustids text[] DEFAULT '{}',
  work_mbid varchar(36)
);

CREATE INDEX idx_recordings_mbid ON recordings(mbid);

CREATE TABLE labels (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  mbid varchar(36) UNIQUE,
  discogs_id integer UNIQUE,
  name varchar(255) NOT NULL,
  country varchar(2)
);

CREATE INDEX idx_labels_mbid ON labels(mbid);

CREATE TABLE entity_tags (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type varchar(50) NOT NULL,
  entity_id uuid NOT NULL,
  tag varchar(100) NOT NULL,
  kind varchar(20) NOT NULL CHECK (kind IN ('genre', 'style', 'tag')),
  source varchar(50) NOT NULL,
  weight numeric(10,4),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_entity_tags_entity ON entity_tags(entity_type, entity_id);

CREATE TABLE credits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type varchar(50) NOT NULL,
  entity_id uuid NOT NULL,
  artist_id uuid NOT NULL REFERENCES artists(id) ON DELETE CASCADE,
  role varchar(100) NOT NULL,
  source varchar(50) NOT NULL
);

CREATE INDEX idx_credits_entity ON credits(entity_type, entity_id);

CREATE TABLE image_sources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type varchar(50) NOT NULL,
  entity_id uuid NOT NULL,
  kind varchar(50) NOT NULL CHECK (kind IN ('front', 'back', 'medium', 'artist', 'logo')),
  provider varchar(50) NOT NULL,
  source_url varchar(2048),
  width integer,
  height integer,
  license_note text NOT NULL,
  fetched_at timestamptz
);

CREATE INDEX idx_image_sources_entity ON image_sources(entity_type, entity_id);

CREATE TABLE external_ids (
  entity_type varchar(50) NOT NULL,
  entity_id uuid NOT NULL,
  provider varchar(50) NOT NULL,
  external_id varchar(255) NOT NULL,
  url varchar(2048),
  confidence numeric(5,4),
  source varchar(50),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, external_id, entity_type)
);

CREATE INDEX idx_external_ids_entity ON external_ids(entity_type, entity_id);

CREATE TABLE external_reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  release_group_id uuid NOT NULL REFERENCES release_groups(id) ON DELETE CASCADE,
  source varchar(50) NOT NULL,
  source_id varchar(255),
  url varchar(2048),
  author varchar(255),
  title varchar(255),
  body_text text,
  excerpt text,
  rating_raw numeric(5,2),
  rating_scale integer,
  rating_normalized integer,
  license text NOT NULL,
  language varchar(10),
  published_at timestamptz,
  fetched_at timestamptz
);

CREATE INDEX idx_external_reviews_release_group ON external_reviews(release_group_id);

CREATE TABLE review_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  release_group_id uuid NOT NULL REFERENCES release_groups(id) ON DELETE CASCADE,
  source varchar(50) NOT NULL,
  url varchar(2048) NOT NULL,
  discovered_via varchar(50),
  resolved_at timestamptz
);

CREATE INDEX idx_review_links_release_group ON review_links(release_group_id);

CREATE TABLE provider_cache (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider varchar(50) NOT NULL,
  cache_key varchar(512) NOT NULL,
  payload jsonb NOT NULL,
  fetched_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,
  UNIQUE (provider, cache_key)
);

-- Curated layer (per library)
CREATE TABLE images (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  library_id uuid NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  entity_type varchar(50) NOT NULL,
  entity_id uuid NOT NULL,
  kind varchar(50) NOT NULL,
  origin varchar(50) NOT NULL CHECK (origin IN ('embedded', 'sidecar', 'provider', 'owner')),
  image_source_id uuid REFERENCES image_sources(id) ON DELETE SET NULL,
  audio_file_id uuid REFERENCES audio_files(id) ON DELETE SET NULL,
  sidecar_file_id uuid REFERENCES sidecar_files(id) ON DELETE SET NULL,
  local_path varchar(2048),
  width integer,
  height integer,
  bytes bytea,
  license_note text NOT NULL,
  fetched_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (origin = 'embedded' AND audio_file_id IS NOT NULL) OR
    (origin = 'sidecar' AND sidecar_file_id IS NOT NULL) OR
    (origin = 'provider' AND image_source_id IS NOT NULL) OR
    (origin = 'owner')
  )
);

CREATE INDEX idx_images_library ON images(library_id);
CREATE INDEX idx_images_entity ON images(entity_type, entity_id);

CREATE TABLE match_candidates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  local_album_id uuid NOT NULL REFERENCES local_albums(id) ON DELETE CASCADE,
  release_id uuid NOT NULL REFERENCES releases(id) ON DELETE CASCADE,
  distance numeric(5,4) NOT NULL,
  breakdown jsonb DEFAULT '{}',
  source varchar(50) NOT NULL,
  excluded boolean DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_match_candidates_album ON match_candidates(local_album_id);

CREATE TABLE album_matches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  library_id uuid NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  local_album_id uuid NOT NULL REFERENCES local_albums(id) ON DELETE CASCADE,
  release_id uuid NOT NULL REFERENCES releases(id) ON DELETE CASCADE,
  release_group_only boolean DEFAULT false,
  distance numeric(5,4) NOT NULL,
  status varchar(20) NOT NULL DEFAULT 'auto' CHECK (status IN ('auto', 'confirmed', 'rejected')),
  decided_by varchar(20) NOT NULL DEFAULT 'system' CHECK (decided_by IN ('system', 'user')),
  reason text,
  decided_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_album_matches_library ON album_matches(library_id);
CREATE INDEX idx_album_matches_album ON album_matches(local_album_id);
-- Partial unique index: only one live match per album
CREATE UNIQUE INDEX idx_album_matches_live
  ON album_matches(local_album_id)
  WHERE status IN ('auto', 'confirmed');

CREATE TABLE field_locks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  library_id uuid NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  scope varchar(20) NOT NULL CHECK (scope IN ('album', 'track', 'artist')),
  scope_id uuid NOT NULL,
  field varchar(50) NOT NULL,
  value jsonb,
  reason text,
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_field_locks_library ON field_locks(library_id);
CREATE INDEX idx_field_locks_scope ON field_locks(scope, scope_id);

CREATE TABLE tag_plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  library_id uuid NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  name varchar(255) NOT NULL,
  scope jsonb NOT NULL,
  policy jsonb NOT NULL,
  status varchar(20) NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'previewed', 'applying', 'paused', 'cancelled', 'applied', 'partially_failed', 'reverted')),
  stats jsonb DEFAULT '{}',
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  applied_at timestamptz
);

CREATE INDEX idx_tag_plans_library ON tag_plans(library_id);

CREATE TABLE tag_plan_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tag_plan_id uuid NOT NULL REFERENCES tag_plans(id) ON DELETE CASCADE,
  audio_file_id uuid NOT NULL REFERENCES audio_files(id) ON DELETE CASCADE,
  before jsonb NOT NULL,
  after jsonb NOT NULL,
  diff jsonb NOT NULL,
  status varchar(20) DEFAULT 'pending' CHECK (status IN ('pending', 'applied', 'failed', 'skipped')),
  error text,
  audio_hash_before varchar(64),
  audio_hash_after varchar(64),
  size_after bigint,
  mtime_after bigint,
  applied_at timestamptz,
  CHECK (
    status != 'applied' OR (audio_hash_before = audio_hash_after)
  )
);

CREATE INDEX idx_tag_plan_items_plan ON tag_plan_items(tag_plan_id);
CREATE INDEX idx_tag_plan_items_file ON tag_plan_items(audio_file_id);

CREATE TABLE followed_artists (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  library_id uuid NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  artist_id uuid NOT NULL REFERENCES artists(id) ON DELETE CASCADE,
  mode varchar(20) NOT NULL DEFAULT 'auto' CHECK (mode IN ('auto', 'manual')),
  include_primary text[] DEFAULT '{"Album"}',
  exclude_secondary text[] DEFAULT '{"Compilation", "Live", "Remix", "DJ-mix", "Mixtape/Street", "Demo", "Soundtrack"}',
  last_refreshed_at timestamptz,
  last_viewed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_followed_artists_library ON followed_artists(library_id);

CREATE TABLE gaps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  library_id uuid NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  kind varchar(50) NOT NULL CHECK (kind IN ('missing_track', 'incomplete_album', 'missing_album', 'physical_only', 'digital_only', 'duplicate', 'quality', 'unidentified', 'parse_error')),
  subject_type varchar(50) NOT NULL,
  subject_id uuid NOT NULL,
  details jsonb DEFAULT '{}',
  state varchar(20) NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'dismissed', 'resolved')),
  dismiss_reason varchar(50) CHECK (dismiss_reason IN ('not_interested', 'wrong_data', 'own_elsewhere')),
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz
);

CREATE INDEX idx_gaps_library ON gaps(library_id);
CREATE INDEX idx_gaps_kind ON gaps(kind);

CREATE TABLE collection_sources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  library_id uuid NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  provider varchar(50) NOT NULL,
  username varchar(255),
  last_sync_at timestamptz,
  sync_cursor jsonb,
  status varchar(20),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_collection_sources_library ON collection_sources(library_id);

CREATE TABLE collection_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  library_id uuid NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  collection_source_id uuid NOT NULL REFERENCES collection_sources(id) ON DELETE CASCADE,
  provider_item_id varchar(255),
  discogs_release_id integer,
  release_id uuid REFERENCES releases(id) ON DELETE SET NULL,
  release_group_id uuid REFERENCES release_groups(id) ON DELETE SET NULL,
  folder_name varchar(255),
  formats jsonb DEFAULT '[]',
  media_condition varchar(50),
  sleeve_condition varchar(50),
  rating integer,
  notes text,
  date_added timestamptz,
  mapping_state varchar(50) DEFAULT 'unmapped' CHECK (mapping_state IN ('auto', 'manual', 'unmapped')),
  removed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_collection_items_library ON collection_items(library_id);

CREATE TABLE wantlist_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  library_id uuid NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  collection_source_id uuid NOT NULL REFERENCES collection_sources(id) ON DELETE CASCADE,
  discogs_release_id integer,
  release_group_id uuid REFERENCES release_groups(id) ON DELETE SET NULL,
  date_added timestamptz,
  removed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_wantlist_items_library ON wantlist_items(library_id);

CREATE TABLE user_reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  library_id uuid NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  release_group_id uuid NOT NULL REFERENCES release_groups(id) ON DELETE CASCADE,
  rating numeric(2,1),
  body_md text,
  favorite_track_ids uuid[] DEFAULT '{}',
  tags text[] DEFAULT '{}',
  visibility varchar(20),
  current_revision integer DEFAULT 1,
  published_to jsonb DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_user_reviews_library ON user_reviews(library_id);
CREATE INDEX idx_user_reviews_release_group ON user_reviews(release_group_id);

CREATE TABLE user_review_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_review_id uuid NOT NULL REFERENCES user_reviews(id) ON DELETE CASCADE,
  revision integer NOT NULL,
  rating numeric(2,1),
  body_md text,
  edited_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_user_review_revisions_review ON user_review_revisions(user_review_id);

CREATE TABLE clippings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  library_id uuid NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  release_group_id uuid NOT NULL REFERENCES release_groups(id) ON DELETE CASCADE,
  url varchar(2048),
  source_label varchar(255),
  score_raw numeric(5,2),
  note text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_clippings_library ON clippings(library_id);

CREATE TABLE listens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  library_id uuid NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  release_group_id uuid NOT NULL REFERENCES release_groups(id) ON DELETE CASCADE,
  release_id uuid REFERENCES releases(id) ON DELETE SET NULL,
  listened_at timestamptz NOT NULL,
  format varchar(50),
  note text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_listens_library ON listens(library_id);
CREATE INDEX idx_listens_release_group ON listens(release_group_id);

CREATE TABLE saved_views (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  library_id uuid NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  name varchar(255) NOT NULL,
  query jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_saved_views_library ON saved_views(library_id);

CREATE TABLE player_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  library_id uuid NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  name varchar(255) NOT NULL,
  url_template varchar(2048) NOT NULL,
  enabled boolean DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_player_links_library ON player_links(library_id);

CREATE TABLE credentials (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  library_id uuid NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  provider varchar(50) NOT NULL,
  ciphertext bytea NOT NULL,
  nonce bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_credentials_library ON credentials(library_id);
CREATE UNIQUE INDEX idx_credentials_provider ON credentials(library_id, provider);

CREATE TABLE settings (
  library_id uuid NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  key varchar(100) NOT NULL,
  value jsonb,
  PRIMARY KEY (library_id, key)
);

CREATE TABLE audit_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  library_id uuid NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  actor_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  action varchar(50) NOT NULL,
  subject_type varchar(50),
  subject_id uuid,
  payload jsonb,
  at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_audit_log_library ON audit_log(library_id);
CREATE INDEX idx_audit_log_at ON audit_log(at DESC);

-- Search support
CREATE TABLE search_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  library_id uuid NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  entity_type varchar(50) NOT NULL,
  entity_id uuid NOT NULL,
  display_name varchar(255),
  tsvector_content tsvector,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_search_documents_library ON search_documents(library_id);
CREATE INDEX idx_search_documents_tsvector ON search_documents USING gin(tsvector_content);
