import { z } from 'zod';

/**
 * Review matches: the numbers and words the review screen shows, and the
 * owner's auto-accept rules. Shared by the web (display), the API (dry run)
 * and the worker (rules applied to new matches), so the screen, the count in
 * the rules dialog and what the worker does can never disagree.
 */

/**
 * Match percent from the matcher's distance.
 *
 * core/matching scoreRelease's distance is a weighted mean of component
 * distances, each in [0, 1] (0 = the field agrees exactly, 1 = nothing in
 * common): sum(component × weight) / sum(weight). So 1 − distance is the same
 * weighted mean of how much each field agrees, and as a percent:
 *
 *   percent = round((1 − distance) × 100), clamped to 0..100
 *
 * The matcher's own bands read the same way: auto-accept at distance ≤ 0.04
 * is 96 % and up, the review band (≤ 0.25) is 75 % and up.
 */
export function matchPercent(distance: number): number {
  if (!Number.isFinite(distance)) return 0;
  return Math.min(100, Math.max(0, Math.round((1 - distance) * 100)));
}

export type MatchStrength = 'Strong' | 'Good' | 'Weak';

/** Strong ≥ 90, Good ≥ 75 (the review band), Weak below. */
export function matchStrength(percent: number): MatchStrength {
  if (percent >= 90) return 'Strong';
  if (percent >= 75) return 'Good';
  return 'Weak';
}

/** ✓ agrees · ≈ close · ✗ differs · unknown: one side has nothing to compare. */
export type Verdict = 'agrees' | 'close' | 'differs' | 'unknown';

export type ComparisonField = 'album' | 'artist' | 'year' | 'country' | 'tracks';

export interface ComparisonRow {
  field: ComparisonField;
  label: string;
  /** what the files say, null when they say nothing */
  disk: string | null;
  /** what the edition says, null when it says nothing */
  edition: string | null;
  verdict: Verdict;
}

/** The files on disk, as far as a comparison needs them. */
export interface ComparableAlbum {
  title: string | null;
  artist: string | null;
  year: number | null;
  trackCount: number;
}

/** One edition (candidate release) and its matcher breakdown. */
export interface ComparableEdition {
  title: string;
  artist: string | null;
  /** release date or year, 'YYYY[-MM[-DD]]' */
  date: string | null;
  country: string | null;
  trackCount: number | null;
  breakdown: Record<string, unknown> | null;
}

/** Same thresholds as the matcher's chip rule: 0 agrees, under 0.5 is close. */
function fromComponent(v: unknown): Verdict {
  if (typeof v !== 'number' || Number.isNaN(v)) return 'unknown';
  if (v === 0) return 'agrees';
  if (v < 0.5) return 'close';
  return 'differs';
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/** A year from 'YYYY', 'YYYY-MM' or 'YYYY-MM-DD'. */
export function yearOf(date: string | null | undefined): number | null {
  const m = /^(\d{4})/.exec(date ?? '');
  return m ? Number(m[1]) : null;
}

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;

/**
 * The edition beside the files, field by field. Album and artist take the
 * matcher's own text distance; year is the same year (✓), one or two apart
 * (≈, a release-date versus tag-year slip) or further (✗); tracks agree when
 * the counts match and every track paired, are close when the counts match
 * but some tracks did not pair, and differ otherwise. The files carry no
 * country, so that row only informs.
 */
export function compareEdition(album: ComparableAlbum, edition: ComparableEdition): ComparisonRow[] {
  const b = edition.breakdown ?? {};
  const edYear = yearOf(edition.date);
  let yearVerdict: Verdict = 'unknown';
  if (album.year && edYear) {
    const gap = Math.abs(album.year - edYear);
    yearVerdict = gap === 0 ? 'agrees' : gap <= 2 ? 'close' : 'differs';
  }
  let tracksVerdict: Verdict = 'unknown';
  if (edition.trackCount != null && album.trackCount > 0) {
    if (edition.trackCount !== album.trackCount) tracksVerdict = 'differs';
    else tracksVerdict = num(b['unmatchedTracks']) > 0 || num(b['missingTracks']) > 0 ? 'close' : 'agrees';
  }
  return [
    { field: 'album', label: 'Album', disk: album.title, edition: edition.title, verdict: album.title ? fromComponent(b['album']) : 'unknown' },
    { field: 'artist', label: 'Artist', disk: album.artist, edition: edition.artist, verdict: album.artist ? fromComponent(b['artist']) : 'unknown' },
    { field: 'year', label: 'Year', disk: album.year ? String(album.year) : null, edition: edYear ? String(edYear) : null, verdict: yearVerdict },
    { field: 'country', label: 'Country', disk: null, edition: edition.country, verdict: 'unknown' },
    {
      field: 'tracks',
      label: 'Tracks',
      disk: album.trackCount > 0 ? plural(album.trackCount, 'track') : null,
      edition: edition.trackCount != null ? plural(edition.trackCount, 'track') : null,
      verdict: tracksVerdict,
    },
  ];
}

/** Every row that can be compared agrees (rows with nothing to compare do not count against it). */
export function everyCheckAgrees(rows: ComparisonRow[]): boolean {
  return rows.every((r) => r.verdict === 'agrees' || r.verdict === 'unknown');
}

/** MusicBrainz release status, shown only when it is not Official. */
export function statusTag(status: string | null | undefined): string | null {
  const s = (status ?? '').trim();
  if (!s || s.toLowerCase() === 'official') return null;
  return s;
}

// ---- auto-accept rules ------------------------------------------------

export const autoAcceptSourceSchema = z.enum(['musicbrainz', 'discogs', 'either']);
export type AutoAcceptSource = z.infer<typeof autoAcceptSourceSchema>;

export const autoAcceptRulesSchema = z.object({
  /** master switch: the worker applies the rules to new matches */
  enabled: z.boolean(),
  /** the edition's match percent must be at least this */
  minMatch: z.number().int().min(50).max(100),
  /** every comparison row agrees (album, artist, year, tracks) */
  allChecksAgree: z.boolean(),
  /** the next edition scores at least this many points lower; 0 = no requirement */
  clearWinnerGap: z.number().int().min(0).max(50),
  /** when both providers list the edition, compare within this one */
  preferSource: autoAcceptSourceSchema,
  /** skip releases MusicBrainz marks as bootleg, promotion, withdrawn … */
  officialOnly: z.boolean(),
}).strict();

export type AutoAcceptRules = z.infer<typeof autoAcceptRulesSchema>;

/** Off until the owner turns it on; the values are a careful start. */
export const DEFAULT_AUTO_ACCEPT_RULES: AutoAcceptRules = {
  enabled: false,
  minMatch: 95,
  allChecksAgree: true,
  clearWinnerGap: 5,
  preferSource: 'either',
  officialOnly: true,
};

/** What the rules dialog shows: the stored rules and what they did lately. */
export interface AutoAcceptRecentItem {
  albumId: string;
  title: string | null;
  artist: string | null;
  percent: number;
  decidedAt: string;
}

export interface AutoAcceptView {
  rules: AutoAcceptRules;
  updatedAt: string | null;
  /** albums the rules accepted, newest first (a short list) */
  recent: AutoAcceptRecentItem[];
  /** albums the rules accepted in all */
  acceptedTotal: number;
}

export interface AutoAcceptPreview {
  /** needs_review albums the rules would accept now */
  wouldAccept: number;
  /** needs_review albums in the queue */
  total: number;
}

/** album_matches.reason prefix of every decision the rules made: the audit trail. */
export const AUTO_ACCEPT_REASON_PREFIX = 'auto-accept rules';
