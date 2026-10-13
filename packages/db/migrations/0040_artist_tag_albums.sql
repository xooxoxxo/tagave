-- Artist page and artists list (0.7.6): albums known only by their tags.
--
-- An album with no release group (or one whose release group has no artist
-- credits) belongs to the artist whose name its album-artist tag carries,
-- compared as the artists list shows names (liner_display_artist, 0028) and
-- without regard to case. Until now the artist page only listed identified
-- albums, so an artist whose albums were matched by tags alone showed none.
--
-- These two indexes answer that lookup from both sides without a scan:
-- one artist's tag-matched albums in a library (the artist page), and the
-- artists row for a tag name (the artists list, coversFor).
create index if not exists idx_local_albums_display_artist_lower
  on local_albums (library_id, lower(liner_display_artist(artist_guess)));
create index if not exists idx_artists_name_lower
  on artists (lower(name));
