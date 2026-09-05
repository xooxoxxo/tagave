import type { CueSheet, CueFile, VirtualTrack, CueCandidate } from '@liner/core';
import { virtualTracksForFile, matchCueFileToAudio, chooseCueForAudio } from '@liner/core';
import { relDirname, relBasename } from './helpers.js';

interface FileRow {
  id: string;
  relPath: string;
  durationMs: number | null;
}

interface CueInfo {
  relPath: string;
  sheet: CueSheet;
}

interface ExpandedFile {
  tracks: VirtualTrack[];
  cueRelPath: string;
  sheet: CueSheet;
}

/**
 * Expand audio files with CUE sheet virtual tracks.
 * Groups files and cues by directory; for each cue FILE with ≥ 2 audio tracks,
 * matches it to an audio file and validates with virtualTracksForFile.
 * chooseCueForAudio picks one when multiple candidates exist for a file.
 *
 * Returns a map from audioFileId to expanded tracks + cue metadata.
 */
export function expandFilesWithCues(
  files: FileRow[],
  cues: CueInfo[],
): Map<string, ExpandedFile> {
  const result = new Map<string, ExpandedFile>();

  // Group files by directory
  const filesByDir = new Map<string, FileRow[]>();
  for (const f of files) {
    const dir = relDirname(f.relPath);
    const arr = filesByDir.get(dir) ?? [];
    arr.push(f);
    filesByDir.set(dir, arr);
  }

  // Group cues by directory
  const cuesByDir = new Map<string, CueInfo[]>();
  for (const c of cues) {
    const dir = relDirname(c.relPath);
    const arr = cuesByDir.get(dir) ?? [];
    arr.push(c);
    cuesByDir.set(dir, arr);
  }

  // Process each directory's cues
  for (const [dir, dirCues] of cuesByDir) {
    const dirFiles = filesByDir.get(dir) ?? [];
    if (dirFiles.length === 0) continue;

    const audioBasenames = dirFiles.map((f) => relBasename(f.relPath));

    // Collect candidates per audio file: array of (cue, file, matchKind, virtualTracks)
    interface Candidate {
      cueRelPath: string;
      file: CueFile;
      sheet: CueSheet;
      matchKind: 'exact' | 'stem' | 'single';
      audioFileId: string;
      virtualTracks: VirtualTrack[];
    }
    const candidatesByFileId = new Map<string, Candidate[]>();

    for (const cueInfo of dirCues) {
      for (const file of cueInfo.sheet.files) {
        // Skip files with < 2 audio tracks (per-track cues)
        const audioTracks = file.tracks.filter((t) => !t.flags?.includes('data'));
        if (audioTracks.length < 2) continue;

        // Try to match the FILE name to an audio file
        let matchedFileId: string | null = null;
        let matchKind: 'exact' | 'stem' | 'single' = 'exact';

        const matchResult = matchCueFileToAudio(file.path, audioBasenames);
        if (matchResult !== null) {
          matchedFileId = dirFiles[matchResult.index]!.id;
          // matchCueFileToAudio returns exact or stem match kind
          matchKind = matchResult.matchKind;
        } else if (
          // Single-file fallback: dir has exactly ONE audio file and cue has exactly ONE FILE entry
          dirFiles.length === 1 &&
          cueInfo.sheet.files.length === 1
        ) {
          matchedFileId = dirFiles[0]!.id;
          matchKind = 'single';
        }

        if (!matchedFileId) continue;

        // Validate with virtualTracksForFile
        const audioFile = dirFiles.find((f) => f.id === matchedFileId)!;
        const virtualTracks = virtualTracksForFile(file, cueInfo.sheet, audioFile.durationMs);
        if (virtualTracks === null) continue; // cue doesn't fit the file

        // Collect this candidate
        const cands = candidatesByFileId.get(matchedFileId) ?? [];
        cands.push({
          cueRelPath: cueInfo.relPath,
          file,
          sheet: cueInfo.sheet,
          matchKind,
          audioFileId: matchedFileId,
          virtualTracks,
        });
        candidatesByFileId.set(matchedFileId, cands);
      }
    }

    // For each audio file with candidates, use chooseCueForAudio to pick one
    for (const [fileId, candidates] of candidatesByFileId) {
      if (candidates.length === 0) continue;

      // Get the audio file's basename for the chooseCueForAudio tiebreaker
      const audioFile = dirFiles.find((f) => f.id === fileId);
      if (!audioFile) continue;
      const audioFileName = relBasename(audioFile.relPath);

      const choice = chooseCueForAudio(
        audioFileName,
        candidates.map((c) => ({
          cuePath: c.cueRelPath,
          file: c.file,
          sheet: c.sheet,
          matchKind: c.matchKind,
        })),
      );

      // Find the chosen candidate by matching the returned cuePath
      const chosen = candidates.find((c) => c.cueRelPath === choice.cuePath);
      if (chosen) {
        result.set(fileId, {
          tracks: chosen.virtualTracks,
          cueRelPath: chosen.cueRelPath,
          sheet: chosen.sheet,
        });
      }
    }
  }

  return result;
}
