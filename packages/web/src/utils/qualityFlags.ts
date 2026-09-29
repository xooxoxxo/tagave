/**
 * Plain-language rows for an album's quality flags (GAP-5).
 *
 * The worker stores one quality gap per album and flag (0032), each with
 * `details.flags` holding that one flag. The flags come from two sources:
 * audio checks (`true` or a count) and the TAG-6 lint rules in @liner/core, which keep their own shapes — `missing: number[]`,
 * `tracks: number[]`, `issues: string[]`, `fields: string[]` and
 * `gap: { missing: number[] }`. Track references are 0-based positions in the
 * album's disc/track order; rows show them 1-based.
 */

/** The one next step a row offers: fetch cover art, open the tag wizard, or open the split options. */
export type QualityAction = 'art' | 'tags' | 'split';

export interface QualityIssue {
  key: string;
  /** short name of the problem, e.g. "Missing MusicBrainz IDs" */
  title: string;
  /** how much is affected, e.g. "14 tracks", "2 issues"; absent for yes/no flags */
  count?: string;
  /** what is wrong, in one or two plain sentences */
  explain: string;
  /** which tracks or numbers are affected, one shortened line each */
  affected?: string[];
  /** the button the row offers */
  action?: QualityAction;
  /** what to do when there is no button, or what the button does */
  guidance?: string;
}

