import type { IdentifyRequestView } from '@liner/shared';
import { describe, expect, it } from 'vitest';
import {
  albumSearchRedirect,
  attentionItems,
  candidateLengths,
  formatDelta,
  issuesTargetRow,
  lengthDiscrepancy,
  LENGTH_TOLERANCE_MS,
  parseAlbumSearch,
  requestKeyOf,
  trackDiscrepancies,
  visibleAttention,
  type AttentionAlbum,
  type AttentionGap,
} from './albumAttention';

const NOW = Date.parse('2026-09-29T12:00:00Z');
const daysAgo = (d: number) => new Date(NOW - d * 86_400_000).toISOString();

function album(over: Partial<AttentionAlbum> = {}): AttentionAlbum {
  return {
    state: 'matched',
    merged: false,
    mixed: false,
    mergeCandidates: [],
    candidates: [],
    gaps: [],
    missingTracks: [],
    duplicates: [],
    tracks: [],
    hasRelease: true,
    match: { decidedAt: daysAgo(30) },
    ...over,
  };
}
const gap = (over: Partial<AttentionGap> & Pick<AttentionGap, 'id' | 'kind'>): AttentionGap => ({ state: 'open', details: {}, ...over });
const quality = (id: string, flag: string, value: unknown = true) => gap({ id, kind: 'quality', flag, details: { flags: { [flag]: value } } });
const request = (over: Partial<IdentifyRequestView>): IdentifyRequestView => ({
  status: 'done', jobId: 'j1', kind: 'mbid', pinned: 'abc', createdAt: daysAgo(1), startedAt: null, jobsAhead: 0, outcome: null, ...over,
});
const ids = (a: AttentionAlbum, maintenance: boolean, o = {}) => visibleAttention(a, maintenance, { now: NOW, ...o }).map((i) => i.id);

