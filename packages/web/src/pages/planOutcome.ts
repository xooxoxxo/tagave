/**
 * Why a previewed plan changes nothing (or leaves files out), read from its
 * stats. The plan page used to say only "Nothing to apply", which hid the
 * usual cause: a canonical plan over albums that are not identified yet has
 * nothing to write. Each reason comes with what the owner can do about it.
 *
 * Plans previewed before the reasons were split recorded an unidentified
 * album as reason "audio_file_error" with the message "album not
 * identified"; those still read correctly.
 */
import type { TagPlanStats } from '@liner/shared';

export interface PreviewOutcome {
  /** the preview wrote nothing for any file */
  nothing: boolean;
  filesInScope: number | null;
  notIdentified: { files: number; albumIds: string[] };
  releaseMissing: { files: number; albumIds: string[] };
  notInAlbum: number;
  notWritable: number;
  errors: { files: number; sample: string | null };
  /** files whose only would-be changes a lock blocked */
  lockedOnly: number;
  /** field changes blocked by locks, over all files */
  lockedChanges: number;
  alreadyCorrect: number | null;
  /** at least one reason can be named */
  explained: boolean;
}

type Skipped = TagPlanStats['filesSkipped'][number];

const legacyReason = (s: Skipped): Skipped['reason'] => {
  if (s.reason !== 'audio_file_error' || !s.message) return s.reason;
  const m = s.message.toLowerCase();
  if (m === 'album not identified') return 'album_not_identified';
  if (m === 'release missing') return 'release_missing';
  if (m === 'not in album') return 'not_in_album';
  return s.reason;
};

export function explainPreview(stats: Partial<TagPlanStats> | undefined | null): PreviewOutcome | null {
  if (!stats) return null;
  const skipped = stats.filesSkipped ?? [];
  const notIdentifiedAlbums = new Set<string>();
  const releaseMissingAlbums = new Set<string>();
  let notIdentified = 0;
  let releaseMissing = 0;
  let notInAlbum = 0;
  let notWritable = 0;
  let errors = 0;
  let sample: string | null = null;
  for (const s of skipped) {
    switch (legacyReason(s)) {
      case 'album_not_identified':
        notIdentified++;
        if (s.localAlbumId) notIdentifiedAlbums.add(s.localAlbumId);
        break;
      case 'release_missing':
        releaseMissing++;
        if (s.localAlbumId) releaseMissingAlbums.add(s.localAlbumId);
        break;
      case 'not_in_album': notInAlbum++; break;
      case 'scan_root_not_writable': notWritable++; break;
      default:
        errors++;
        sample ??= s.message ?? null;
    }
  }
  const lockedOnly = stats.filesLockedOnly ?? 0;
  const lockedChanges = stats.lockedFieldsRespected ?? 0;
  const alreadyCorrect = stats.filesAlreadyCorrect ?? null;
  return {
    nothing: (stats.filesTouched ?? 0) === 0,
    filesInScope: stats.filesInScope ?? null,
    notIdentified: { files: notIdentified, albumIds: [...notIdentifiedAlbums] },
    releaseMissing: { files: releaseMissing, albumIds: [...releaseMissingAlbums] },
    notInAlbum,
    notWritable,
    errors: { files: errors, sample },
    lockedOnly,
    lockedChanges,
    alreadyCorrect,
    explained: skipped.length > 0 || lockedOnly > 0 || lockedChanges > 0 || (alreadyCorrect ?? 0) > 0,
  };
}

export const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`;
export const verb = (n: number, one: string, many: string) => (n === 1 ? one : many);
