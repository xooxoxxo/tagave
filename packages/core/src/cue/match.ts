/**
 * CUE file matching logic
 * Matches CUE files to audio files and selects among candidates
 * spec XO-314
 */

import type { CueFile, CueSheet } from './parse.js';

export interface MatchResult {
  index: number;
  matchKind: 'exact' | 'stem';
}

/**
 * Match a CUE file name to audio file basenames.
 * Returns {index, matchKind} of the matching audio file, or null.
 *
 * Matching order:
 * 1. exact (NFC, casefold)
 * 2. same stem (strip one extension from both, then compare casefold)
 * 3. null
 *
 * spec XO-314 design
 */
export function matchCueFileToAudio(fileName: string, audioBasenames: string[]): MatchResult | null {
  // Normalize for comparison: NFC + casefold
  const normalizedCueName = fileName.normalize('NFC').toLowerCase();

  // Try exact match
  for (let i = 0; i < audioBasenames.length; i++) {
    const audio = audioBasenames[i];
    if (audio) {
      const normalized = audio.normalize('NFC').toLowerCase();
      if (normalized === normalizedCueName) {
        return { index: i, matchKind: 'exact' };
      }
    }
  }

  // Try stem match: strip one extension from both
  const cueStem = stripExtension(normalizedCueName);

  for (let i = 0; i < audioBasenames.length; i++) {
    const audio = audioBasenames[i];
    if (audio) {
      const audioStem = stripExtension(audio.normalize('NFC').toLowerCase());
      if (audioStem === cueStem) {
        return { index: i, matchKind: 'stem' };
      }
    }
  }

  return null;
}

/**
 * Strip one extension from a filename.
 * E.g., "file.wav" → "file", "file.tar.gz" → "file.tar"
 */
function stripExtension(filename: string): string {
  const lastDotIndex = filename.lastIndexOf('.');
  if (lastDotIndex <= 0) return filename;
  return filename.substring(0, lastDotIndex);
}

export interface CueCandidate {
  cuePath: string;
  file: CueFile;
  sheet: CueSheet;
  matchKind: 'exact' | 'stem' | 'single';
}

/**
 * Choose the best CUE for an audio file when multiple candidates exist.
 * Preference order:
 * 1. exact > stem > single (matchKind)
 * 2. cue whose own name shares the audio stem
 * 3. most tracks
 * 4. lexical path
 *
 * spec XO-314 design
 */
export function chooseCueForAudio(audioFileName: string, candidates: CueCandidate[]): CueCandidate {
  if (candidates.length === 0) {
    throw new Error('chooseCueForAudio requires at least one candidate');
  }

  if (candidates.length === 1) {
    const first = candidates[0];
    if (!first) {
      throw new Error('chooseCueForAudio received empty array');
    }
    return first;
  }

  const audioStem = stripExtension(audioFileName.toLowerCase());

  // Sort by priority: matchKind, shared stem, track count, path
  const sorted = [...candidates].sort((a, b) => {
    // 1. Prefer matchKind order: exact > stem > single
    const matchKindOrder: Record<string, number> = { exact: 0, stem: 1, single: 2 };
    const aKindRank = matchKindOrder[a.matchKind] ?? 999;
    const bKindRank = matchKindOrder[b.matchKind] ?? 999;
    const kindDiff = aKindRank - bKindRank;
    if (kindDiff !== 0) return kindDiff;

    // 2. Prefer cue whose own name shares the audio stem
    const cueStemA = stripExtension(a.cuePath.toLowerCase());
    const cueStemB = stripExtension(b.cuePath.toLowerCase());
    const aStemsMatch = cueStemA === audioStem ? 0 : 1;
    const bStemsMatch = cueStemB === audioStem ? 0 : 1;
    const stemMatchDiff = aStemsMatch - bStemsMatch;
    if (stemMatchDiff !== 0) return stemMatchDiff;

    // 3. Prefer more tracks
    const trackDiff = (b.file?.tracks?.length ?? 0) - (a.file?.tracks?.length ?? 0);
    if (trackDiff !== 0) return trackDiff;

    // 4. Lexical path
    return a.cuePath.localeCompare(b.cuePath);
  });

  const chosen = sorted[0];
  if (!chosen) {
    throw new Error('chooseCueForAudio: no candidate selected');
  }
  return chosen;
}
