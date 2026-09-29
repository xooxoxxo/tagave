/**
 * The words above an applied plan's results: what the plan made of the
 * albums ("3 albums became 1: The Last Tycoon by Peter Morén") and what it
 * wrote ("10 files written"). Pure, so the phrasing is tested on its own.
 */
import type { TagPlanResults } from '@liner/shared';
import { plural } from './planOutcome';

export function resultsHeadline(r: TagPlanResults): string {
  const n = r.albums.length;
  if (n === 0) {
    return r.filesWritten > 0 ? `${plural(r.filesWritten, 'file')} written, not part of any album` : 'Nothing was written';
  }
  if (n === 1) {
    const a = r.albums[0]!;
    // A merged album remembers what it was made of; otherwise the plan's
    // own scope says how many albums went in.
    const before = a.mergedFrom > 0 ? a.mergedFrom + 1 : (r.albumsInScope ?? 1);
    const name = `${a.title} by ${a.artistCredit}`;
    return before > 1 ? `${before} albums became 1: ${name}` : name;
  }
  if (r.albumsInScope !== null && r.albumsInScope > n) return `${r.albumsInScope} albums became ${n}`;
  return `${n} albums`;
}

export function resultsFilesLine(r: TagPlanResults): string {
  const parts = [`${plural(r.filesWritten, 'file')} written`];
  if (r.filesFailed > 0) parts.push(`${r.filesFailed.toLocaleString()} failed`);
  if (r.looseFiles > 0 && r.albums.length > 0) parts.push(`${plural(r.looseFiles, 'file')} not in an album`);
  return parts.join(' · ');
}

/** Statuses whose page leads with the results section. */
export const RESULT_STATUSES = new Set(['applied', 'partially_failed', 'cancelled', 'reverted']);
