-- XO-363: one narrow row per album with the dimensions the filter rail counts,
-- rebuilt by the file worker (facets.refresh) so unfiltered and single-dimension
-- facet requests aggregate ~28k narrow rows instead of joining six tables per
-- request. facet_state tracks freshness; a handler that changes many albums at
-- once (bulk actions) stamps dirty_at so the API serves live counts until the
-- next rebuild lands.
create table if not exists album_facets (
  album_id uuid primary key references local_albums(id) on delete cascade,
  library_id uuid not null references libraries(id) on delete cascade,
  release_group_id uuid,
  state varchar(20) not null,
  format varchar(10) not null,
  containers text[] not null default '{}',
  decade integer,
  labels text[] not null default '{}',
  genres text[] not null default '{}',
  gap_kinds text[] not null default '{}',
  owned boolean not null default false,
  decided text[] not null default '{}'
);
create index if not exists idx_album_facets_library on album_facets (library_id);
create index if not exists idx_album_facets_genres on album_facets using gin (genres);
create index if not exists idx_album_facets_labels on album_facets using gin (labels);
create index if not exists idx_album_facets_gap_kinds on album_facets using gin (gap_kinds);

create table if not exists facet_state (
  library_id uuid primary key references libraries(id) on delete cascade,
  computed_at timestamptz,
  dirty_at timestamptz,
  album_count integer not null default 0,
  duration_ms integer
);
