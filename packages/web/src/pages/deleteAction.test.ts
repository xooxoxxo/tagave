import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import type { DeletionGroup } from '@tagave/shared';
import { albumKey, deleteLabel, deletedNote, trackKey } from './deleteAction';
import { hiddenRemovals, isPendingRemoval, scheduleRemoval, undoRemoval } from './collectionRemoval';
import { groupWhat } from './DeletingPage';
import { SegmentedControl } from '../components/ui/SegmentedControl';

describe('the one delete item', () => {
  it('says what the mode does, never both', () => {
    expect(deleteLabel('mark')).toBe('Mark for deletion');
    expect(deleteLabel('trash')).toBe('Move to trash');
    expect(deletedNote('mark')).toBe('Marked for deletion');
    expect(deletedNote('trash')).toBe('Moved to trash');
  });

  it('keys songs and albums apart from collection records in the shared Undo store', () => {
    expect(trackKey('t1')).toBe('delete:track:t1');
    expect(albumKey('t1')).toBe('delete:album:t1');
  });
});

describe('Undo for five seconds before the request is sent', () => {
  afterEach(() => vi.useRealTimers());

  it('hides at once, sends nothing until the time is up; Undo brings it back with no request', async () => {
    vi.useFakeTimers();
    const commit = vi.fn(async () => undefined);
    scheduleRemoval(albumKey('a1'), commit, vi.fn());
    expect(hiddenRemovals().has(albumKey('a1'))).toBe(true);
    vi.advanceTimersByTime(4999);
    expect(commit).not.toHaveBeenCalled();
    expect(undoRemoval(albumKey('a1'))).toBe(true);
    expect(hiddenRemovals().has(albumKey('a1'))).toBe(false);
    vi.advanceTimersByTime(5000);
    expect(commit).not.toHaveBeenCalled();
  });

  it('sends after five seconds, then shows it again only if the server refused', async () => {
    vi.useFakeTimers();
    const failed = vi.fn();
    scheduleRemoval(trackKey('t9'), async () => { throw new Error('no'); }, failed);
    vi.advanceTimersByTime(5000);
    expect(isPendingRemoval(trackKey('t9'))).toBe(false);
    await vi.waitFor(() => expect(failed).toHaveBeenCalled());
    expect(hiddenRemovals().has(trackKey('t9'))).toBe(false);
  });
});

describe('Library care › Deleting rows', () => {
  const g = (over: Partial<DeletionGroup>): DeletionGroup => ({
    key: 'k', albumId: 'a', title: 'Album', artist: 'Artist', fileIds: ['f1'], trackTitle: 'One', wholeAlbum: false,
    createdAt: '2026-11-02T10:00:00Z', state: 'marked', error: null, ...over,
  });
  it('Album, 1 song, n songs', () => {
    expect(groupWhat(g({ wholeAlbum: true, fileIds: ['a', 'b'] }))).toBe('Album');
    expect(groupWhat(g({}))).toBe('1 song');
    expect(groupWhat(g({ fileIds: ['a', 'b', 'c'] }))).toBe('3 songs');
  });
});

describe('Settings › Library › Deleting', () => {
  it('Trash is shown but cannot be chosen while no music folder is writable', () => {
    const html = renderToStaticMarkup(createElement(SegmentedControl<'mark' | 'trash'>, {
      label: 'Deleting', value: 'mark', onChange: () => undefined,
      options: [{ value: 'mark', label: 'Mark' }, { value: 'trash', label: 'Trash', disabled: true }],
    }));
    const inputs = html.match(/<input[^>]*>/g) ?? [];
    expect(inputs.find((i) => i.includes('value="trash"'))).toMatch(/disabled=""/);
    expect(inputs.find((i) => i.includes('value="mark"'))).not.toMatch(/disabled/);
    expect(html.match(/data-disabled=""/g)).toHaveLength(1);
  });
});
