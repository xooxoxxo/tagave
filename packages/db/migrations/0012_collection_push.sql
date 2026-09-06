-- COL-3: two-way collection sync (push to Discogs)
alter table collection_items
  add column if not exists push_state varchar(20) default 'synced',
  add column if not exists push_error text,
  add column if not exists local_album_id uuid references local_albums(id) on delete set null;

alter table collection_sources
  add column if not exists fields jsonb default '[]';

-- Protect items with pending/failed push_state during collection.sync
create index if not exists idx_collection_items_push_state on collection_items (library_id, push_state);