describe('mode gating: what interrupts with Maintenance off', () => {
  it('a clean matched album shows nothing', () => {
    expect(ids(album(), false)).toEqual([]);
    expect(ids(album(), true)).toEqual([]);
  });

  it('quality-only issues stay silent until Maintenance is on', () => {
    const a = album({ gaps: [quality('q1', 'missingMbIds', { missing: [0, 1, 2] }), quality('q2', 'noEmbeddedArt'), quality('q3', 'trackNumberIssues', { issues: ['duplicate number 3 (tracks 3, 4)'] })] });
    expect(ids(a, false)).toEqual([]);
    expect(ids(a, true)).toEqual(['gap:q1', 'gap:q2', 'gap:q3']);
  });

  it('missing tracks, duplicates, tasks on the list and hidden rows wait for Maintenance', () => {
    const a = album({
      gaps: [
        gap({ id: 'g1', kind: 'incomplete_album', details: { have: 7, want: 10 } }),
        gap({ id: 'g2', kind: 'duplicate', details: { count: 2 } }),
        gap({ id: 't1', kind: 'incomplete_album', state: 'todo', acceptedAt: daysAgo(3) }),
        gap({ id: 'h1', kind: 'quality', flag: 'noCover', state: 'dismissed', dismissReason: 'not_a_problem', details: { flags: { noCover: true } } }),
      ],
      missingTracks: [{}, {}, {}],
      duplicates: [{}],
    });
    expect(ids(a, false)).toEqual([]);
    expect(ids(a, true)).toEqual(['gap:g1', 'gap:g2', 'tasks', 'hidden']);
  });

  it('missing tracks already accepted as "not a problem" are hidden rows, not a missing row', () => {
    const a = album({ gaps: [gap({ id: 'g1', kind: 'incomplete_album', state: 'dismissed', dismissReason: 'not_a_problem' })], missingTracks: [{}, {}] });
    expect(ids(a, false)).toEqual([]);
    expect(ids(a, true)).toEqual(['hidden']);
  });

  it('an album needing review interrupts with "Choose a match"', () => {
    const a = album({ state: 'needs_review', candidates: [{ excluded: false }, { excluded: false }, { excluded: true }], match: null });
    const [row] = visibleAttention(a, false, { now: NOW });
    expect(row).toMatchObject({ id: 'review', tone: 'attention', line: 'Needs your review · 2 possible releases', action: { label: 'Choose a match', do: 'expand' } });
  });

  it('a likely split album interrupts with "Treat as one album"', () => {
    const a = album({ mergeCandidates: [{ id: 'x', trackCount: 3 }] });
    expect(visibleAttention(a, false, { now: NOW })).toEqual([
      expect.objectContaining({ id: 'merge', line: '1 other album looks like part of this one', action: { label: 'Treat as one album', do: 'merge' } }),
    ]);
    expect(visibleAttention(album({ mergeCandidates: [{ id: 'x', trackCount: 3 }, { id: 'y', trackCount: 1 }] }), false, { now: NOW })[0]?.line)
      .toBe('2 other albums look like part of this one');
  });

  it('a merged album offers the split back only in Maintenance', () => {
    const a = album({ merged: true, mergeCandidates: [{ id: 'x', trackCount: 3 }] });
    expect(ids(a, false)).toEqual([]);
    expect(ids(a, true)).toEqual(['merged']);
  });

  it('a failed owner request interrupts; a failed sweep does not', () => {
    const failed = request({ outcome: { kind: 'not_found', message: 'No such release', finishedAt: daysAgo(0.5) } });
    expect(ids(album({ state: 'unidentified', match: null }), false, { request: failed })).toEqual(['request']);
    const sweep = { ...failed, kind: 'sweep' as const };
    expect(ids(album({ state: 'unidentified', match: null }), false, { request: sweep })).toEqual([]);
    expect(ids(album({ state: 'unidentified', match: null }), true, { request: sweep })).toEqual(['request', 'unmatched']);
  });

  it('a failed request stops interrupting once the album was decided after it, or when dismissed', () => {
    const failed = request({ outcome: { kind: 'failed', message: 'Timed out', finishedAt: daysAgo(2) } });
    expect(ids(album({ match: { decidedAt: daysAgo(1) } }), false, { request: failed })).toEqual([]);
    expect(ids(album({ state: 'unidentified', match: null }), false, { request: failed, dismissedRequestKey: requestKeyOf(failed) })).toEqual([]);
  });

  it('a release-group pick asks to pick a release', () => {
    const rg = request({ kind: 'release_group', outcome: { kind: 'release_group', message: 'Pick one', finishedAt: daysAgo(0.1) } });
    const [row] = visibleAttention(album({ state: 'unidentified', match: null }), false, { request: rg, now: NOW });
    expect(row?.action).toEqual({ label: 'Pick a release', do: 'expand' });
  });

  it('a needs-review outcome folds into the review row instead of doubling it', () => {
    const r = request({ outcome: { kind: 'needs_review', message: 'Close call', finishedAt: daysAgo(0.1) } });
    expect(ids(album({ state: 'needs_review', match: null }), false, { request: r })).toEqual(['review']);
  });

  it('a running owner request shows (the owner just asked); a queued one offers Cancel', () => {
    const queued = request({ status: 'queued', jobsAhead: 4, outcome: null });
    const [row] = visibleAttention(album(), false, { request: queued, now: NOW });
    expect(row).toMatchObject({ id: 'request', tone: 'live', line: 'Your manual match is queued · 4 ahead', action: { do: 'cancel-request' } });
    const running = request({ status: 'running', kind: 'reidentify', outcome: null });
    expect(visibleAttention(album(), false, { request: running, now: NOW })[0]).toMatchObject({ line: 'Re-identify is running', action: null });
  });

  it('a recent matched request is for the record: Maintenance only', () => {
    const ok = request({ outcome: { kind: 'matched', message: 'Matched', finishedAt: daysAgo(1) } });
    expect(ids(album(), false, { request: ok })).toEqual([]);
    expect(ids(album(), true, { request: ok })).toEqual(['request']);
    const old = request({ outcome: { kind: 'matched', message: 'Matched', finishedAt: daysAgo(10) } });
    expect(ids(album(), true, { request: old })).toEqual([]);
  });

  it('a resolved task interrupts until acknowledged or two weeks old', () => {
    const done = gap({ id: 't9', kind: 'incomplete_album', state: 'resolved', acceptedAt: daysAgo(20), resolvedAt: daysAgo(2) });
    expect(ids(album({ gaps: [done] }), false)).toEqual(['task-done']);
    expect(ids(album({ gaps: [done] }), false, { ackedTaskIds: new Set(['t9']) })).toEqual([]);
    const stale = { ...done, resolvedAt: daysAgo(15) };
    expect(ids(album({ gaps: [stale] }), false)).toEqual([]);
    // resolved by a scan but never on the task list: nothing to report
    expect(ids(album({ gaps: [{ ...done, acceptedAt: null }] }), false)).toEqual([]);
  });
});

