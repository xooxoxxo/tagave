/**
 * What the album page shows about the album's upkeep, and when.
 *
 * The page has two modes (see maintenance.ts). With Maintenance off the page
 * is only the album, and it interrupts only when a real discrepancy needs a
 * decision:
 *   - the album needs review (choose a match),
 *   - it looks like part of a split album (merge suggestion),
 *   - an identification the owner asked for failed or needs a pick,
 *   - a task the owner added was resolved (until acknowledged).
 * An owner request that is still running also shows, because the owner just
 * asked for it. Everything else (quality flags, missing tracks, duplicates,
 * tasks on the list, hidden rows, length differences) waits for Maintenance.
 *
 * Every row is one line plus one action; rows expand in place for the rest.
 */
import type { IdentifyOutcomeKind, IdentifyRequestView } from '@liner/shared';
import { describeQualityFlag, plural, type QualityAction } from './qualityFlags';
import { gapLine, missingCount, qualityFlagOf } from './gapTasks';

/** The outcomes that ask the owner to do something next. */
export const ACTIONABLE_OUTCOMES: ReadonlySet<IdentifyOutcomeKind> = new Set(['release_group', 'not_found', 'failed', 'needs_review', 'unidentified']);

/** A canonical length this far from the file's length is not worth mentioning. */
export const LENGTH_TOLERANCE_MS = 3000;

/** How long a resolved task keeps knocking, unless acknowledged first. */
export const DONE_TASK_WINDOW_MS = 14 * 86_400_000;
/** How long a finished (non-actionable) request stays listed in Maintenance. */
export const RECENT_REQUEST_MS = 3 * 86_400_000;

// ---- tabs and old links ----

export type AlbumTab = 'tracks' | 'editions' | 'about' | 'activity';
export interface AlbumSearch {
  tab?: AlbumTab;
  /** open the attention strip (turns Maintenance on): old "Library health" links */
  issues?: boolean;
}

const LEGACY_TAB: Record<string, AlbumSearch> = {
  album: {},
  tracks: {},
  care: { issues: true },
  health: { issues: true },
  'library-health': { issues: true },
  issues: { issues: true },
  reviews: { tab: 'about' },
  details: { tab: 'about' },
};

/** The album route's search, validated: unknown values fall back to Tracks. */
export function parseAlbumSearch(search: Record<string, unknown>): AlbumSearch {
  const out: AlbumSearch = {};
  const tab = typeof search['tab'] === 'string' ? search['tab'] : undefined;
  if (tab === 'editions' || tab === 'about' || tab === 'activity') out.tab = tab;
  else if (tab && LEGACY_TAB[tab]) Object.assign(out, LEGACY_TAB[tab]);
  const issues = search['issues'];
  if (issues === true || issues === 'true' || issues === 1 || issues === '1') out.issues = true;
  return out;
}

/**
 * The canonical search for an address that still uses an old tab id
 * (?tab=care, ?tab=album, ?tab=reviews…), or null when it is current.
 */
export function albumSearchRedirect(search: Record<string, unknown>): AlbumSearch | null {
  const tab = search['tab'];
  if (typeof tab !== 'string' || !(tab in LEGACY_TAB)) return null;
  return parseAlbumSearch(search);
}

// ---- length discrepancies ----

/** The difference in ms when two lengths differ by more than the tolerance, else null. */
export function lengthDiscrepancy(localMs: number | null | undefined, canonicalMs: number | null | undefined, toleranceMs = LENGTH_TOLERANCE_MS): number | null {
  if (!localMs || !canonicalMs) return null;
  const d = localMs - canonicalMs;
  return Math.abs(d) > toleranceMs ? d : null;
}

