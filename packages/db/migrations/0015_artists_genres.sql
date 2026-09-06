-- XO-310: canonical artists, artist credits per release group, enrichment bookkeeping.
create table if not exists release_group_artists (
  release_group_id uuid not null references release_groups(id) on delete cascade,
  artist_id        uuid not null references artists(id) on delete cascade,
  position         smallint not null,            -- 0-based credit order
  credited_name    varchar(255),                 -- name as credited ("The Beatles" vs artist "Beatles, The")
  join_phrase      varchar(50),                  -- " & ", " feat. " …
  primary key (release_group_id, position)
);
create index if not exists idx_rga_artist on release_group_artists (artist_id);
alter table artists add column if not exists aliases text[] not null default '{}';
alter table artists add column if not exists enriched_at timestamptz;      -- artists.enrich ran (weekly TTL)
alter table artists add column if not exists enrich_error text;            -- last enrich failure, cleared on success
alter table release_groups add column if not exists artists_resolved_at timestamptz;  -- artists.resolve ran (null = pending)
create index if not exists idx_release_groups_unresolved on release_groups (id) where mbid is not null and artists_resolved_at is null;
