-- Play on your service (vault "tagave - Get Missing Albums", part A): each
-- person's primary streaming platform, one of their Listen elsewhere
-- platforms. A missing album and a Missing playlist row get a "Play on
-- <platform>" key for it; the other platforms stay in the Listen control.
-- Null: none chosen (no key). Removing the platform from the person's list
-- clears it (api › routes/listenLinks.ts). Additive: older versions ignore it.
alter table listen_prefs add column if not exists primary_platform text
  check (primary_platform in ('qobuz', 'spotify', 'apple', 'youtube-music', 'tidal', 'bandcamp', 'amazon', 'deezer'));
