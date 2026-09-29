/**
 * Plain words for gaps and the tasks made from them (0032).
 *
 * `gapLine` is the one line a gap row shows ("4 of 18 tracks are missing").
 * `taskText` is the action a task asks for ("Find the 4 missing tracks of
 * Transformation (Tracks 1–4: …) and add them to Artist/Transformation").
 * `wrongFix` is the way to correct a gap the owner marked as wrong.
 */
import { describeQualityFlag, joinAnd, plural, type DescribeOptions } from './qualityFlags';

export interface MissingTrack {
  disc?: number | null;
  position?: number | null;
  title?: string | null;
  lengthMs?: number | null;
}

/** What a gap row or a task needs to know about the gap. */
export interface GapLike {
  kind: string;
  flag?: string | null;
  details?: Record<string, unknown> | null;
}

/** What a task sentence names: the album (or release group) and where it lives. */
export interface TaskSubject {
  title?: string | null;
  artist?: string | null;
  folder?: string | null;
}

export const GAP_KIND_LABEL: Record<string, string> = {
  incomplete_album: 'Incomplete',
  duplicate: 'Other copies',
  missing_album: 'Missing album',
  quality: 'Tags, artwork and files',
};

/** "1–4", "1, 3 and 5–7" for one disc's positions. */
export function positionRanges(positions: number[]): string {
  const sorted = [...new Set(positions.filter((p) => Number.isFinite(p)))].sort((a, b) => a - b);
  const runs: string[] = [];
  let start: number | undefined;
  let prev: number | undefined;
  const close = () => {
    if (start === undefined || prev === undefined) return;
    if (prev === start) runs.push(String(start));
    else if (prev === start + 1) runs.push(String(start), String(prev));
    else runs.push(`${start}–${prev}`);
  };
  for (const p of sorted) {
    if (prev !== undefined && p === prev + 1) {
      prev = p;
      continue;
    }
    close();
    start = p;
    prev = p;
  }
  close();
  return joinAnd(runs);
}

