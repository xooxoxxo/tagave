-- DJ: the dj module (vault "tagave - DJ Module"), off until the owner turns
-- it on. What the player's crossfades and the two-deck view need of a track,
-- measured once by the worker's dj.analyze job and kept here: the tempo, the
-- beat grid's first beat, where the sound starts and ends (−45 dBFS RMS over
-- 20 ms windows) and ~900 waveform peaks. Everything is computed on the
-- worker from the file itself; nothing leaves tagave.
--
-- audio_hash keys the work to the audio, not the file: a SHA-256 of the
-- file's audio packets (ffmpeg's hash muxer over a stream copy, so tags,
-- cover art and padding are not part of it), and for a track of a cue image
-- that hash with the track's window. A re-tag changes the file's size and
-- mtime, so the job hashes it again (a read, no decode), finds the same
-- audio and keeps the analysis; changed audio is analysed again. Another
-- file with the same audio (a copy on a compilation) takes this row's
-- analysis without decoding.
--
-- The module's own table (Module Composition Principle rule 1): keyed to
-- local_tracks with ON DELETE CASCADE, no core table references it. Turning
-- the module off stops the job and the routes; "Delete its data"
-- (api › routes/dj.ts) empties this table and nothing else.
create table if not exists dj_track_analysis (
  local_track_id uuid primary key references local_tracks(id) on delete cascade,
  -- null only when the file could not be read at all (error says why)
  audio_hash varchar(64),
  -- the file as it was analysed: a different size or mtime is checked again
  file_size_bytes bigint,
  file_mtime bigint,
  -- decoded length (the track's own duration_ms is what the API serves)
  duration_ms integer check (duration_ms is null or duration_ms >= 0),
  -- null: no steady pulse (ambient, speech) or too little sound
  bpm numeric(7, 3) check (bpm is null or (bpm > 0 and bpm < 1000)),
  bpm_confidence real check (bpm_confidence is null or (bpm_confidence >= 0 and bpm_confidence <= 1)),
  -- the beat grid: first_beat_ms + k * 60000 / bpm
  first_beat_ms integer check (first_beat_ms is null or first_beat_ms >= 0),
  -- null: silent throughout
  trim_start_ms integer check (trim_start_ms is null or trim_start_ms >= 0),
  trim_end_ms integer,
  -- one byte per bin (0-255 = 0 to full scale), ~900 bins over the whole track
  peaks bytea check (peaks is null or length(peaks) <= 4096),
  analyzed_at timestamptz not null default now(),
  -- the last failure (ffmpeg's words); the sweep tries again after a week
  error text,
  check (trim_end_ms is null or trim_start_ms is null or trim_end_ms >= trim_start_ms)
);
create index if not exists idx_dj_track_analysis_hash on dj_track_analysis (audio_hash) where audio_hash is not null and error is null;
