-- Similar artists: the similar-artists module. For an artist with a
-- MusicBrainz id, the artists ListenBrainz finds similar (open MetaBrainz
-- data, asked by the artist's MBID alone) and, when the install has a
-- Last.fm API key, Last.fm's artist.getSimilar (also by MBID), merged by
-- MBID or name. Found by the worker's similarArtists.fetch job when the
-- artist page is opened and the list is missing or a week old.
--
-- Only ids, names, a short comment, scores and sources are stored: no
-- images, nothing copied about the person or the library.
--
-- The module's own tables (Module Composition Principle rule 1): keyed to
-- artists with ON DELETE CASCADE; no core table references them. Turning
-- the module off stops the job and hides the section; "Delete its data"
-- (api › routes/similarArtists.ts) empties these two tables and nothing else.

-- One artist's similar artists, best first (position 0 is the most similar).
-- similar_mbid is null for a Last.fm answer without an MBID.
create table if not exists similar_artists (
  artist_id uuid not null references artists(id) on delete cascade,
  position integer not null check (position >= 0),
  similar_mbid uuid,
  name text not null check (length(name) between 1 and 500),
  comment text,
  -- blended, 0..1
  score real not null check (score >= 0 and score <= 1),
  sources text[] not null check (cardinality(sources) > 0 and sources <@ array['listenbrainz', 'lastfm']),
  primary key (artist_id, position)
);
create index if not exists idx_similar_artists_mbid on similar_artists (similar_mbid);

-- When each artist's list was fetched, from which sources, how many it
-- found. A list a week old is fetched again; error: the last failure.
create table if not exists similar_artist_checks (
  artist_id uuid primary key references artists(id) on delete cascade,
  fetched_at timestamptz not null default now(),
  sources text[] not null default '{}',
  found integer not null default 0,
  error text
);
create index if not exists idx_similar_artist_checks_fetched on similar_artist_checks (fetched_at);