describe('attention strip derivation', () => {
  it('orders decisions first, then Maintenance detail', () => {
    const a = album({
      state: 'needs_review',
      candidates: [{ excluded: false }],
      mergeCandidates: [{ id: 'x', trackCount: 2 }],
      gaps: [quality('q1', 'missingMbIds', { missing: [0] }), gap({ id: 'g1', kind: 'incomplete_album', details: { have: 1, want: 5 } })],
      match: null,
    });
    expect(ids(a, true)).toEqual(['review', 'merge', 'gap:g1', 'gap:q1']);
  });

  it('words each row as one line with one action', () => {
    const a = album({
      gaps: [
        gap({ id: 'g1', kind: 'incomplete_album', details: { have: 6, want: 10 } }),
        quality('q1', 'missingMbIds', { missing: Array.from({ length: 14 }, (_, i) => i) }),
        quality('q2', 'noCover'),
        quality('q3', 'noEmbeddedArt'),
      ],
    });
    const rows = visibleAttention(a, true, { now: NOW });
    expect(rows.map((r) => [r.line, r.action?.label])).toEqual([
      ['4 tracks missing', 'Review'],
      ['Missing MusicBrainz IDs · 14 tracks', 'Fix tags'],
      ['No cover art', 'Fetch art'],
      ['No embedded art', 'Review'],
    ]);
  });

  it('lists length differences with the matched edition in Maintenance, pointing to the comparison', () => {
    const tracks = [
      { title: 'A', durationMs: 200_000, canonicalTitle: 'A', canonicalDurationMs: 200_000 + LENGTH_TOLERANCE_MS + 1 },
      { title: 'B', durationMs: 180_000, canonicalTitle: 'B', canonicalDurationMs: 181_000 },
    ];
    expect(visibleAttention(album({ tracks }), true, { now: NOW })).toEqual([
      expect.objectContaining({ id: 'lengths', line: '1 track length differs from the matched edition', action: { label: 'Compare', do: 'editions' } }),
    ]);
    expect(ids(album({ tracks }), false)).toEqual([]);
    expect(ids(album({ tracks, hasRelease: false }), true)).toEqual([]);
  });

  it('keeps ids stable across refetches, so an open row stays open', () => {
    const a = album({ gaps: [quality('q1', 'noCover')] });
    expect(attentionItems(a, { now: NOW })[0]?.id).toBe(attentionItems({ ...a }, { now: NOW + 1000 })[0]?.id);
  });
});

describe('length discrepancy tolerance', () => {
  it('ignores differences within the tolerance', () => {
    expect(lengthDiscrepancy(200_000, 200_000)).toBeNull();
    expect(lengthDiscrepancy(200_000, 200_000 + LENGTH_TOLERANCE_MS)).toBeNull();
    expect(lengthDiscrepancy(200_000, 200_000 - LENGTH_TOLERANCE_MS)).toBeNull();
  });

  it('reports the signed difference beyond it', () => {
    expect(lengthDiscrepancy(209_000, 200_000)).toBe(9000);
    expect(lengthDiscrepancy(195_000, 200_000)).toBe(-5000);
    expect(lengthDiscrepancy(200_000, 205_000, 10_000)).toBeNull();
  });

  it('says nothing when a length is unknown', () => {
    expect(lengthDiscrepancy(null, 200_000)).toBeNull();
    expect(lengthDiscrepancy(200_000, null)).toBeNull();
    expect(lengthDiscrepancy(0, 200_000)).toBeNull();
  });

  it('formats the difference', () => {
    expect(formatDelta(9000)).toBe('+0:09');
    expect(formatDelta(-65_000)).toBe('−1:05');
  });

  it('finds tracks off in length or title', () => {
    const t = (title: string, canonicalTitle: string, d: number, c: number) => ({ title, canonicalTitle, durationMs: d, canonicalDurationMs: c });
    const r = trackDiscrepancies([t('one', 'One', 100_000, 100_500), t('Two', 'Two (Live)', 100_000, 100_000), t('Three', 'Three', 100_000, 120_000)]);
    expect(r.lengths.map((x) => x.title)).toEqual(['Three']);
    expect(r.titles.map((x) => x.title)).toEqual(['Two']);
  });
});

