import { describe, it, expect } from 'vitest';
import { planPairs, signatureMatches, type MatchFile } from './reconcileMatch.js';

const T0 = new Date('2026-10-01T00:00:00Z');
const T1 = new Date('2026-10-02T00:00:00Z');
let n = 0;
const old = (relPath: string, over: Partial<MatchFile> = {}): MatchFile => ({
  id: `o${++n}`, scanRootId: 'r1', relPath, sizeBytes: 100 + n, mtime: 1000 + n, inode: null,
  durationMs: null, coreTagsDigest: null, audioHash: null, trackNo: null, discNo: null,
  firstSeenAt: T0, lastSeenAt: T0, ...over,
});
const moved = (o: MatchFile, relPath: string, over: Partial<MatchFile> = {}): MatchFile => ({
  ...o, id: `f-${o.id}`, relPath, firstSeenAt: T1, lastSeenAt: T1, ...over,
});
const ids = (p: ReturnType<typeof planPairs>) => p.pairs.map((x) => `${x.oldId}>${x.freshId}`).sort();

describe('signatureMatches', () => {
  it('Tier 1: same size and mtime, plus same dev:ino or same name (case and NFD folded)', () => {
    const o = old('A/Caf\u00e9.flac', { inode: '1:2' });
    expect(signatureMatches(1, o, moved(o, 'B/other.flac'))).toBe(true);                       // dev:ino
    expect(signatureMatches(1, o, moved(o, 'B/other.flac', { inode: '9:9' }))).toBe(false);    // ino differs, name differs
    expect(signatureMatches(1, o, moved(o, 'B/CAFE\u0301.flac', { inode: null }))).toBe(true);
    expect(signatureMatches(1, o, moved(o, 'B/Café.flac', { inode: '9:9', mtime: 1 }))).toBe(false);
    expect(signatureMatches(1, o, moved(o, 'B/x', { sizeBytes: 1 }))).toBe(false);             // size must match even with dev:ino
  });
  it('Tier 1 dev:ino needs the same mtime, and an inode of 0 or an empty one never pairs', () => {
    const o = old('A/a.flac', { inode: '1:2' });
    expect(signatureMatches(1, o, moved(o, 'B/b.flac', { mtime: 1 }))).toBe(false);            // inode reused after a delete
    const z = old('A/a.flac', { inode: '1:0' });
    expect(signatureMatches(1, z, moved(z, 'B/b.flac'))).toBe(false);
    const e = old('A/a.flac', { inode: '' });
    expect(signatureMatches(1, e, moved(e, 'B/b.flac'))).toBe(false);
  });
  it('Tier 2: size + duration + core digest, or audio hash', () => {
    const o = old('A/1.flac', { durationMs: 5000, coreTagsDigest: 'd1' });
    expect(signatureMatches(2, o, moved(o, 'B/x.flac', { mtime: 9 }))).toBe(true);
    expect(signatureMatches(2, o, moved(o, 'B/x.flac', { coreTagsDigest: null }))).toBe(false);
    expect(signatureMatches(2, { ...o, coreTagsDigest: null }, moved(o, 'B/x.flac', { coreTagsDigest: null }))).toBe(false);
    expect(signatureMatches(2, { ...o, audioHash: 'h' }, moved(o, 'B/x.flac', { sizeBytes: 1, audioHash: 'h' }))).toBe(true);
  });
});