/** "+0:09" / "−0:04" for a length difference. */
export function formatDelta(ms: number): string {
  const s = Math.round(Math.abs(ms) / 1000);
  return `${ms < 0 ? '−' : '+'}${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export interface ComparableTrack {
  title: string | null;
  durationMs: number | null;
  canonicalTitle: string | null;
  canonicalDurationMs: number | null;
}

/** Tracks whose length is off by more than the tolerance, or whose title differs from the release. */
export function trackDiscrepancies<T extends ComparableTrack>(tracks: readonly T[]): { lengths: T[]; titles: T[] } {
  return {
    lengths: tracks.filter((t) => lengthDiscrepancy(t.durationMs, t.canonicalDurationMs) !== null),
    titles: tracks.filter((t) => !!t.canonicalTitle && !!t.title && t.canonicalTitle.trim().toLowerCase() !== t.title.trim().toLowerCase()),
  };
}

// ---- the attention strip ----

export interface AttentionGap {
  id: string;
  kind: string;
  state: string;
  dismissReason?: string | null;
  details: Record<string, unknown>;
  flag?: string | null;
  acceptedAt?: string | null;
  resolvedAt?: string | null;
}

export interface AttentionAlbum {
  state: string;
  merged?: boolean | undefined;
  mixed?: boolean | undefined;
  mergeCandidates?: ReadonlyArray<{ id: string; trackCount: number | null }> | undefined;
  candidates: ReadonlyArray<{ excluded: boolean }>;
  gaps: readonly AttentionGap[];
  missingTracks: readonly unknown[];
  duplicates: readonly unknown[];
  tracks: readonly ComparableTrack[];
  hasRelease: boolean;
  match?: { decidedAt: string | null } | null | undefined;
}

export type AttentionKind =
  | 'request' | 'review' | 'merge' | 'task-done'
  | 'unmatched' | 'gap' | 'missing' | 'quality' | 'duplicates' | 'lengths' | 'merged' | 'tasks' | 'hidden';

/**
 * What the row's one button does. `expand` opens the row; the others act at
 * once (the row still expands for detail when its line is pressed).
 */
export type AttentionAction =
  | { label: string; do: 'expand' }
  | { label: string; do: 'merge' }
  | { label: string; do: 'unmerge' }
  | { label: string; do: 'cancel-request' }
  | { label: string; do: 'dismiss-request' }
  | { label: string; do: 'ack-tasks' }
  | { label: string; do: 'editions' }
  | { label: string; do: QualityAction };

export interface AttentionItem {
  /** stable across refetches, so an open row stays open */
  id: string;
  kind: AttentionKind;
  /** attention: needs a decision · live: running now · done: good news · quiet: for the record */
  tone: 'attention' | 'live' | 'done' | 'quiet';
  line: string;
  action: AttentionAction | null;
  /** shown with Maintenance off */
  interrupts: boolean;
  gapIds?: string[];
}

export interface AttentionOptions {
  request?: IdentifyRequestView | null | undefined;
  /** the request key the owner dismissed on this page */
  dismissedRequestKey?: string | null | undefined;
  /** resolved task ids the owner acknowledged */
  ackedTaskIds?: ReadonlySet<string> | undefined;
  now?: number | undefined;
}

export function requestKeyOf(r: IdentifyRequestView | null | undefined): string | null {
  return r ? `${r.jobId ?? ''}:${r.outcome?.finishedAt ?? ''}` : null;
}

const REQUEST_NOUN: Record<IdentifyRequestView['kind'], string> = {
  mbid: 'Your manual match',
  release_group: 'Your manual match',
  discogs: 'Your manual match',
  reidentify: 'Re-identify',
  sweep: 'Identification',
};

const OUTCOME_LINE: Record<IdentifyOutcomeKind, string> = {
  matched: 'matched this album',
  needs_review: 'needs your review',
  unidentified: 'found no match',
  release_group: 'found a release group — pick your release',
  not_found: 'failed — the ID was not found',
  failed: 'failed — the lookup did not finish',
  cancelled: 'was cancelled',
  skipped: 'had nothing to do',
  unknown: 'finished',
};

function time(iso: string | null | undefined): number {
  return iso ? new Date(iso).getTime() : NaN;
}

function requestItem(album: AttentionAlbum, o: AttentionOptions, now: number): AttentionItem | null {
  const r = o.request;
  if (!r) return null;
  const key = requestKeyOf(r);
  if (key && key === o.dismissedRequestKey) return null;
  const owner = r.kind !== 'sweep';
  const noun = REQUEST_NOUN[r.kind] ?? 'Identification';
  if (r.status !== 'done') {
    const state = r.status === 'running' ? 'is running' : r.status === 'retrying' ? 'will retry shortly' : r.jobsAhead === 0 ? 'is next in line' : `is queued · ${r.jobsAhead.toLocaleString()} ahead`;
    return {
      id: 'request', kind: 'request', tone: 'live', line: `${noun} ${state}`,
      action: r.status === 'queued' && owner ? { label: 'Cancel', do: 'cancel-request' } : null,
      interrupts: owner,
    };
  }
  const out = r.outcome;
  if (!out) return null;
  const finished = time(out.finishedAt);
  const decidedAfter = !!album.match?.decidedAt && time(album.match.decidedAt) > finished;
  const actionable = ACTIONABLE_OUTCOMES.has(out.kind) && !decidedAfter;
  if (actionable) {
    // the review row already says this album needs review
    if (out.kind === 'needs_review' && album.state === 'needs_review') return null;
    return {
      id: 'request', kind: 'request', tone: 'attention', line: `${noun} ${OUTCOME_LINE[out.kind]}`,
      action: { label: out.kind === 'release_group' ? 'Pick a release' : 'See why', do: 'expand' },
      interrupts: owner,
    };
  }
  if (now - finished < RECENT_REQUEST_MS) {
    return {
      id: 'request', kind: 'request', tone: out.kind === 'matched' ? 'done' : 'quiet', line: `${noun} ${OUTCOME_LINE[out.kind]}`,
      action: { label: 'Dismiss', do: 'dismiss-request' }, interrupts: false,
    };
  }
  return null;
}

/** Every row the album could show, each marked with whether it interrupts with Maintenance off. */
export function attentionItems(album: AttentionAlbum, o: AttentionOptions = {}): AttentionItem[] {
  const now = o.now ?? Date.now();
  const items: AttentionItem[] = [];
  const open = album.gaps.filter((g) => g.state === 'open');

  const req = requestItem(album, o, now);
  if (req) items.push(req);

  if (album.state === 'needs_review') {
    const n = album.candidates.filter((c) => !c.excluded).length;
    items.push({
      id: 'review', kind: 'review', tone: 'attention',
      line: n > 0 ? `Needs your review · ${plural(n, 'possible release')}` : 'Needs your review',
      action: { label: 'Choose a match', do: 'expand' }, interrupts: true,
    });
  }

  const merge = album.merged ? [] : album.mergeCandidates ?? [];
  if (merge.length > 0) {
    items.push({
      id: 'merge', kind: 'merge', tone: 'attention',
      line: merge.length === 1 ? '1 other album looks like part of this one' : `${merge.length} other albums look like part of this one`,
      action: { label: 'Treat as one album', do: 'merge' }, interrupts: true,
    });
  }

  const done = album.gaps.filter((g) => g.state === 'resolved' && g.acceptedAt && !o.ackedTaskIds?.has(g.id)
    && now - time(g.resolvedAt) < DONE_TASK_WINDOW_MS);
  if (done.length > 0) {
    items.push({
      id: 'task-done', kind: 'task-done', tone: 'done',
      line: done.length === 1 ? 'A task you added is done' : `${done.length} tasks you added are done`,
      action: { label: 'Got it', do: 'ack-tasks' }, interrupts: true, gapIds: done.map((g) => g.id),
    });
  }

  // ---- Maintenance only from here ----

  if (album.state === 'unidentified') {
    items.push({
      id: 'unmatched', kind: 'unmatched', tone: 'quiet', line: 'Not identified',
      action: { label: 'Choose a match', do: 'expand' }, interrupts: false,
    });
  }

  const order = ['incomplete_album', 'duplicate', 'missing_album'];
  const structural = open.filter((g) => g.kind !== 'quality').sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind));
  for (const g of structural) {
    const line = g.kind === 'incomplete_album'
      ? `${plural(missingCount(g.details) || album.missingTracks.length || 1, 'track')} missing`
      : gapLine(g);
    items.push({ id: `gap:${g.id}`, kind: 'gap', tone: 'attention', line, action: { label: 'Review', do: 'expand' }, interrupts: false, gapIds: [g.id] });
  }
  if (!album.gaps.some((g) => g.kind === 'incomplete_album') && album.missingTracks.length > 0) {
    items.push({ id: 'missing', kind: 'missing', tone: 'quiet', line: `${plural(album.missingTracks.length, 'track')} missing`, action: { label: 'Show', do: 'expand' }, interrupts: false });
  }

  const flags: Record<string, unknown> = {};
  for (const g of open) {
    const f = g.kind === 'quality' ? qualityFlagOf(g) : null;
    if (f) flags[f.key] = f.value;
  }
  for (const g of open.filter((x) => x.kind === 'quality')) {
    const f = qualityFlagOf(g);
    if (!f) continue;
    const issue = describeQualityFlag(f.key, f.value, flags, { mixed: !!album.mixed });
    const label = issue.action === 'tags' ? 'Fix tags' : issue.action === 'art' ? 'Fetch art' : issue.action === 'split' ? 'Split by format' : null;
    items.push({
      id: `gap:${g.id}`, kind: 'quality', tone: 'quiet', line: qualityLine(issue.title, issue.count),
      action: label && issue.action ? { label, do: issue.action } : { label: 'Review', do: 'expand' },
      interrupts: false, gapIds: [g.id],
    });
  }

  if (album.duplicates.length > 0 && !structural.some((g) => g.kind === 'duplicate')) {
    items.push({ id: 'duplicates', kind: 'duplicates', tone: 'quiet', line: `${plural(album.duplicates.length, 'other copy', 'other copies')} in your library`, action: { label: 'Show', do: 'expand' }, interrupts: false });
  }

  if (album.hasRelease) {
    const { lengths } = trackDiscrepancies(album.tracks);
    if (lengths.length > 0) {
      items.push({
        id: 'lengths', kind: 'lengths', tone: 'quiet',
        line: `${lengths.length === 1 ? '1 track length differs' : `${lengths.length} track lengths differ`} from the matched edition`,
        action: { label: 'Compare', do: 'editions' }, interrupts: false,
      });
    }
  }

  if (album.merged) {
    items.push({ id: 'merged', kind: 'merged', tone: 'quiet', line: 'Made from several albums', action: { label: 'Split back', do: 'unmerge' }, interrupts: false });
  }

  const tasks = album.gaps.filter((g) => g.state === 'todo');
  if (tasks.length > 0) {
    items.push({ id: 'tasks', kind: 'tasks', tone: 'quiet', line: tasks.length === 1 ? 'On your task list' : `On your task list · ${tasks.length}`, action: { label: 'Show', do: 'expand' }, interrupts: false, gapIds: tasks.map((g) => g.id) });
  }
  const hidden = album.gaps.filter((g) => g.state === 'dismissed');
  if (hidden.length > 0) {
    items.push({ id: 'hidden', kind: 'hidden', tone: 'quiet', line: hidden.length === 1 ? '1 hidden issue' : `${hidden.length} hidden issues`, action: { label: 'Show', do: 'expand' }, interrupts: false, gapIds: hidden.map((g) => g.id) });
  }
  return items;
}

/** "14 tracks without MusicBrainz IDs"-style line from a quality issue's title and count. */
function qualityLine(title: string, count: string | undefined): string {
  return count ? `${title} · ${count}` : title;
}

/** The rows the page shows in the current mode. */
export function visibleAttention(album: AttentionAlbum, maintenance: boolean, o: AttentionOptions = {}): AttentionItem[] {
  const all = attentionItems(album, o);
  return maintenance ? all : all.filter((i) => i.interrupts);
}
