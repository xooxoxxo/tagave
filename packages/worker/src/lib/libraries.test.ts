import { describe, expect, it, vi } from 'vitest';
import { libraryIdsFor, pinnedLibraryId } from './libraries.js';

describe('pinnedLibraryId', () => {
  it('treats an unset, empty or blank value as no pin', () => {
    expect(pinnedLibraryId({})).toBeUndefined();
    expect(pinnedLibraryId({ LINER_LIBRARY_ID: '' })).toBeUndefined();
    expect(pinnedLibraryId({ LINER_LIBRARY_ID: '  ' })).toBeUndefined();
  });

  it('returns a set id', () => {
    expect(pinnedLibraryId({ LINER_LIBRARY_ID: ' abc ' })).toBe('abc');
  });
});

describe('libraryIdsFor', () => {
  function fakeDb(ids: string[]) {
    const orderBy = vi.fn(async () => ids.map((id) => ({ id })));
    const db = { select: () => ({ from: () => ({ orderBy }) }) };
    return { ctx: { db } as any, orderBy };
  }

  it('uses the id the job names without asking the database', async () => {
    const { ctx, orderBy } = fakeDb(['x', 'y']);
    expect(await libraryIdsFor(ctx, 'lib-1')).toEqual(['lib-1']);
    expect(orderBy).not.toHaveBeenCalled();
  });

  it('runs for every library when the job names none', async () => {
    const { ctx } = fakeDb(['x', 'y']);
    expect(await libraryIdsFor(ctx, undefined)).toEqual(['x', 'y']);
    expect(await libraryIdsFor(ctx, '')).toEqual(['x', 'y']);
  });

  it('runs for nothing on a database without libraries', async () => {
    const { ctx } = fakeDb([]);
    expect(await libraryIdsFor(ctx)).toEqual([]);
  });
});