describe('planPairs', () => {
  it('pairs a renamed album folder 1:1 as a dir pair', () => {
    const a = old('Artist/Old/1.flac'); const b = old('Artist/Old/2.flac');
    const p = planPairs(1, [a, b], [moved(a, 'Artist/New/1.flac'), moved(b, 'Artist/New/2.flac')]);
    expect(ids(p)).toEqual([`${a.id}>f-${a.id}`, `${b.id}>f-${b.id}`]);
    expect(p.pairs.every((x) => x.dirPair)).toBe(true);
  });

  it('never pairs with a row first seen before the old one was last seen (a copy that coexisted)', () => {
    const a = old('A/1.flac');
    const p = planPairs(1, [{ ...a, lastSeenAt: T1 }], [moved(a, 'B/1.flac', { firstSeenAt: T0 })]);
    expect(p.pairs).toEqual([]);
  });

  it('never pairs with a row first seen in the statement the old one was last seen (one walk batch: they coexisted, F1)', () => {
    const a = old('A/1.flac');
    const p = planPairs(1, [a], [moved(a, 'B/1.flac', { firstSeenAt: a.lastSeenAt })]);
    expect(p.pairs).toEqual([]);
    const t2 = planPairs(2, [{ ...a, durationMs: 1000, coreTagsDigest: 'd' }],
      [moved({ ...a, durationMs: 1000, coreTagsDigest: 'd' }, 'B/1.flac', { firstSeenAt: a.lastSeenAt })]);
    expect(t2.pairs).toEqual([]);
  });

  it('two identical candidates pair nothing and are listed as a possible move', () => {
    const a = old('A/x.flac');
    const p = planPairs(1, [a], [moved(a, 'B/x.flac'), { ...moved(a, 'C/x.flac'), id: 'f2' }]);
    expect(p.pairs).toEqual([]);
    expect(p.possibleMoves).toEqual([{ oldIds: [a.id], freshIds: [`f-${a.id}`, 'f2'], reason: 'ambiguous' }]);
  });

  it('a dir pair settles an ambiguous file by name (same silence track in two moved albums)', () => {
    const s1 = old('X/One/00 silence.flac', { sizeBytes: 50, mtime: 7 });
    const s2 = old('X/Two/00 silence.flac', { sizeBytes: 50, mtime: 7 });
    const one = [old('X/One/1.flac'), old('X/One/2.flac'), old('X/One/3.flac'), old('X/One/4.flac')];
    const two = [old('X/Two/1.flac'), old('X/Two/2.flac'), old('X/Two/3.flac'), old('X/Two/4.flac')];
    const freshs = [
      moved(s1, 'Y/One/00 silence.flac'), moved(s2, 'Y/Two/00 silence.flac'),
      ...one.map((o) => moved(o, o.relPath.replace('X/', 'Y/'))), ...two.map((o) => moved(o, o.relPath.replace('X/', 'Y/'))),
    ];
    const p = planPairs(1, [s1, s2, ...one, ...two], freshs);
    expect(p.pairs).toHaveLength(10);
    expect(ids(p)).toContain(`${s1.id}>f-${s1.id}`);
    expect(ids(p)).toContain(`${s2.id}>f-${s2.id}`);
    expect(p.possibleMoves).toEqual([]);
  });

  it('Tier 2 settles inside a dir pair by track and disc number', () => {
    const base = { sizeBytes: 77, durationMs: 1000, coreTagsDigest: 'same' };
    const a = old('A/dup-a.flac', { ...base, trackNo: 1 }); const b = old('A/dup-b.flac', { ...base, trackNo: 2 });
    const rest = [old('A/3.flac', { durationMs: 3, coreTagsDigest: 'c3' }), old('A/4.flac', { durationMs: 4, coreTagsDigest: 'c4' }),
                  old('A/5.flac', { durationMs: 5, coreTagsDigest: 'c5' }), old('A/6.flac', { durationMs: 6, coreTagsDigest: 'c6' }),
                  old('A/7.flac', { durationMs: 7, coreTagsDigest: 'c7' }), old('A/8.flac', { durationMs: 8, coreTagsDigest: 'c8' }),
                  old('A/9.flac', { durationMs: 9, coreTagsDigest: 'c9' }), old('A/10.flac', { durationMs: 10, coreTagsDigest: 'c10' })];
    const freshs = [moved(a, 'B/x1.flac'), moved(b, 'B/x2.flac'), ...rest.map((o) => moved(o, o.relPath.replace('A/', 'B/'), { mtime: 1 }))];
    const p = planPairs(2, [a, b, ...rest], freshs);
    expect(ids(p)).toContain(`${a.id}>f-${a.id}`);
    expect(ids(p)).toContain(`${b.id}>f-${b.id}`);
  });

  it('edition guard: new folder with extra new files pairs nothing (deluxe replacing standard)', () => {
    const std = [old('A/Std/1.flac'), old('A/Std/2.flac'), old('A/Std/3.flac')];
    const freshs = [...std.map((o) => moved(o, o.relPath.replace('Std', 'Deluxe'))),
      { ...moved(std[0]!, 'A/Deluxe/4.flac'), id: 'bonus1', sizeBytes: 999 },
      { ...moved(std[0]!, 'A/Deluxe/5.flac'), id: 'bonus2', sizeBytes: 998 }];
    const p = planPairs(1, std, freshs);
    expect(p.pairs).toEqual([]);
    expect(p.possibleMoves).toEqual([{ oldIds: std.map((o) => o.id).sort(), freshIds: std.map((o) => `f-${o.id}`).sort(), reason: 'edition' }]);
  });

  it('older files already in the destination folder are not extras', () => {
    const a = old('A/Old/1.flac'); const b = old('A/Old/2.flac');
    const resident = { ...old('A/New/0.flac', { sizeBytes: 5 }), firstSeenAt: new Date('2026-09-01T00:00:00Z') };
    const p = planPairs(1, [a, b], [moved(a, 'A/New/1.flac'), moved(b, 'A/New/2.flac'), resident]);
    expect(p.pairs).toHaveLength(2);
  });

  it('a resident first seen in the same statement the old rows were last seen is not an extra (F1)', () => {
    const a = old('A/Old/1.flac'); const b = old('A/Old/2.flac');
    const resident = old('A/New/0.flac', { sizeBytes: 5 }); // firstSeenAt === lastSeenAt of a, b (T0)
    const p = planPairs(1, [a, b], [moved(a, 'A/New/1.flac'), moved(b, 'A/New/2.flac'), resident]);
    expect(p.pairs).toHaveLength(2);
    expect(p.possibleMoves).toEqual([]);
  });

  it('a case-only and NFD-only folder rename merges as a dir pair (Review Focus 1)', () => {
    const a = old('Artist/Café Album/01 Song.flac'); const b = old('Artist/Café Album/02 Song.flac');
    const freshs = [moved(a, 'Artist/café album/01 song.flac'), moved(b, 'Artist/café album/02 song.flac')];
    const p = planPairs(1, [a, b], freshs);
    expect(ids(p)).toEqual([`${a.id}>f-${a.id}`, `${b.id}>f-${b.id}`]);
    expect(p.pairs.every((x) => x.dirPair)).toBe(true);
  });

  it('a unique pair outside any dir pair still merges (one file renamed across folders)', () => {
    const files = [old('A/1.flac'), old('A/2.flac'), old('A/3.flac'), old('A/4.flac'), old('A/5.flac')];
    const p = planPairs(1, files, [moved(files[0]!, 'Elsewhere/1.flac')]);
    expect(p.pairs).toEqual([{ oldId: files[0]!.id, freshId: `f-${files[0]!.id}`, dirPair: false }]);
  });

  it('files moved between roots pair (scan root is part of the dir key)', () => {
    const a = old('Same/1.flac');
    const p = planPairs(1, [a], [moved(a, 'Same/1.flac', { scanRootId: 'r2' })]);
    expect(p.pairs).toHaveLength(1);
  });

  it('plans 5,000 files in well under a second (size buckets, not a cross product)', () => {
    const olds = Array.from({ length: 5000 }, (_, i) => old(`D${i % 50}/${i}.flac`));
    const freshs = olds.map((o) => moved(o, o.relPath.replace(/^D/, 'E')));
    const t = Date.now();
    expect(planPairs(1, olds, freshs).pairs).toHaveLength(5000);
    expect(Date.now() - t).toBeLessThan(1000);
  });
});

