/**
 * TAG-6 lint rules for album-level tag quality.
 *
 * Evaluates an album's tracks against deterministic rules:
 * - Inconsistent album/albumartist/date/totaltracks across files
 * - Missing MusicBrainz release/recording IDs
 * - Missing or duplicate track numbers
 * - Title case anomalies
 * - Empty required fields (title, artist, album, tracknumber)
 * - Disc numbering gaps
 * - No embedded art
 *
 * Each rule is toggleable; only enabled rules produce flags.
 * Spec: §9.5 TAG-6.
 */

import type { CanonicalField } from '@liner/shared';

/**
 * A lint flag indicating a quality issue in an album.
 */
export interface LintFlag {
  rule: string;
  details?: Record<string, unknown>;
}

/**
 * Configuration for which lint rules to apply (all true by default).
 */
export interface LintToggles {
  inconsistentAlbumFields?: boolean;
  missingMbIds?: boolean;
  trackNumberIssues?: boolean;
  titleCaseAnomalies?: boolean;
  emptyRequiredFields?: boolean;
  discNumberGaps?: boolean;
  noEmbeddedArt?: boolean;
}

/**
 * A track's raw tag data as read from a file (from audio_files.tags_raw JSONB).
 */
export interface RawTrackTags extends Record<CanonicalField | string, string | string[] | undefined> {
  // Expect at least these canonical fields, but allow others
  tracknumber?: string | string[];
  totaltracks?: string | string[];
  discnumber?: string | string[];
  totaldiscs?: string | string[];
  title?: string | string[];
  artist?: string | string[];
  album?: string | string[];
  albumartist?: string | string[];
  date?: string | string[];
  musicbrainz_recordingid?: string | string[];
  musicbrainz_releasetrackid?: string | string[];
  musicbrainz_albumid?: string | string[];
}

/**
 * Evaluate an album's tracks against lint rules.
 *
 * @param tracks Raw track tags, in disc/track order; required to have at least one
 * @param opts Rule toggles (default all true); only enabled rules produce flags
 * @param hasEmbeddedArt Whether any file in the album has embedded art (optional)
 * @returns Array of LintFlag objects; deterministic and ordered by rule name
 */
export function lintAlbum(
  tracks: RawTrackTags[],
  opts: LintToggles = {},
  hasEmbeddedArt?: boolean
): LintFlag[] {
  const flags: LintFlag[] = [];

  if (tracks.length === 0) return flags;

  const toggles: Required<LintToggles> = {
    inconsistentAlbumFields: opts.inconsistentAlbumFields ?? true,
    missingMbIds: opts.missingMbIds ?? true,
    trackNumberIssues: opts.trackNumberIssues ?? true,
    titleCaseAnomalies: opts.titleCaseAnomalies ?? true,
    emptyRequiredFields: opts.emptyRequiredFields ?? true,
    discNumberGaps: opts.discNumberGaps ?? true,
    noEmbeddedArt: opts.noEmbeddedArt ?? true,
  };

  // --- Rule 1: inconsistentAlbumFields ---
  if (toggles.inconsistentAlbumFields) {
    const inconsistencies = checkInconsistentAlbumFields(tracks);
    if (inconsistencies.length > 0) {
      flags.push({
        rule: 'inconsistentAlbumFields',
        details: { fields: inconsistencies },
      });
    }
  }

  // --- Rule 2: missingMbIds ---
  if (toggles.missingMbIds) {
    const missing = checkMissingMbIds(tracks);
    if (missing.length > 0) {
      flags.push({
        rule: 'missingMbIds',
        details: { missing },
      });
    }
  }

  // --- Rule 3: trackNumberIssues ---
  if (toggles.trackNumberIssues) {
    const issues = checkTrackNumberIssues(tracks);
    if (issues.length > 0) {
      flags.push({
        rule: 'trackNumberIssues',
        details: { issues },
      });
    }
  }

  // --- Rule 4: titleCaseAnomalies ---
  if (toggles.titleCaseAnomalies) {
    const anomalies = checkTitleCaseAnomalies(tracks);
    if (anomalies.length > 0) {
      flags.push({
        rule: 'titleCaseAnomalies',
        details: { tracks: anomalies },
      });
    }
  }

  // --- Rule 5: emptyRequiredFields ---
  if (toggles.emptyRequiredFields) {
    const empty = checkEmptyRequiredFields(tracks);
    if (empty.length > 0) {
      flags.push({
        rule: 'emptyRequiredFields',
        details: { tracks: empty },
      });
    }
  }

  // --- Rule 6: discNumberGaps ---
  if (toggles.discNumberGaps) {
    const gaps = checkDiscNumberGaps(tracks);
    if (gaps) {
      flags.push({
        rule: 'discNumberGaps',
        details: { gap: gaps },
      });
    }
  }

  // --- Rule 7: noEmbeddedArt ---
  if (toggles.noEmbeddedArt && hasEmbeddedArt === false) {
    flags.push({
      rule: 'noEmbeddedArt',
    });
  }

  // Sort by rule name for determinism
  flags.sort((a, b) => a.rule.localeCompare(b.rule));

  return flags;
}

/**
 * Check for inconsistent album-level fields across the album's tracks.
 * Returns the names of fields that are inconsistent.
 */
function checkInconsistentAlbumFields(tracks: RawTrackTags[]): string[] {
  const fields = ['album', 'albumartist', 'date', 'totaltracks'] as const;
  const inconsistent: string[] = [];

  for (const field of fields) {
    const values = new Set<string>();
    for (const track of tracks) {
      const val = track[field as keyof RawTrackTags];
      if (val !== undefined && val !== null && val !== '') {
        const strVal = Array.isArray(val) ? (val[0] ?? '') : String(val);
        if (strVal) {
          values.add(strVal);
        }
      }
    }
    // If there are 2+ different values, it's inconsistent
    if (values.size > 1) {
      inconsistent.push(field);
    }
  }

  return inconsistent.sort();
}

