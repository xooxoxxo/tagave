-- XO-372 (IDN-5), cue images: a whole-image fingerprint never matches — AcoustID
-- indexes recordings, so each virtual track gets its own fingerprint (ffmpeg slice
-- at cue_start_ms → fpcalc). Stored on the track, not the file.
alter table local_tracks
  add column if not exists fingerprint text,
  add column if not exists fingerprint_duration integer,
  add column if not exists fingerprinted_at timestamptz,
  add column if not exists fingerprint_error text;
comment on column local_tracks.fingerprint is 'Chromaprint of this virtual track (origin = cue only; file-backed tracks use audio_files.fingerprint)';
create index if not exists idx_local_tracks_cue_unfingerprinted
  on local_tracks (local_album_id) where origin = 'cue' and fingerprint is null and fingerprinted_at is null;
