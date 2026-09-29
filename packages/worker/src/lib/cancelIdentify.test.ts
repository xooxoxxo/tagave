import { describe, it, expect } from 'vitest';
import { cancelQueuedIdentify } from './cancelIdentify.js';

/** A postgres.js-shaped tag: sql`…` resolves rows, sql([...]) is a fragment. */
function fakeSql(rows: Array<{ id: string; name: string }>) {
  const calls: unknown[][] = [];
  const sql = ((first: unknown, ...values: unknown[]) => {
    if (Array.isArray(first) && 'raw' in (first as object)) {
      calls.push(values);
      return Promise.resolve(rows);
    }
    return { fragment: first };
  }) as any;
  return { sql, calls };
}

describe('cancelQueuedIdentify', () => {
  it('does nothing without albums', async () => {
    const { sql, calls } = fakeSql([]);
    expect(await cancelQueuedIdentify({ sql, boss: {} as any }, [])).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it('cancels the waiting jobs per queue', async () => {
    const { sql, calls } = fakeSql([
      { id: 'j1', name: 'identify.album' },
      { id: 'j2', name: 'identify.acoustid' },
      { id: 'j3', name: 'identify.album' },
    ]);
    const cancelled: Array<[string, string[]]> = [];
    const boss = { cancel: async (name: string, ids: string[]) => { cancelled.push([name, ids]); } };
    expect(await cancelQueuedIdentify({ sql, boss: boss as any }, ['a1', 'a2'])).toBe(3);
    expect(calls[0]).toContainEqual(['a1', 'a2']);
    expect(cancelled).toEqual([['identify.album', ['j1', 'j3']], ['identify.acoustid', ['j2']]]);
  });
});