/**
 * Check for missing MusicBrainz IDs (recording or release-track).
 * Returns track indices with missing IDs.
 */
function checkMissingMbIds(tracks: RawTrackTags[]): number[] {
  const missing: number[] = [];

  for (let i = 0; i < tracks.length; i++) {
    const track = tracks[i]!;
    const hasRecordingId = isValuePresent(track.musicbrainz_recordingid);
    const hasReleaseTrackId = isValuePresent(track.musicbrainz_releasetrackid);

    if (!hasRecordingId && !hasReleaseTrackId) {
      missing.push(i);
    }
  }

  return missing;
}

/**
 * Check for missing or duplicate track numbers.
 * Returns an array of issue descriptions (e.g., "missing tracknumber at index 2", "duplicate tracknumber 3").
 */
function checkTrackNumberIssues(tracks: RawTrackTags[]): string[] {
  const issues: string[] = [];
  const seenNumbers = new Map<number, number[]>(); // track number => indices

  for (let i = 0; i < tracks.length; i++) {
    const track = tracks[i];
    if (!track) continue;

    const tn = track.tracknumber;

    if (!isValuePresent(tn)) {
      issues.push(`missing tracknumber at track index ${i}`);
    } else {
      const tnStr = Array.isArray(tn) ? (tn[0] ?? '') : String(tn);
      if (tnStr) {
        // Parse the track number (handle formats like "1" or "1/12")
        const parts = tnStr.split('/');
        const parsed = parseInt(parts[0] ?? '0', 10);
        if (!isNaN(parsed) && parsed > 0) {
          if (!seenNumbers.has(parsed)) {
            seenNumbers.set(parsed, []);
          }
          seenNumbers.get(parsed)!.push(i);
        }
      }
    }
  }

  // Check for duplicates
  for (const [num, indices] of seenNumbers) {
    if (indices.length > 1) {
      issues.push(`duplicate tracknumber ${num} at indices ${indices.join(', ')}`);
    }
  }

  return issues.sort();
}

/**
 * Check for title case anomalies in track titles.
 * Returns track indices with anomalies (e.g., all lowercase, ALL CAPS).
 */
function checkTitleCaseAnomalies(tracks: RawTrackTags[]): number[] {
  const anomalies: number[] = [];

  for (let i = 0; i < tracks.length; i++) {
    const track = tracks[i];
    if (!track) continue;

    const title = track.title;

    if (isValuePresent(title)) {
      const titleStr = Array.isArray(title) ? (title[0] ?? '') : String(title);
      const trimmed = titleStr.trim();

      if (trimmed.length === 0) continue;

      // Check for all lowercase (anomaly) or ALL CAPS with no lowercase
      const hasLower = /[a-z]/.test(trimmed);
      const hasUpper = /[A-Z]/.test(trimmed);

      // All lowercase is an anomaly
      if (!hasUpper) {
        anomalies.push(i);
      }
      // All uppercase is an anomaly
      else if (!hasLower && /[A-Z]/.test(trimmed)) {
        anomalies.push(i);
      }
    }
  }

  return anomalies;
}

/**
 * Check for empty required fields (title, artist, album, tracknumber).
 * Returns track indices with missing required fields.
 */
function checkEmptyRequiredFields(tracks: RawTrackTags[]): number[] {
  const issues: number[] = [];
  const required = ['title', 'artist', 'album', 'tracknumber'] as const;

  for (let i = 0; i < tracks.length; i++) {
    const track = tracks[i];
    if (!track) continue;

    for (const field of required) {
      const val = track[field as keyof RawTrackTags];
      if (!isValuePresent(val)) {
        issues.push(i);
        break; // Count this track once
      }
    }
  }

  return issues;
}

/**
 * Check for disc number gaps (e.g., disc 1, 3 but no 2).
 * Returns an object describing the gap (e.g., { missing: [2] }) or null if no gap.
 */
function checkDiscNumberGaps(tracks: RawTrackTags[]): { missing: number[] } | null {
  const discNumbers = new Set<number>();

  for (const track of tracks) {
    if (!track) continue;

    const dn = track.discnumber;
    if (isValuePresent(dn)) {
      const dnStr = Array.isArray(dn) ? (dn[0] ?? '') : String(dn);
      if (dnStr) {
        const parts = dnStr.split('/');
        const parsed = parseInt(parts[0] ?? '0', 10);
        if (!isNaN(parsed) && parsed > 0) {
          discNumbers.add(parsed);
        }
      }
    }
  }

  // If all tracks have discnumber, check for gaps
  if (discNumbers.size === 0) return null;

  const discs = Array.from(discNumbers).sort((a, b) => a - b);
  const missing: number[] = [];

  const first = discs[0];
  const last = discs[discs.length - 1];
  if (first !== undefined && last !== undefined) {
    for (let i = first; i <= last; i++) {
      if (!discNumbers.has(i)) {
        missing.push(i);
      }
    }
  }

  return missing.length > 0 ? { missing } : null;
}

/**
 * Helper to check if a value is present (not null, undefined, or empty string/array).
 */
function isValuePresent(val: string | string[] | undefined | null): boolean {
  if (val === null || val === undefined) return false;
  if (Array.isArray(val)) {
    return val.length > 0 && val.some((v) => v !== '' && v !== null && v !== undefined);
  }
  return String(val).trim().length > 0;
}