// Fix round 1: order independence, the edition guard over the final pair set, scale.
function rng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function shuffle<T>(xs: T[], r: () => number): T[] {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

type Scenario = { tier: 1 | 2; olds: MatchFile[]; freshs: MatchFile[] };

/** Identical files from D1/ and D2/ flattened into Al/: only one Al/00 silence.flac exists. */
function flattenScenario(): Scenario & { s1: MatchFile; s2: MatchFile; d1: MatchFile[]; d2: MatchFile[] } {
  const s1 = old('D1/00 silence.flac', { sizeBytes: 50, mtime: 7 });
  const s2 = old('D2/00 silence.flac', { sizeBytes: 50, mtime: 7 });
  const d1 = [1, 2, 3, 4].map((i) => old(`D1/${i}.flac`));
  const d2 = [5, 6, 7, 8].map((i) => old(`D2/${i}.flac`));
  const freshs = [...d1, ...d2].map((o) => moved(o, `Al/${relBase(o.relPath)}`));
  freshs.push({ ...moved(s1, 'Al/00 silence.flac'), id: 'f-silence' });
  return { tier: 1, olds: [s1, s2, ...d1, ...d2], freshs, s1, s2, d1, d2 };
}

/** A/ and B/ both move into C/; each has one file with a twin copy in E/. */
function twoIntoOneScenario(): Scenario & { x: MatchFile; y: MatchFile } {
  const a = [1, 2, 3, 4].map((i) => old(`A/${i}.flac`));
  const b = [5, 6, 7, 8].map((i) => old(`B/${i}.flac`));
  const x = old('A/x.flac'); const y = old('B/y.flac');
  const freshs = [...a, ...b, x, y].map((o) => moved(o, `C/${relBase(o.relPath)}`));
  freshs.push({ ...moved(x, 'E/x.flac'), id: 'e-x' }, { ...moved(y, 'E/y.flac'), id: 'e-y' });
  return { tier: 1, olds: [...a, ...b, x, y], freshs, x, y };
}

function deluxeScenario(): Scenario & { std: MatchFile[] } {
  const std = [1, 2, 3, 4, 5].map((i) => old(`Std/${i}.flac`));
  const freshs = [
    ...std.slice(0, 3).map((o) => moved(o, `Deluxe/${relBase(o.relPath)}`)),
    { ...moved(std[3]!, 'Deluxe/4.flac'), id: 'remaster4', sizeBytes: 9004 },
    { ...moved(std[4]!, 'Deluxe/5.flac'), id: 'remaster5', sizeBytes: 9005 },
    { ...moved(std[0]!, 'Deluxe/6 bonus.flac'), id: 'bonus6', sizeBytes: 9006 },
  ];
  return { tier: 1, olds: std, freshs, std };
}

function tier2SettleScenario(): Scenario {
  const base = { sizeBytes: 77, durationMs: 1000, coreTagsDigest: 'same' };
  const a = old('T/dup-a.flac', { ...base, trackNo: 1 }); const b = old('T/dup-b.flac', { ...base, trackNo: 2 });
  const rest = [3, 4, 5, 6, 7, 8, 9, 10].map((i) => old(`T/${i}.flac`, { durationMs: i, coreTagsDigest: `c${i}` }));
  const freshs = [moved(a, 'U/x1.flac'), moved(b, 'U/x2.flac'), ...rest.map((o) => moved(o, o.relPath.replace('T/', 'U/'), { mtime: 1 }))];
  return { tier: 2, olds: [a, b, ...rest], freshs };
}

function relBase(p: string) { return p.slice(p.lastIndexOf('/') + 1); }

describe('planPairs, fix round 1', () => {
  it('one old row matching two fresh rows through different Tier 1 kinds pairs neither', () => {
    const o = old('A/x.flac', { inode: '1:2' });
    const byInode = moved(o, 'B/y.flac');
    const byName = { ...moved(o, 'C/x.flac', { inode: '3:4' }), id: 'f2' };
    const p = planPairs(1, [o], [byInode, byName]);
    expect(p.pairs).toEqual([]);
    expect(p.possibleMoves).toEqual([{ oldIds: [o.id], freshIds: [byInode.id, 'f2'].sort(), reason: 'ambiguous' }]);
  });

  it('two old rows matching one fresh row pairs neither', () => {
    const a = old('A/x.flac');
    const b = { ...a, id: 'b-twin', relPath: 'B/x.flac' };
    const f = moved(a, 'C/x.flac');
    const p = planPairs(1, [a, b], [f]);
    expect(p.pairs).toEqual([]);
    expect(p.possibleMoves.map((m) => m.oldIds[0]).sort()).toEqual([a.id, 'b-twin'].sort());
    expect(p.possibleMoves.every((m) => m.reason === 'ambiguous' && m.freshIds[0] === f.id)).toBe(true);
  });

  it('D1/ and D2/ flattened into Al/: the shared silence file has no owner, and the guard drops the folder', () => {
    const s = flattenScenario();
    const p = planPairs(1, s.olds, s.freshs);
    expect(p.pairs.find((x) => x.freshId === 'f-silence')).toBeUndefined();
    // Al/ keeps an unpaired new file, so no pair into it stands (Ruling 3 + guard after settling).
    expect(p.pairs).toEqual([]);
    expect(p.possibleMoves.filter((m) => m.reason === 'edition').map((m) => m.oldIds)).toEqual(
      [s.d1.map((o) => o.id).sort(), s.d2.map((o) => o.id).sort()].sort((a, b) => (a[0]! < b[0]! ? -1 : 1)),
    );
    expect(p.possibleMoves.filter((m) => m.reason === 'ambiguous')).toEqual(
      [s.s1, s.s2].map((o) => ({ oldIds: [o.id], freshIds: ['f-silence'], reason: 'ambiguous' }))
        .sort((a, b) => (a.oldIds[0]! < b.oldIds[0]! ? -1 : 1)),
    );
  });

  it('A/ and B/ into C/, each with an ambiguous file: both settle, the guard sees the final pair set', () => {
    const s = twoIntoOneScenario();
    const p = planPairs(1, s.olds, s.freshs);
    expect(p.pairs).toHaveLength(10);
    expect(p.pairs.every((x) => x.dirPair)).toBe(true);
    expect(ids(p)).toContain(`${s.x.id}>f-${s.x.id}`);
    expect(ids(p)).toContain(`${s.y.id}>f-${s.y.id}`);
    expect(p.possibleMoves).toEqual([]);
  });

  it('edition guard covers unique pairs outside a dir pair (5 tracks, 3 unchanged + 2 remastered + 1 bonus)', () => {
    const s = deluxeScenario();
    const p = planPairs(1, s.olds, s.freshs);
    expect(p.pairs).toEqual([]);
    const kept = s.std.slice(0, 3);
    expect(p.possibleMoves).toEqual([{ oldIds: kept.map((o) => o.id).sort(), freshIds: kept.map((o) => `f-${o.id}`).sort(), reason: 'edition' }]);
  });

  it('the guard uses the paired rows only: an old row missing since long ago does not tighten it', () => {
    const LONG_AGO = new Date('2026-01-01T00:00:00Z');
    const four = [1, 2, 3, 4].map((i) => old(`A/${i}.flac`));
    const ancient = old('A/gone.flac', { lastSeenAt: LONG_AGO, firstSeenAt: LONG_AGO, sizeBytes: 1 });
    // Resident in B/ first seen between the ancient row and the others vanishing: older than the paired rows.
    const resident = { ...old('B/0.flac', { sizeBytes: 2 }), firstSeenAt: new Date('2026-06-01T00:00:00Z') };
    const p = planPairs(1, [...four, ancient], [...four.map((o) => moved(o, o.relPath.replace('A/', 'B/'))), resident]);
    expect(p.pairs).toHaveLength(4);
    expect(p.pairs.every((x) => x.dirPair)).toBe(true); // 4 of 5 vanished rows: a dir pair
  });

  it('gives identical output under 20 seeded random input orders', () => {
    const scenarios = [flattenScenario(), twoIntoOneScenario(), deluxeScenario(), tier2SettleScenario()];
    for (const s of scenarios) {
      const want = planPairs(s.tier, s.olds, s.freshs);
      for (let seed = 1; seed <= 20; seed++) {
        const r = rng(seed);
        expect(planPairs(s.tier, shuffle(s.olds, r), shuffle(s.freshs, r))).toEqual(want);
      }
    }
  });

  it('plans 6,000 renamed folders x 10 files (60k rows) under one parent in well under a second', () => {
    const olds: MatchFile[] = [];
    for (let d = 0; d < 6000; d++) for (let i = 0; i < 10; i++) olds.push(old(`Old/D${d}/${i}.flac`));
    const freshs = olds.map((o) => moved(o, o.relPath.replace(/^Old\//, 'New/')));
    const t = Date.now();
    const p = planPairs(1, olds, freshs);
    const ms = Date.now() - t;
    expect(p.pairs).toHaveLength(60000);
    expect(p.pairs.every((x) => x.dirPair)).toBe(true);
    expect(ms).toBeLessThan(2000);
  });
});
