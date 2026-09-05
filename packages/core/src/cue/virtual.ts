/**
 * Virtual track extraction from CUE files
 * spec XO-314
 */

import type { CueFile, CueSheet } from './parse.js';

export interface VirtualTrack {
  number: number;
  title: string;
  performer?: string;
  startMs: number;
  durationMs: number | null;
  isrc?: string;
}

/**
 * Extract virtual tracks from a CUE file entry.
 * Returns null when:
 * - < 2 audio tracks
 * - start times not strictly increasing
 * - audioDurationMs known and the last start ≥ audioDurationMs (cue does not fit the file)
 *
 * Last track duration = audioDurationMs − last start (null when duration unknown).
 * Title fallback: `Track NN`; performer fallback: sheet.performer.
 * spec XO-314 design
 */
export function virtualTracksForFile(
  file: CueFile,
  sheet: CueSheet,
  audioDurationMs: number | null
): VirtualTrack[] | null {
  // Need at least 2 audio tracks
  if (file.tracks.length < 2) {
    return null;
  }

  const tracks: VirtualTrack[] = [];

  for (let i = 0; i < file.tracks.length; i++) {
    const track = file.tracks[i];
    if (!track) continue;

    // Extract start from INDEX 01, else INDEX 00, else skip
    let startMs = track.indexes[1];
    if (startMs === undefined) {
      startMs = track.indexes[0];
    }
    if (startMs === undefined) {
      // No index, skip this track
      return null;
    }

    // Check strictly increasing starts
    const lastTrackInResult = tracks[tracks.length - 1];
    if (lastTrackInResult && startMs <= lastTrackInResult.startMs) {
      return null;
    }

    // Calculate duration
    let durationMs: number | null = null;
    if (i < file.tracks.length - 1) {
      // Duration = next track's start − this track's start
      const nextTrack = file.tracks[i + 1];
      if (nextTrack) {
        const nextStart = nextTrack.indexes[1] ?? nextTrack.indexes[0];
        if (nextStart !== undefined) {
          durationMs = nextStart - startMs;
        }
      }
    } else if (audioDurationMs !== null) {
      // Last track: duration = file duration − start
      durationMs = audioDurationMs - startMs;
    }

    // Validate: if audio duration is known, the last track's start must be < duration
    if (i === file.tracks.length - 1 && audioDurationMs !== null && startMs >= audioDurationMs) {
      return null;
    }

    const title = track.title || `Track ${String(track.number).padStart(2, '0')}`;
    const vt: VirtualTrack = {
      number: track.number,
      title,
      startMs,
      durationMs,
    };
    if (track.performer) {
      vt.performer = track.performer;
    } else if (sheet.performer) {
      vt.performer = sheet.performer;
    }
    if (track.isrc) {
      vt.isrc = track.isrc;
    }

    tracks.push(vt);
  }

  return tracks.length > 0 ? tracks : null;
}