describe('album tabs: old ids redirect', () => {
  it('keeps current tabs', () => {
    expect(parseAlbumSearch({})).toEqual({});
    expect(parseAlbumSearch({ tab: 'editions' })).toEqual({ tab: 'editions' });
    expect(parseAlbumSearch({ tab: 'about' })).toEqual({ tab: 'about' });
    expect(parseAlbumSearch({ tab: 'activity' })).toEqual({ tab: 'activity' });
    expect(albumSearchRedirect({ tab: 'editions' })).toBeNull();
    expect(albumSearchRedirect({})).toBeNull();
  });

  it('sends Library health to the album with the strip open (Maintenance)', () => {
    expect(albumSearchRedirect({ tab: 'care' })).toEqual({ issues: true });
    expect(albumSearchRedirect({ tab: 'health' })).toEqual({ issues: true });
    expect(albumSearchRedirect({ tab: 'library-health' })).toEqual({ issues: true });
  });

  it('sends Reviews and Album details to About, and the old album face to Tracks', () => {
    expect(albumSearchRedirect({ tab: 'reviews' })).toEqual({ tab: 'about' });
    expect(albumSearchRedirect({ tab: 'details' })).toEqual({ tab: 'about' });
    expect(albumSearchRedirect({ tab: 'album' })).toEqual({});
    expect(albumSearchRedirect({ tab: 'tracks' })).toEqual({});
  });

  it('drops unknown tabs and reads the issues flag', () => {
    expect(parseAlbumSearch({ tab: 'nonsense' })).toEqual({});
    expect(albumSearchRedirect({ tab: 'nonsense' })).toBeNull();
    expect(parseAlbumSearch({ issues: 'true' })).toEqual({ issues: true });
    expect(parseAlbumSearch({ issues: true, tab: 'about' })).toEqual({ tab: 'about', issues: true });
    expect(parseAlbumSearch({ issues: 'no' })).toEqual({});
  });
});

describe('?issues deep links open the row they are about', () => {
  const a = album({
    gaps: [
      gap({ id: 'g1', kind: 'incomplete_album', details: { have: 7, want: 10 } }),
      quality('q1', 'noEmbeddedArt'),
      gap({ id: 't1', kind: 'incomplete_album', state: 'todo', acceptedAt: daysAgo(3) }),
      gap({ id: 't2', kind: 'quality', flag: 'noCover', state: 'todo', acceptedAt: daysAgo(2), details: { flags: { noCover: true } } }),
    ],
  });
  const items = attentionItems(a, { now: NOW });

  it('parses a target gap id or "tasks", and keeps plain links as true', () => {
    expect(parseAlbumSearch({ issues: 't2' })).toEqual({ issues: 't2' });
    expect(parseAlbumSearch({ issues: 'tasks' })).toEqual({ issues: 'tasks' });
    expect(parseAlbumSearch({ issues: 'true' })).toEqual({ issues: true });
    expect(parseAlbumSearch({ issues: '<script>' })).toEqual({});
  });

  it('a task link opens "On your task list", not the first issue', () => {
    expect(issuesTargetRow(items, 't2')?.id).toBe('tasks');
    expect(issuesTargetRow(items, 'tasks')?.id).toBe('tasks');
  });

  it('an issue link opens that issue', () => {
    expect(issuesTargetRow(items, 'q1')?.id).toBe('gap:q1');
    expect(issuesTargetRow(items, 'g1')?.id).toBe('gap:g1');
  });

  it('a plain or unknown target falls back to the first Maintenance-only row', () => {
    expect(issuesTargetRow(items, true)?.id).toBe('gap:g1');
    expect(issuesTargetRow(items, 'gone')?.id).toBe('gap:g1');
    expect(issuesTargetRow(items, undefined)).toBeUndefined();
  });
});

describe('candidate comparison uses the same tolerance', () => {
  const local = [
    { id: 'a', discNo: 1, trackNo: 1, title: 'One', durationMs: 200_000 },
    { id: 'b', discNo: 1, trackNo: 2, title: 'Two', durationMs: 180_000 },
    { id: 'c', discNo: 2, trackNo: 1, title: 'Three', durationMs: 240_000 },
    { id: 'd', discNo: 1, trackNo: null, title: 'Hidden', durationMs: 60_000 },
  ];

  it('marks only lengths beyond the tolerance, paired by disc and position', () => {
    const r = candidateLengths(local, [
      { disc: 1, position: 1, title: 'One', lengthMs: 200_000 + LENGTH_TOLERANCE_MS },
      { disc: 1, position: 2, title: 'Two', lengthMs: 190_000 },
      { disc: 2, position: 1, title: 'Three', lengthMs: 236_000 },
    ]);
    expect(r?.compared).toBe(3);
    expect(r?.differing.map((x) => x.key)).toEqual(['b', 'c']);
    expect(r?.differing[0]?.delta).toBe(-10_000);
  });

  it('is null when the release has no tracks, and skips tracks without a length', () => {
    expect(candidateLengths(local, undefined)).toBeNull();
    expect(candidateLengths(local, [])).toBeNull();
    const r = candidateLengths(local, [{ disc: 1, position: 1, title: 'One', lengthMs: null }]);
    expect(r?.compared).toBe(0);
    expect(r?.differing).toEqual([]);
  });
});
