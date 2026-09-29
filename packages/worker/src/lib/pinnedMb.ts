/**
 * Manual MusicBrainz entry (IDN-6): the owner pastes an id or URL. A bare id
 * may name a release or a release group — MusicBrainz ids do not say which.
 * The release lookup comes first; a 404 there tries the release group, whose
 * releases are listed for the owner to pick from, ranked by how well they fit
 * the local files. "pinned id not found" used to be a log line only
 * (2026-09-29, Hotel Costes Vol. 11: 593f3c1a-… is a release group).
 */
import type { CanonicalRelease, Edition, EditionsPage } from '@liner/core';
import type { ReleaseChoice } from '@liner/shared';

/** Choices shown on the album page; the rest are counted. */
export const MAX_RELEASE_CHOICES = 12;

export interface LocalShape {
  trackCount: number;
  /** distinct discs the files name; undefined when no track carries a disc number */
  discCount?: number;
  year?: number;
}

const FORMAT_SHORT: Record<string, string> = { 'Digital Media': 'Digital', '12" Vinyl': 'Vinyl', '7" Vinyl': 'Vinyl' };

/** "2×CD", "CD + DVD", "Digital" */
export function formatsLabel(media: Edition['media']): string | undefined {
  if (!media.length) return undefined;
  const counts = new Map<string, number>();
  for (const m of media) {
    const f = m.format ? (FORMAT_SHORT[m.format] ?? m.format) : 'Unknown medium';
    counts.set(f, (counts.get(f) ?? 0) + 1);
  }
  return [...counts.entries()].map(([f, n]) => (n > 1 ? `${n}×${f}` : f)).join(' + ');
}

function yearOf(date: string | null | undefined): number | undefined {
  const y = date ? parseInt(date.slice(0, 4), 10) : NaN;
  return Number.isFinite(y) ? y : undefined;
}

/**
 * Rank a release group's releases by fit to the local files: track count
 * first, then disc count (when the files name discs), official status, year
 * distance, and the earliest release date as the tie-break.
 */
export function rankEditions(editions: Edition[], local: LocalShape): ReleaseChoice[] {
  const scored = editions.map((e) => {
    const trackCount = e.trackCount ?? (e.media.reduce((n, m) => n + (m.trackCount ?? 0), 0) || null);
    const trackDelta = trackCount == null ? null : trackCount - local.trackCount;
    const mediumCount = e.media.length;
    const discsOk = local.discCount === undefined || mediumCount === 0 || mediumCount === local.discCount;
    const abs = trackDelta == null ? 99 : Math.abs(trackDelta);
    const fit: ReleaseChoice['fit'] = abs === 0 && discsOk ? 'exact' : abs <= 2 ? 'close' : 'far';
    const y = yearOf(e.date);
    const score = abs * 10
      + (discsOk ? 0 : 5)
      + (e.status && e.status !== 'Official' ? 3 : 0)
      + (local.year && y ? Math.min(Math.abs(local.year - y), 10) * 0.1 : 0.5);
    const label = e.labels[0];
    const choice: ReleaseChoice = {
      mbid: e.mbid,
      title: e.title,
      ...(e.disambiguation ? { disambiguation: e.disambiguation } : {}),
      ...(e.date ? { date: e.date } : {}),
      ...(e.country ? { country: e.country } : {}),
      ...(e.status ? { status: e.status } : {}),
      ...(formatsLabel(e.media) ? { formats: formatsLabel(e.media)! } : {}),
      trackCount,
      mediumCount,
      ...(label?.name ? { label: label.name } : {}),
      ...(label?.catalogNumber ? { catalogNumber: label.catalogNumber } : {}),
      trackDelta,
      fit,
    };
    return { choice, score, date: e.date ?? '9999' };
  });
  scored.sort((a, b) => a.score - b.score || a.date.localeCompare(b.date) || a.choice.mbid.localeCompare(b.choice.mbid));
  return scored.map((s) => s.choice);
}

export type PinnedMbResult =
  | { kind: 'release'; release: CanonicalRelease }
  | {
      kind: 'release_group';
      releaseGroup: { mbid: string; title: string };
      choices: ReleaseChoice[];
      moreChoices: number;
    }
  | { kind: 'not_found'; message: string };

export interface PinnedMbDeps {
  release: (mbid: string) => Promise<CanonicalRelease>;
  /** first page of the release group's releases */
  releaseGroupEditions: (rgMbid: string) => Promise<EditionsPage>;
}

const is404 = (err: unknown) => (err as { status?: number } | null)?.status === 404;

async function asReleaseGroup(deps: PinnedMbDeps, rgMbid: string, local: LocalShape): Promise<PinnedMbResult | null> {
  let page: EditionsPage;
  try {
    page = await deps.releaseGroupEditions(rgMbid);
  } catch (err) {
    if (is404(err)) return null;
    throw err;
  }
  if (page.editions.length === 0) return null;
  const ranked = rankEditions(page.editions, local);
  return {
    kind: 'release_group',
    releaseGroup: { mbid: rgMbid, title: page.releaseGroup?.title ?? page.editions[0]!.title },
    choices: ranked.slice(0, MAX_RELEASE_CHOICES),
    moreChoices: Math.max(0, page.total - Math.min(ranked.length, MAX_RELEASE_CHOICES)),
  };
}

/**
 * Resolve what the owner pasted. `releaseGroup` set: the URL named a release
 * group, list its releases. `mbid` set: try it as a release, then as a
 * release group. Other provider errors propagate (the job retries).
 */
export async function resolvePinnedMb(
  deps: PinnedMbDeps,
  pinned: { mbid?: string; releaseGroup?: string },
  local: LocalShape,
): Promise<PinnedMbResult> {
  if (pinned.releaseGroup) {
    return (await asReleaseGroup(deps, pinned.releaseGroup, local))
      ?? { kind: 'not_found', message: 'This release group does not exist on MusicBrainz (or has no releases).' };
  }
  const mbid = pinned.mbid;
  if (!mbid) return { kind: 'not_found', message: 'No MusicBrainz id was given.' };
  try {
    return { kind: 'release', release: await deps.release(mbid) };
  } catch (err) {
    if (!is404(err)) throw err;
  }
  return (await asReleaseGroup(deps, mbid, local))
    ?? { kind: 'not_found', message: 'This ID does not exist on MusicBrainz as a release or a release group. Check that you copied the release page address (musicbrainz.org/release/…).' };
}
