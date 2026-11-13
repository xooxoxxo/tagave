/**
 * Physical collection (owner, 2026-10-28): the copies of one release are one
 * row, removing a record is Undo for a few seconds and then gone (no Removed
 * list), and there are no Physical only / Both lists: each row carries its
 * media and a drive when it is on disk.
 */
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { groupCopies, mediaOf } from './collectionGroups';
import { flushRemovals, hiddenRemovals, isPendingRemoval, scheduleRemoval, undoRemoval, UNDO_MS } from './collectionRemoval';

const source = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const copy = (id: string, discogsReleaseId: number, duplicateOf: string | null = null, pushState: string | null = 'synced') => ({ id, discogsReleaseId, duplicateOf, pushState });

describe('collection rows: one per release', () => {
  it('two copies of a release are one row, the kept copy leading, the accidental extra noted', () => {
    const groups = groupCopies([copy('a', 1), copy('b', 2), copy('c', 1, 'a')]);
    expect(groups.map((g) => g.lead.id)).toEqual(['a', 'b']);
    expect(groups[0]!.copies.map((c) => c.id)).toEqual(['a', 'c']);
    expect(groups[0]!.extras.map((c) => c.id)).toEqual(['c']);
    expect(groups[1]!.extras).toEqual([]);
  });

  it('the extra listed first still does not lead, and the row sits where its lead does', () => {
    const groups = groupCopies([copy('new', 5, 'old'), copy('x', 6), copy('old', 5)]);
    expect(groups.map((g) => g.lead.id)).toEqual(['x', 'old']);
    expect(groups[1]!.copies.map((c) => c.id)).toEqual(['old', 'new']);
    // removing the extra leaves the order as it was
    expect(groupCopies([copy('new', 5, 'old'), copy('x', 6), copy('old', 5)], new Set(['new'])).map((g) => g.lead.id)).toEqual(['x', 'old']);
  });

  it('a record waiting out its Undo, or on its way off Discogs, is not listed', () => {
    const groups = groupCopies([copy('a', 1), copy('c', 1, 'a'), copy('d', 3, null, 'removing')], new Set(['c']));
    expect(groups).toHaveLength(1);
    expect(groups[0]!.copies.map((c) => c.id)).toEqual(['a']);
  });

  it('one marker per medium', () => {
    expect(mediaOf('2×Vinyl, CD')).toEqual(['2×Vinyl', 'CD']);
    expect(mediaOf('2×CD')).toEqual(['2×CD']);
    expect(mediaOf(null)).toEqual([]);
  });
});

describe('removing a record: Undo, then gone', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('hides at once and sends nothing until the Undo window is over', async () => {
    vi.useFakeTimers();
    const commit = vi.fn(async () => undefined);
    scheduleRemoval('r1', commit, vi.fn());
    expect(hiddenRemovals().has('r1')).toBe(true);
    vi.advanceTimersByTime(UNDO_MS - 1);
    expect(commit).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(commit).toHaveBeenCalledWith({ keepalive: false });
    await vi.runAllTimersAsync();
    // the list has refetched without it: no longer held hidden
    expect(hiddenRemovals().has('r1')).toBe(false);
    expect(isPendingRemoval('r1')).toBe(false);
  });

  it('Undo brings it back and nothing is ever sent', () => {
    vi.useFakeTimers();
    const commit = vi.fn(async () => undefined);
    scheduleRemoval('r2', commit, vi.fn());
    expect(undoRemoval('r2')).toBe(true);
    expect(hiddenRemovals().has('r2')).toBe(false);
    vi.advanceTimersByTime(UNDO_MS * 2);
    expect(commit).not.toHaveBeenCalled();
    expect(undoRemoval('r2')).toBe(false);
  });

  it('a removal the server refuses shows the record again and says so', async () => {
    vi.useFakeTimers();
    const onFailed = vi.fn();
    scheduleRemoval('r3', async () => { throw { detail: 'nope' }; }, onFailed);
    await vi.advanceTimersByTimeAsync(UNDO_MS);
    expect(onFailed).toHaveBeenCalledWith({ detail: 'nope' });
    expect(hiddenRemovals().has('r3')).toBe(false);
  });

  it('leaving the page sends what is still waiting, with keepalive', () => {
    vi.useFakeTimers();
    const commit = vi.fn(async () => undefined);
    scheduleRemoval('r4', commit, vi.fn());
    flushRemovals();
    expect(commit).toHaveBeenCalledWith({ keepalive: true });
    expect(isPendingRemoval('r4')).toBe(false);
  });
});

describe('the page', () => {
  const tsx = source('./CollectionPage.tsx');

  it('lists every record, Unmapped and (while any) Duplicates: no Physical only, Both or Removed', () => {
    expect(tsx).toMatch(/\{ key: 'active', label: 'All' \}/);
    expect(tsx).toMatch(/key: 'unmapped', label: 'Unmapped'/);
    expect(tsx).not.toMatch(/Physical only'|label: 'Both'|label: 'Removed'/);
  });

  it('removing asks nothing and offers Undo for the window', () => {
    expect(tsx).toMatch(/scheduleRemoval\(/);
    expect(tsx).toMatch(/action: \{ label: 'Undo', onClick: \(\) => void undoRemoval\(target\.id\) \}, durationMs: UNDO_MS/);
    expect(tsx).not.toMatch(/Remove the duplicate copy\?/);
  });

  it('copies and media are small badges on the facts line; "I own both" lives in the row menu', () => {
    expect(tsx).toMatch(/<Badge size="sm" tone=\{extra \? 'warning' : 'neutral'\}>\{copies\.length\} copies<\/Badge>/);
    expect(tsx).toMatch(/mediaOf\(item\.format\)\.map\(\(m\) => <Badge key=\{m\} size="sm">/);
    expect(tsx).toMatch(/key: 'keep-both', label: 'I own both'/);
    expect(tsx).not.toMatch(/>I own both<\/Button>/);
    const css = source('./CollectionPage.module.css');
    expect(css).toMatch(/\.details \{[^}]*align-items: baseline;/);
    expect(css).not.toMatch(/\.flag/);
  });

  it('the Discogs credit stays', () => {
    expect(tsx).toMatch(/Data provided by <a href="https:\/\/www\.discogs\.com"/);
  });
});