/** "Track 3", "Tracks 1–4", or "Disc 1 tracks 3–4, disc 2 track 1" for a multi-disc album. */
export function missingTrackLabel(tracks: MissingTrack[]): string {
  const byDisc = new Map<number, number[]>();
  for (const t of tracks) {
    if (typeof t.position !== 'number') continue;
    const disc = t.disc ?? 1;
    byDisc.set(disc, [...(byDisc.get(disc) ?? []), t.position]);
  }
  const discs = [...byDisc.keys()].sort((a, b) => a - b);
  const one = (positions: number[]) => `${positions.length === 1 ? 'track' : 'tracks'} ${positionRanges(positions)}`;
  if (discs.length === 0) return '';
  if (discs.length === 1 && discs[0] === 1) {
    const s = one(byDisc.get(1)!);
    return s.charAt(0).toUpperCase() + s.slice(1);
  }
  const s = discs.map((d) => `disc ${d} ${one(byDisc.get(d)!)}`).join(', ');
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** First `max` titles, then "and n more". */
export function titleList(tracks: MissingTrack[], max = 6): string {
  const titles = tracks.map((t) => t.title?.trim()).filter((t): t is string => !!t);
  if (titles.length <= max) return titles.join(', ');
  return `${titles.slice(0, max).join(', ')} and ${titles.length - max} more`;
}

function missingOf(details: Record<string, unknown> | null | undefined): MissingTrack[] {
  const m = details?.['missing'];
  return Array.isArray(m) ? (m as MissingTrack[]) : [];
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** How many tracks an incomplete gap is short. */
export function missingCount(details: Record<string, unknown> | null | undefined): number {
  const listed = missingOf(details).length;
  if (listed > 0) return listed;
  const have = num(details?.['have']);
  const want = num(details?.['want']);
  return have != null && want != null ? Math.max(want - have, 0) : 0;
}

/** The quality flag a row stands for, with its value (one flag per row since 0032). */
export function qualityFlagOf(gap: GapLike): { key: string; value: unknown } | null {
  const flags = (gap.details?.['flags'] ?? null) as Record<string, unknown> | null;
  const key = gap.flag || (flags ? Object.keys(flags)[0] : undefined);
  if (!key) return null;
  return { key, value: flags?.[key] ?? true };
}

/** The one line a gap row shows: what is wrong, in plain words. */
export function gapLine(gap: GapLike, opts: DescribeOptions & { all?: Record<string, unknown> } = {}): string {
  const d = gap.details ?? {};
  switch (gap.kind) {
    case 'incomplete_album': {
      const want = num(d['want']);
      const n = missingCount(d);
      return want != null ? `${plural(n, 'track')} of ${want} ${n === 1 ? 'is' : 'are'} missing` : `${plural(n, 'track')} missing`;
    }
    case 'duplicate': {
      const n = num(d['count']) ?? 2;
      return `You have ${n} copies of this album in your library`;
    }
    case 'missing_album':
      return `${(d['title'] as string | undefined) ?? 'An album'} is not in your library`;
    case 'quality': {
      if (d['reason'] === 'audio_hash_mismatch') return 'A tag write stopped because a file’s audio changed; the plan is paused';
      const f = qualityFlagOf(gap);
      if (!f) return 'A quality check flagged this album';
      const issue = describeQualityFlag(f.key, f.value, opts.all, opts);
      return issue.count ? `${issue.title} · ${issue.count}` : issue.title;
    }
    default:
      return gap.kind.replace(/_/g, ' ');
  }
}

/** The action a task asks the owner to take, in one sentence. */
export function taskText(gap: GapLike, subject: TaskSubject): string {
  const d = gap.details ?? {};
  const title = subject.title?.trim() || 'this album';
  const where = subject.folder ? ` and add ${missingCount(d) === 1 ? 'it' : 'them'} to ${subject.folder}` : ` and add ${missingCount(d) === 1 ? 'it' : 'them'} to the album’s folder`;
  switch (gap.kind) {
    case 'incomplete_album': {
      const missing = missingOf(d);
      const n = missingCount(d);
      const label = missingTrackLabel(missing);
      const titles = titleList(missing);
      const which = label ? ` (${label}${titles ? `: ${titles}` : ''})` : '';
      return `Find the ${n === 1 ? 'missing track' : `${n} missing tracks`} of ${title}${which}${where}`;
    }
    case 'duplicate': {
      const n = num(d['count']) ?? 2;
      return `Choose which of the ${n} copies of ${title} to keep and remove the others from your music folders`;
    }
    case 'missing_album': {
      const t = subject.title?.trim() || (d['title'] as string | undefined) || 'this album';
      return `Get ${t}${subject.artist ? ` by ${subject.artist}` : ''} and add it to your library`;
    }
    case 'quality': {
      const f = qualityFlagOf(gap);
      if (!f) return `Check the quality problem on ${title}`;
      const issue = describeQualityFlag(f.key, f.value);
      const count = issue.count ? ` (${issue.count})` : '';
      const n = typeof f.value === 'number' ? f.value : 1;
      const folder = subject.folder ? ` in ${subject.folder}` : '';
      switch (f.key) {
        case 'noCover': return `Add cover art to ${title}`;
        case 'noEmbeddedArt': return `Embed cover art in the files of ${title}`;
        case 'missingMbIds': return `Write MusicBrainz IDs to ${title}${count} with Fix tags`;
        case 'parseErrors': return `Replace the ${n === 1 ? 'unreadable file' : `${n} unreadable files`} of ${title}${folder}`;
        case 'lowBitrate': return `Replace the ${n === 1 ? 'low-bitrate track' : `${n} low-bitrate tracks`} of ${title} with better copies`;
        case 'mixedLossless': return `Separate the lossless and lossy files of ${title}`;
        case 'trackNumberIssues':
        case 'emptyRequiredFields':
        case 'titleCaseAnomalies':
        case 'inconsistentAlbumFields':
        case 'discNumberGaps':
          return `Fix ${issue.title.charAt(0).toLowerCase()}${issue.title.slice(1)} on ${title}${count}`;
        default:
          return `${issue.title} on ${title}`;
      }
    }
    default:
      return `Check ${title}`;
  }
}

/** How a gap the owner marked as wrong can be put right; null when hiding it is all there is. */
export interface WrongFix {
  text: string;
  /** what the link or button does */
  action: 'editions' | 'reidentify' | 'follow-rules' | null;
  actionLabel?: string;
}

export function wrongFix(gap: GapLike): WrongFix {
  switch (gap.kind) {
    case 'incomplete_album':
      return {
        text: 'If the wrong edition was matched, its track count is wrong too. Choose the edition you own, or re-identify the album.',
        action: 'editions',
        actionLabel: 'Choose the right edition',
      };
    case 'duplicate':
      return {
        text: 'If these are different albums, one of them was matched to the wrong release. Re-identify it from its album page.',
        action: 'reidentify',
        actionLabel: 'Re-identify',
      };
    case 'missing_album':
      return {
        text: 'If this release should not count for this artist, change which release types you follow.',
        action: 'follow-rules',
        actionLabel: 'Change what you follow',
      };
    default:
      return { text: 'This check stays hidden for this album. Your answer is recorded so the check can be improved.', action: null };
  }
}

/** "Resolved by scan on 29 Sep 2026", or why the task left the list. */
export function doneLabel(task: { resolvedAt: string | null; subjectGone: boolean }, locale?: string): string {
  const date = task.resolvedAt ? new Date(task.resolvedAt).toLocaleDateString(locale, { day: 'numeric', month: 'short', year: 'numeric' }) : null;
  if (task.subjectGone) return date ? `No longer in your library (checked ${date})` : 'No longer in your library';
  return date ? `Resolved by scan on ${date}` : 'Resolved by scan';
}
