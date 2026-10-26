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
  it('Tier 1: same dev:ino and size, or same size, mtime and name (case and NFD folded)', () => {
    const o = old('A/Caf\u00e9.flac', { inode: '1:2' });
    expect(signatureMatches(1, o, moved(o, 'B/other.flac'))).toBe(true);                       // dev:ino
    expect(signatureMatches(1, o, moved(o, 'B/other.flac', { inode: '9:9' }))).toBe(false);    // ino differs, name differs
    expect(signatureMatches(1, o, moved(o, 'B/CAFE\u0301.flac', { inode: null }))).toBe(true);
    expect(signatureMatches(1, o, moved(o, 'B/Café.flac', { inode: '9:9', mtime: 1 }))).toBe(false);
    expect(signatureMatches(1, o, moved(o, 'B/x', { sizeBytes: 1 }))).toBe(false);             // size must match even with dev:ino
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
