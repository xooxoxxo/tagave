import { afterEach, describe, expect, it } from 'vitest';
import {
  __resetAlbumListMemory, albumsSelectionKey, clearAlbumSelection, getAlbumListMemory, leaveMessage, rangeIds,
  rememberScroll, selectionLeaveRule, selectionSize, setAlbumListMemory, toggled, withIds, type LeaveInput,
} from './albumSelection';

const items = ['a', 'b', 'c', 'd', 'e', 'f'].map((id) => ({ id }));

describe('rangeIds', () => {
  it('takes everything between the anchor and a later target, inclusive', () => {
    expect(rangeIds(items, 'b', 4)).toEqual({ ids: ['b', 'c', 'd', 'e'], anchorFound: true });
  });

  it('works upwards too', () => {
    expect(rangeIds(items, 'e', 1)).toEqual({ ids: ['b', 'c', 'd', 'e'], anchorFound: true });
  });

  it('is just the target when it is the anchor', () => {
    expect(rangeIds(items, 'c', 2)).toEqual({ ids: ['c'], anchorFound: true });
  });

  it('is just the target, without a warning, when nothing was clicked before', () => {
    expect(rangeIds(items, null, 3)).toEqual({ ids: ['d'], anchorFound: true });
  });

  it('flags an anchor that is no longer loaded and takes only the target', () => {
    expect(rangeIds(items, 'zz', 3)).toEqual({ ids: ['d'], anchorFound: false });
  });

  it('spans loaded pages: the range follows the flattened list order', () => {
    const many = Array.from({ length: 250 }, (_, i) => ({ id: `id${i}` }));
    const r = rangeIds(many, 'id95', 104);
    expect(r.ids).toHaveLength(10);
    expect(r.ids[0]).toBe('id95');
    expect(r.ids[9]).toBe('id104');
  });

  it('returns nothing for a target outside the list', () => {
    expect(rangeIds(items, 'a', 99)).toEqual({ ids: [], anchorFound: false });
  });
});

describe('selection sets', () => {
  it('withIds adds without duplicates, keeping order', () => {
    expect(withIds(['a', 'c'], ['b', 'c', 'd'])).toEqual(['a', 'c', 'b', 'd']);
  });

  it('toggled adds and removes', () => {
    expect(toggled(['a'], 'b')).toEqual(['a', 'b']);
    expect(toggled(['a', 'b'], 'a')).toEqual(['b']);
  });

  it('selectionSize counts every matching album under select-all', () => {
    expect(selectionSize({ allMatching: true, total: 1200, ids: ['a'] })).toBe(1200);
    expect(selectionSize({ allMatching: false, total: 1200, ids: ['a', 'b'] })).toBe(2);
  });
});

describe('albumsSelectionKey', () => {
  it('ignores the view and key order, not the filters or sort', () => {
    expect(albumsSelectionKey({ q: 'x', sort: 'year', view: 'list' })).toBe(albumsSelectionKey({ sort: 'year', q: 'x' }));
    expect(albumsSelectionKey({ q: 'x' })).not.toBe(albumsSelectionKey({ q: 'y' }));
    expect(albumsSelectionKey({ q: 'x' })).not.toBe(albumsSelectionKey({ q: 'x', sort: 'year' }));
  });
});

describe('selectionLeaveRule', () => {
  const key = albumsSelectionKey({ genre: ['Jazz'] });
  const base: LeaveInput = { count: 3, selectionKey: key, fromPath: '/albums', toPath: '/artists', toKey: null };

  it('never asks with nothing selected', () => {
    expect(selectionLeaveRule({ ...base, count: 0 })).toBe('allow');
  });

  it('lets you into an album and back to the same list', () => {
    expect(selectionLeaveRule({ ...base, toPath: '/albums/abc-123' })).toBe('allow');
    expect(selectionLeaveRule({ ...base, fromPath: '/albums/abc-123', toPath: '/albums', toKey: key })).toBe('allow');
  });

  it('lets you move from one album to another', () => {
    expect(selectionLeaveRule({ ...base, fromPath: '/albums/a', toPath: '/albums/b' })).toBe('allow');
  });

  it('asks before artists, an artist, jobs, settings and plans', () => {
    for (const toPath of ['/artists', '/artists/42', '/settings/activity', '/jobs', '/settings', '/plans', '/plans/7', '/', '/work']) {
      expect(selectionLeaveRule({ ...base, toPath })).toBe('confirm');
    }
  });

  it('asks from an album page too, since the selection is still waiting', () => {
    expect(selectionLeaveRule({ ...base, fromPath: '/albums/abc', toPath: '/artists/1' })).toBe('confirm');
  });

  it('asks when an album page leads to the list with other filters', () => {
    expect(selectionLeaveRule({ ...base, fromPath: '/albums/abc', toPath: '/albums', toKey: albumsSelectionKey({}) })).toBe('confirm');
  });

  it('keeps the old behaviour for a filter change on the list itself', () => {
    expect(selectionLeaveRule({ ...base, fromPath: '/albums', toPath: '/albums', toKey: albumsSelectionKey({ q: 'x' }) })).toBe('allow');
  });

  it('words the question with the count', () => {
    expect(leaveMessage(1)).toBe('Leave and clear your selection of 1 album?');
    expect(leaveMessage(12)).toBe('Leave and clear your selection of 12 albums?');
  });
});

describe('store', () => {
  afterEach(() => __resetAlbumListMemory());

  it('keeps the selection and scroll until cleared', () => {
    setAlbumListMemory((p) => ({ ...p, queryKey: 'k', ids: ['a', 'b'], anchorId: 'b' }));
    rememberScroll('k', 900);
    rememberScroll('other', 5);
    expect(getAlbumListMemory()).toMatchObject({ queryKey: 'k', ids: ['a', 'b'], anchorId: 'b', scrollTop: 900 });
    clearAlbumSelection();
    expect(getAlbumListMemory()).toMatchObject({ queryKey: 'k', ids: [], allMatching: false, anchorId: null, scrollTop: 900 });
  });
});
