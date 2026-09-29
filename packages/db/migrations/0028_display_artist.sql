-- Artist names as lists show them (compilations, numbered album artists).
--
-- A ripper that writes the track number into ALBUMARTIST ("02. Stephane
-- Pompougnac") files every track of one compilation under its own artist,
-- and "Various" / "VA" / "V.A." split the compilations shelf into several
-- rows. liner_display_artist folds both for display and grouping; it never
-- changes a stored guess. It mirrors displayArtistName in
-- packages/shared/src/artistNames.ts: keep the two in step.
create or replace function liner_display_artist(name text) returns text
language sql immutable parallel safe as $$
  select case
    when s.stripped is null or s.stripped = '' then null
    when lower(s.stripped) in (
      'various', 'various artists', 'various artist', 'va', 'v.a.', 'v.a', 'v/a',
      'varios', 'varios artistas', 'divers', 'artistes divers'
    ) then 'Various Artists'
    else s.stripped
  end
  from (select btrim(regexp_replace(btrim(name), '^[0-9]{1,3}\.\s+(?=\S)', '')) as stripped) s
$$;

-- The album grid's artist filter and the artists list group on it.
create index if not exists idx_local_albums_display_artist
  on local_albums (library_id, liner_display_artist(artist_guess));