export interface DescribeOptions {
  /** the folder mixes lossless and lossy files, so the split options exist */
  mixed?: boolean;
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString()} ${n === 1 ? one : many}`;
}

/** "a", "a and b", "a, b and c" */
export function joinAnd(items: string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/** First `max` items, then "and n more". */
export function shortList(items: string[], max = 8): string {
  if (items.length <= max) return joinAnd(items);
  return `${items.slice(0, max).join(', ')} and ${items.length - max} more`;
}

/** "Track 3" or "Tracks 1, 2, 5 and 9 more", from 0-based positions. */
export function trackList(indices: number[], max = 8): string {
  const nums = [...new Set(indices)].sort((a, b) => a - b).map((i) => String(i + 1));
  return `${nums.length === 1 ? 'Track' : 'Tracks'} ${shortList(nums, max)}`;
}

const FIELD_NAME: Record<string, string> = {
  album: 'album title',
  albumartist: 'album artist',
  date: 'date',
  totaltracks: 'total tracks',
};

function numbers(v: unknown): number[] {
  return Array.isArray(v) ? v.filter((x): x is number => typeof x === 'number' && Number.isFinite(x)) : [];
}

function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

function count(v: unknown): number {
  return typeof v === 'number' && v > 0 ? v : 1;
}

function field(v: unknown, name: string): unknown {
  return v && typeof v === 'object' ? (v as Record<string, unknown>)[name] : undefined;
}

function humanize(key: string): string {
  return key.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, (c) => c.toUpperCase());
}

/**
 * The lint rule writes "missing tracknumber at track index 3" and
 * "duplicate tracknumber 4 at indices 5, 6"; split them back into parts.
 */
export function parseTrackNumberIssues(issues: string[]): { missing: number[]; duplicates: { number: number; tracks: number[] }[]; other: string[] } {
  const missing: number[] = [];
  const duplicates: { number: number; tracks: number[] }[] = [];
  const other: string[] = [];
  for (const issue of issues) {
    const m = /^missing tracknumber at track index (\d+)$/.exec(issue);
    if (m) {
      missing.push(Number(m[1]));
      continue;
    }
    const d = /^duplicate tracknumber (\d+) at indices ([\d,\s]+)$/.exec(issue);
    if (d) {
      duplicates.push({ number: Number(d[1]), tracks: (d[2] ?? '').split(',').map((s) => Number(s.trim())).filter(Number.isFinite) });
      continue;
    }
    other.push(issue);
  }
  missing.sort((a, b) => a - b);
  duplicates.sort((a, b) => a.number - b.number);
  return { missing, duplicates, other };
}

function describeOne(key: string, value: unknown, all: Record<string, unknown>, opts: DescribeOptions): QualityIssue {
  switch (key) {
    case 'noCover':
      return {
        key,
        title: 'No cover art',
        explain: 'This album has no front cover image, so it shows a blank square in your library.',
        action: 'art',
        guidance: 'Looks the cover up online and saves it.',
      };
    case 'noEmbeddedArt':
      return {
        key,
        title: 'No embedded art',
        explain: 'None of the music files carry a cover picture, so players that read the files directly show no artwork.',
        guidance: 'noCover' in all
          ? 'Fetching the cover art above clears this too.'
          : 'Nothing to do unless your music player needs artwork inside the files.',
      };
    case 'missingMbIds': {
      const tracks = numbers(field(value, 'missing'));
      return {
        key,
        title: 'Missing MusicBrainz IDs',
        count: plural(tracks.length || 1, 'track'),
        explain: 'These tracks have no MusicBrainz recording ID in their tags. The tag wizard can write the IDs from the matched release.',
        ...(tracks.length ? { affected: [trackList(tracks)] } : {}),
        action: 'tags',
      };
    }
    case 'trackNumberIssues': {
      const raw = strings(field(value, 'issues'));
      const { missing, duplicates, other } = parseTrackNumberIssues(raw);
      const parts: string[] = [];
      if (missing.length) parts.push(`${plural(missing.length, 'track has', 'tracks have')} no track number`);
      if (duplicates.length) parts.push(`${plural(duplicates.length, 'track number is', 'track numbers are')} used more than once`);
      const affected: string[] = [];
      if (missing.length) affected.push(`No number: ${trackList(missing)}`);
      if (duplicates.length) {
        const shown = duplicates.slice(0, 4).map((d) => `number ${d.number} on ${trackList(d.tracks).toLowerCase()}`);
        const more = duplicates.length - shown.length;
        affected.push(`Repeated: ${shown.join('; ')}${more > 0 ? `; and ${more} more` : ''}`);
      }
      if (other.length) affected.push(shortList(other, 3));
      return {
        key,
        title: 'Track numbers',
        // tracks affected when every issue parsed; the raw issue count otherwise
        count: other.length
          ? plural(raw.length || 1, 'issue')
          : plural(new Set([...missing, ...duplicates.flatMap((d) => d.tracks)]).size || 1, 'track'),
        explain: parts.length ? `${joinAnd(parts).replace(/^./, (c) => c.toUpperCase())}, so players may play the album in the wrong order.` : 'Some track numbers are missing or repeated, so players may play the album in the wrong order.',
        ...(affected.length ? { affected } : {}),
        action: 'tags',
      };
    }
    case 'emptyRequiredFields': {
      const tracks = numbers(field(value, 'tracks'));
      return {
        key,
        title: 'Blank basic tags',
        count: plural(tracks.length || 1, 'track'),
        explain: 'These tracks are missing a title, artist, album or track number tag, which makes them hard to find and sort.',
        ...(tracks.length ? { affected: [trackList(tracks)] } : {}),
        action: 'tags',
      };
    }
    case 'titleCaseAnomalies': {
      const tracks = numbers(field(value, 'tracks'));
      return {
        key,
        title: 'Odd capitalisation',
        count: plural(tracks.length || 1, 'title'),
        explain: 'These track titles are written all in lower case or all in capitals.',
        ...(tracks.length ? { affected: [trackList(tracks)] } : {}),
        action: 'tags',
      };
    }
    case 'inconsistentAlbumFields': {
      const names = strings(field(value, 'fields')).map((f) => FIELD_NAME[f] ?? humanize(f).toLowerCase());
      const list = joinAnd(names);
      return {
        key,
        title: 'Album details differ between tracks',
        count: plural(names.length || 1, 'field'),
        explain: names.length
          ? `${list.replace(/^./, (c) => c.toUpperCase())} ${names.length === 1 ? 'is' : 'are'} not the same on every track, so the album can show up split or under the wrong name.`
          : 'Some album-wide tags are not the same on every track, so the album can show up split or under the wrong name.',
        action: 'tags',
      };
    }
    case 'discNumberGaps': {
      const missing = numbers(field(field(value, 'gap'), 'missing')).sort((a, b) => a - b);
      const n = missing.length || 1;
      return {
        key,
        title: 'Disc numbers skip',
        count: plural(n, 'missing disc'),
        explain: missing.length
          ? `${missing.length === 1 ? 'Disc' : 'Discs'} ${joinAnd(missing.map(String))} ${missing.length === 1 ? 'is' : 'are'} skipped in the disc numbers. Either a disc is missing from the folder or the disc tags are wrong.`
          : 'The disc numbers skip a disc. Either a disc is missing from the folder or the disc tags are wrong.',
        action: 'tags',
      };
    }
    case 'parseErrors': {
      const n = count(value);
      return {
        key,
        title: 'Unreadable files',
        count: plural(n, 'file'),
        explain: `${n === 1 ? 'One file' : `${n.toLocaleString()} files`} could not be read. ${n === 1 ? 'It may be' : 'They may be'} damaged or in a format that is not supported.`,
        guidance: 'Re-rip or replace these files, then rescan the folder.',
      };
    }
    case 'mixedLossless':
      return {
        key,
        title: 'Lossless and lossy files mixed',
        explain: 'This folder holds both lossless files (such as FLAC) and lossy copies (such as MP3) of the album.',
        ...(opts.mixed
          ? { action: 'split' as const, guidance: 'Opens Manage this album, where you can move the lossy copies to their own album.' }
          : { guidance: 'Rescan the folder under Manage this album to see the split options.' }),
      };
    case 'lowBitrate': {
      const n = count(value);
      return {
        key,
        title: 'Low bitrate',
        count: plural(n, 'track'),
        explain: `${n === 1 ? 'One lossy track is' : `${n.toLocaleString()} lossy tracks are`} below 192 kbps and may sound noticeably worse.`,
        guidance: 'Replace them with better copies if you have them.',
      };
    }
    default: {
      const n = typeof value === 'number' ? value : null;
      return {
        key,
        title: humanize(key),
        ...(n != null ? { count: plural(n, 'item') } : {}),
        explain: 'A quality check flagged this album.',
      };
    }
  }
}

/**
 * One flag's row. Quality gaps are one row per flag since 0032; `all` is every
 * open flag of the album, which some rows mention ("fetching the cover art
 * above clears this too").
 */
export function describeQualityFlag(key: string, value: unknown, all: Record<string, unknown> = { [key]: value }, opts: DescribeOptions = {}): QualityIssue {
  return describeOne(key, value, all, opts);
}

/** One row per flag, in the order they were stored. */
export function describeQualityFlags(flags: Record<string, unknown> | null | undefined, opts: DescribeOptions = {}): QualityIssue[] {
  if (!flags) return [];
  return Object.entries(flags)
    .filter(([, v]) => v != null && v !== false && v !== 0)
    .map(([key, value]) => describeOne(key, value, flags, opts));
}
