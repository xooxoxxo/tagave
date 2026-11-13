import { describe, it, expect } from 'vitest';
import { storedReleases } from './storedRelease.js';

describe('storedReleases', () => {
  it('queries ids in chunks of 500 and binds each chunk as one array', async () => {
    const bound: string[][] = [];
    const sql = ((_s: TemplateStringsArray, ...values: unknown[]) => {
      bound.push(values[0] as string[]);
      return Promise.resolve([]);
    }) as any;
    const ids = Array.from({ length: 1201 }, (_, i) => `00000000-0000-0000-0000-${String(i).padStart(12, '0')}`);
    const out = await storedReleases({ sql }, ids);
    expect(out.size).toBe(0);
    // two queries (releases, tracks) per chunk
    expect(bound.map((b) => b.length)).toEqual([500, 500, 500, 500, 201, 201]);
    expect(bound.filter((_, i) => i % 2 === 0).flat()).toEqual(ids);
  });

  it('makes no query for no ids', async () => {
    let calls = 0;
    const sql = (() => { calls++; return Promise.resolve([]); }) as any;
    expect((await storedReleases({ sql }, [])).size).toBe(0);
    expect(calls).toBe(0);
  });
});
