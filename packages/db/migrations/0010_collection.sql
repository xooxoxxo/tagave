-- Add collection syncing columns (spec COL-1, GAP-3)
alter table collection_sources
  add column folders jsonb default '[]',
  add column last_error text,
  add column item_count integer;

-- Add collection item mapping and metadata columns (spec COL-1)
alter table collection_items
  add column folder_id integer,
  add column discogs_master_id integer,
  add column basic_info jsonb,
  add column mapping_source varchar(30),
  add column mapped_at timestamptz,
  add column last_seen_at timestamptz;

-- Natural key for collection items (spec COL-1)
alter table collection_items
  add constraint collection_items_natural_key unique (collection_source_id, provider_item_id);

-- Performance indices for collection queries (spec GAP-3)
create index idx_collection_items_mapping_state on collection_items (library_id, mapping_state);
create index idx_collection_items_release_group on collection_items (library_id, release_group_id);
