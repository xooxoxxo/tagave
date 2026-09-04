-- XO-302: Discogs-only releases, many-to-one bridges, shared DB pacer.
-- Support Discogs-only releases with synthetic release groups, add bridge tracking,
-- enable rate-limit pacing via DB, and establish many-to-one external ID mapping.

-- release_groups: allow mbid NULL for synthetic Discogs-only RGs;
-- add discogs_release_id for single-release synthetics;
-- enforce at least one identity source.
ALTER TABLE release_groups
  ALTER COLUMN mbid DROP NOT NULL;

ALTER TABLE release_groups
  ADD COLUMN discogs_release_id integer UNIQUE;

ALTER TABLE release_groups
  ADD CONSTRAINT release_groups_identity CHECK (
    mbid IS NOT NULL OR discogs_master_id IS NOT NULL OR discogs_release_id IS NOT NULL
  );

-- releases: track bridge attempt (enrich.sweep filters on this).
ALTER TABLE releases
  ADD COLUMN bridge_attempted_at timestamptz;

-- provider_state: add per-provider slot pacing; seed rows for known providers.
ALTER TABLE provider_state
  ADD COLUMN next_slot_at timestamptz;

INSERT INTO provider_state (provider, window_started_at, requests_used)
VALUES
  ('musicbrainz', now(), 0),
  ('discogs', now(), 0),
  ('wikidata', now(), 0),
  ('caa', now(), 0)
ON CONFLICT DO NOTHING;

-- external_ids: many-to-one is real (several MB/Discogs releases can bridge to one peer).
-- Migrate PK from (provider, external_id, entity_type) to include entity_id.
ALTER TABLE external_ids
  DROP CONSTRAINT external_ids_pkey;

ALTER TABLE external_ids
  ADD PRIMARY KEY (provider, external_id, entity_type, entity_id);

-- Add index for reverse lookups by entity.
CREATE INDEX idx_external_ids_entity_provider
  ON external_ids(entity_type, entity_id, provider);

-- entity_tags: enforce unique tag per entity/kind/source (case-insensitive).
CREATE UNIQUE INDEX uq_entity_tags_natural
  ON entity_tags (entity_type, entity_id, kind, source, lower(tag));

-- image_sources: one 'front' per entity from each provider.
CREATE UNIQUE INDEX uq_image_sources_natural
  ON image_sources (entity_type, entity_id, provider, kind);

-- Indexes for Discogs bridging queries.
CREATE INDEX IF NOT EXISTS idx_releases_discogs_release_id
  ON releases(discogs_release_id);

CREATE INDEX IF NOT EXISTS idx_release_groups_discogs_master_id
  ON release_groups(discogs_master_id);
