/**
 * The words above a finished plan's results: what the plan made of the
 * albums ("3 albums became 1: The Last Tycoon by Peter Morén") and what it
 * wrote ("10 files written"). Pure, so the phrasing is tested on its own.
 */
import type { TagPlanResults } from '@liner/shared';
import { plural } from './planOutcome';

export function resultsHeadline(r: TagPlanResults): string {
  const n = r.albumCount;
  if (n === 0 || r.albums.length === 0) {
    return r.filesWritten > 0 ? `${plural(r.filesWritten, 'file')} written, not part of any album` : 'Nothing was written';
  }
  // "N became M" only from what tags.apply counted before this plan wrote
  // anything: not the scope (it can name albums a merge has since removed),
  // not an earlier merge the album remembers.
  const before = r.albumsBefore;
  const became = before !== null && before > n ? `${before} albums became ${n}` : null;
  if (n === 1) {
    const a = r.albums[0]!;
    const name = `${a.title} by ${a.artistCredit}`;
    return became ? `${became}: ${name}` : name;
  }
  return became ?? `${n.toLocaleString()} albums`;
}

export function resultsFilesLine(r: TagPlanResults): string {
  const parts = [`${plural(r.filesWritten, 'file')} written`];
  if (r.filesFailed > 0) parts.push(`${r.filesFailed.toLocaleString()} failed`);
  if (r.looseFiles > 0 && r.albumCount > 0) parts.push(`${plural(r.looseFiles, 'file')} not in an album`);
  if (r.albumCount > r.albums.length) parts.push(`first ${r.albums.length.toLocaleString()} albums shown`);
  return parts.join(' · ');
}

/** The one line a reverted plan keeps instead of its results: the albums it made are gone. */
export function revertedLine(filesWritten: number): string {
  return filesWritten > 0
    ? `Reverted: the tags from before this plan are back on ${plural(filesWritten, 'file')}.`
    : 'Reverted: the tags from before this plan are back.';
}

/**
 * Statuses whose page leads with the results section. Not 'reverted': the
 * albums the plan made no longer exist, so that page shows revertedLine.
 */
export const RESULT_STATUSES = new Set(['applied', 'partially_failed', 'cancelled']);

/**
 * Why a plan that wrote files has no working Delete (the API refuses it with
 * the same reason): its items are the journal Revert restores from.
 */
export const KEPT_PLAN_NOTE = 'Kept: it holds the old tags Revert needs. Revert first to delete.';
