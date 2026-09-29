/**
 * The plan page's "not identified yet" albums, told from what really
 * happened: still queued or running, matched now (preview again), could not
 * be matched and why, or gone (merged into another album). Replaces the
 * frozen "Identification queued for 1 album" note, which stayed the same
 * after the job had long ended.
 */
import type { IdentifyStatusItem } from '../hooks/useIdentifyStatus';

export type AlbumIdentifyLine =
  | { albumId: string; kind: 'gone' }
  | { albumId: string; kind: 'matched'; label: string }
  | { albumId: string; kind: 'live'; label: string; text: string }
  | { albumId: string; kind: 'ended'; label: string; title: string; text: string; actionable: boolean; needsPick: boolean }
  | { albumId: string; kind: 'untouched'; label: string };

const OUTCOME_TITLE: Record<string, string> = {
  matched: 'matched',
  needs_review: 'needs your review',
  unidentified: 'could not be matched',
  release_group: 'needs you to pick a release',
  not_found: 'the ID was not found',
  failed: 'the lookup failed',
  cancelled: 'cancelled',
  skipped: 'nothing to do',
  unknown: 'finished',
};

const labelOf = (i: Extract<IdentifyStatusItem, { exists: true }>) =>
  `${i.artist ? `${i.artist} — ` : ''}${i.title ?? 'Untitled album'}`;

export function identifyLines(items: readonly IdentifyStatusItem[]): AlbumIdentifyLine[] {
  return items.map((i): AlbumIdentifyLine => {
    if (!i.exists) return { albumId: i.albumId, kind: 'gone' };
    const label = labelOf(i);
    const r = i.request;
    if (r && r.status !== 'done') {
      const text = r.status === 'running' ? 'identifying now'
        : r.status === 'retrying' ? 'the providers were busy; trying again'
          : r.jobsAhead === 0 ? 'identification queued, next in line' : `identification queued, ${r.jobsAhead.toLocaleString()} ahead`;
      return { albumId: i.albumId, kind: 'live', label, text };
    }
    if (i.state === 'matched') return { albumId: i.albumId, kind: 'matched', label };
    if (r?.outcome) {
      const k = r.outcome.kind;
      return {
        albumId: i.albumId,
        kind: 'ended',
        label,
        title: OUTCOME_TITLE[k] ?? 'finished',
        text: r.outcome.message,
        actionable: k === 'release_group' || k === 'not_found' || k === 'failed' || k === 'needs_review' || k === 'unidentified',
        needsPick: k === 'release_group',
      };
    }
    return { albumId: i.albumId, kind: 'untouched', label };
  });
}

/**
 * How many albums the plan was made for against how many it covers now: a
 * plan keeps the album ids it was created with, and an album merged into
 * another since then no longer exists ("16 files belong to 1 album" on a
 * plan made for 2 — prod 2026-09-29, Hotel Costes Vol. 11).
 */
export function planAlbumScope(planAlbumIds: readonly string[] | null, items: readonly IdentifyStatusItem[] | undefined): { made: number; gone: number; now: number } | null {
  if (!planAlbumIds || !items) return null;
  const known = new Map(items.map((i) => [i.albumId, i.exists]));
  const gone = planAlbumIds.filter((id) => known.get(id) === false).length;
  return { made: planAlbumIds.length, gone, now: planAlbumIds.length - gone };
}
