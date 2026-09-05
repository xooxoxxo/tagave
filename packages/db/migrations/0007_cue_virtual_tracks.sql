-- Add cue-sheet virtual track columns to local_tracks
-- origin: 'file' for single-file tracks, 'cue' for virtual tracks from cue sheets
-- cue_start_ms: track start offset from the cue index (ms)
-- cue_rel_path: NFC path of the cue file used; no FK to sidecar_files because
--   sidecar inventory is replaced on every scan (sidecar ids are unstable)

alter table local_tracks
  add column origin varchar(10) not null default 'file' check (origin in ('file', 'cue')),
  add column cue_start_ms integer,
  add column cue_rel_path varchar(2048);
