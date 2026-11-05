import { describe, expect, it } from 'vitest';
import { attentionItems, issuesTargetRow, parseAlbumSearch, type AttentionAlbum, type AttentionItem } from './albumAttention';
import { EMPTY_TICKS, countsToward, inspectorRows, meterFill, meterLabel, reconcileTicks, summaryLabel } from './maintenanceInspector';

const row = (id: string, over: Partial<AttentionItem> = {}): AttentionItem => ({
  id, kind: 'gap', tone: 'attention', line: id, action: { label: 'Review', do: 'expand' }, interrupts: false, ...over,
});

const album = (over: Partial<AttentionAlbum> = {}): AttentionAlbum => ({
  state: 'matched', candidates: [], gaps: [], missingTracks: [], duplicates: [], tracks: [], hasRelease: true, ...over,
});

describe('what counts toward the meter', () => {
  it('issues count; the record rows and a running request do not', () => {
    expect(countsToward(row('gap:1'))).toBe(true);
    expect(countsToward(row('quality', { kind: 'quality', tone: 'quiet' }))).toBe(true);
    expect(countsToward(row('merged', { kind: 'merged', tone: 'quiet' }))).toBe(false);
    expect(countsToward(row('tasks', { kind: 'tasks', tone: 'quiet' }))).toBe(false);
    expect(countsToward(row('hidden', { kind: 'hidden', tone: 'quiet' }))).toBe(false);
    expect(countsToward(row('task-done', { kind: 'task-done', tone: 'done' }))).toBe(false);
    expect(countsToward(row('request', { kind: 'request', tone: 'live' }))).toBe(false);
    expect(countsToward(row('request', { kind: 'request', tone: 'attention' }))).toBe(true);
  });

  it('a matched album with three issues: "0 of 3", "To fix · 3"', () => {
    const items = [row('gap:a'), row('gap:b'), row('gap:c', { kind: 'quality', tone: 'quiet' }), row('hidden', { kind: 'hidden', tone: 'quiet' })];
    const { meter } = inspectorRows(items, reconcileTicks(EMPTY_TICKS, items, 1));
    expect(meter).toEqual({ done: 0, total: 3, left: 3 });
    expect(meterLabel(meter)).toBe('0 of 3');
    expect(summaryLabel(meter)).toBe('To fix · 3');
    expect(meterFill(meter)).toBe(0);
  });

  it('nothing left: "Nothing to fix", "Maintenance", the meter full', () => {
    const items = [row('hidden', { kind: 'hidden', tone: 'quiet' })];
    const { meter } = inspectorRows(items, reconcileTicks(EMPTY_TICKS, items, 1));
    expect(meter).toEqual({ done: 0, total: 0, left: 0 });
    expect(meterLabel(meter)).toBe('Nothing to fix');
    expect(summaryLabel(meter)).toBe('Maintenance');
    expect(meterFill(meter)).toBe(1);
  });
});

