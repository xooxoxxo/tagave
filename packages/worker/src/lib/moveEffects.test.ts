/** The base pairs of a move: equal trailing folders stripped from both sides. */
import { describe, it, expect } from 'vitest';
import { moveBaseLevels, moveBasePairs } from './moveEffects.js';

const mv = (fromDir: string, toDir: string, fromRootId = 'a', toRootId = 'a') => ({ fromRootId, fromDir, toRootId, toDir, files: 1 });

describe('moveBaseLevels', () => {
  it('strips equal trailing components, deepest level first', () => {
    expect(moveBaseLevels(mv('X/Album/CD1', 'X/Album (2001)/CD1')).map((p) => [p.fromBase, p.toBase])).toEqual([
      ['X/Album/CD1', 'X/Album (2001)/CD1'], ['X/Album', 'X/Album (2001)'],
    ]);
  });

  it('compares components by normKey and goes up to the root across roots', () => {
    expect(moveBaseLevels(mv('Album/cd1', 'Album/CD1', 'a', 'b')).map((p) => [p.fromBase, p.toBase])).toEqual([
      ['Album/cd1', 'Album/CD1'], ['Album', 'Album'], ['', ''],
    ]);
  });

  it('a move within one folder has no levels; in one root the climb stops where both sides meet', () => {
    expect(moveBaseLevels(mv('A', 'A'))).toEqual([]);
    expect(moveBaseLevels(mv('P/A/CD1', 'Q/A/CD1')).map((p) => p.fromBase)).toEqual(['P/A/CD1', 'P/A', 'P']);
  });
});

describe('moveBasePairs', () => {
  it('takes the fully stripped pair of each move, once', () => {
    expect(moveBasePairs([mv('Album/CD1', 'Album (2001)/CD1'), mv('Album/CD2', 'Album (2001)/CD2'), mv('A', 'A')])).toEqual([
      { fromRootId: 'a', fromBase: 'Album', toRootId: 'a', toBase: 'Album (2001)' },
    ]);
  });
});