describe('rows tick off', () => {
  const three = [row('gap:a'), row('gap:b'), row('gap:c')];

  it('a fixed row ticks off in place and the meter moves: "1 of 3"', () => {
    let t = reconcileTicks(EMPTY_TICKS, three, 1);
    t = reconcileTicks(t, [three[0]!, three[2]!], 2);
    const { rows, meter } = inspectorRows([three[0]!, three[2]!], t);
    expect(rows.map((r) => [r.item.id, r.ticked])).toEqual([['gap:a', false], ['gap:b', true], ['gap:c', false]]);
    expect(meter).toEqual({ done: 1, total: 3, left: 2 });
    expect(meterLabel(meter)).toBe('1 of 3');
    expect(summaryLabel(meter)).toBe('To fix · 2');
  });

  it('a dismissal on the page (no new read) ticks it off too', () => {
    let t = reconcileTicks(EMPTY_TICKS, three, 5);
    t = reconcileTicks(t, three.slice(1), 5);
    expect(inspectorRows(three.slice(1), t).rows[0]).toMatchObject({ ticked: true, item: { id: 'gap:a' } });
  });

  it('a ticked row stays through changes on the page, then leaves on the next read', () => {
    let t = reconcileTicks(EMPTY_TICKS, three, 1);
    t = reconcileTicks(t, three.slice(1), 2);
    t = reconcileTicks(t, three.slice(1), 2);
    expect(t.ticked.map((x) => x.item.id)).toEqual(['gap:a']);
    t = reconcileTicks(t, three.slice(1), 3);
    expect(t.ticked).toEqual([]);
    const { rows, meter } = inspectorRows(three.slice(1), t);
    expect(rows.map((r) => r.item.id)).toEqual(['gap:b', 'gap:c']);
    expect(meter).toEqual({ done: 0, total: 2, left: 2 });
  });

  it('every row fixed: "3 of 3" until they leave, then "Nothing to fix"', () => {
    let t = reconcileTicks(EMPTY_TICKS, three, 1);
    t = reconcileTicks(t, [], 2);
    const first = inspectorRows([], t);
    expect(first.rows.every((r) => r.ticked)).toBe(true);
    expect(first.meter).toEqual({ done: 3, total: 3, left: 0 });
    expect(meterLabel(first.meter)).toBe('Nothing to fix');
    t = reconcileTicks(t, [], 3);
    expect(inspectorRows([], t).rows).toEqual([]);
  });

  it('a row that comes back is a row again, not ticked', () => {
    let t = reconcileTicks(EMPTY_TICKS, three, 1);
    t = reconcileTicks(t, three.slice(1), 1);
    t = reconcileTicks(t, three, 1);
    const { rows, meter } = inspectorRows(three, t);
    expect(rows.filter((r) => r.ticked)).toEqual([]);
    expect(meter.left).toBe(3);
  });

  it('a running request that ends has nothing to tick off', () => {
    const live = row('request', { kind: 'request', tone: 'live' });
    let t = reconcileTicks(EMPTY_TICKS, [live, three[0]!], 1);
    t = reconcileTicks(t, [three[0]!], 2);
    expect(t.ticked).toEqual([]);
  });

  it('from the album itself: a merge suggestion that is accepted ticks off', () => {
    const before = attentionItems(album({ state: 'unidentified', mergeCandidates: [{ id: 'x', trackCount: 3 }] }));
    expect(before.map((i) => i.id)).toEqual(['merge', 'unmatched']);
    const after = attentionItems(album({ state: 'unidentified', merged: true }));
    let t = reconcileTicks(EMPTY_TICKS, before, 1);
    t = reconcileTicks(t, after, 2);
    const { rows, meter } = inspectorRows(after, t);
    expect(rows.find((r) => r.item.id === 'merge')?.ticked).toBe(true);
    // merged is for the record; unmatched still counts
    expect(meter).toEqual({ done: 1, total: 2, left: 1 });
  });
});

describe('deep links open the item in the inspector', () => {
  it('the old ?tab=care opens the first Maintenance row', () => {
    const search = parseAlbumSearch({ tab: 'care' });
    expect(search).toEqual({ issues: true });
    const items = [row('merge', { kind: 'merge', interrupts: true }), row('gap:g1', { gapIds: ['g1'] })];
    expect(issuesTargetRow(items, search.issues)?.id).toBe('gap:g1');
  });

  it('?issues=<gap id> opens the row that holds that gap; ?issues=tasks opens the task list', () => {
    const items = [row('gap:g1', { gapIds: ['g1'] }), row('tasks', { kind: 'tasks', tone: 'quiet', gapIds: ['t1'] })];
    expect(issuesTargetRow(items, parseAlbumSearch({ issues: 'g1' }).issues)?.id).toBe('gap:g1');
    expect(issuesTargetRow(items, parseAlbumSearch({ issues: 'tasks' }).issues)?.id).toBe('tasks');
  });

  it('?tab=editions, ?tab=reviews open a section', () => {
    expect(parseAlbumSearch({ tab: 'editions' })).toEqual({ tab: 'editions' });
    expect(parseAlbumSearch({ tab: 'reviews' })).toEqual({ tab: 'about' });
    expect(parseAlbumSearch({ tab: 'nonsense' })).toEqual({});
  });
});
