import { describe, it, expect } from 'vitest';
import type { CandidateEvidence } from '../matching/evidence.js';
import type { GroupingCandidate, TracklistGroup } from './grouping.js';
import { LOCAL_FEATURE_NAMES, candidateFeatures, featuresSchemaHash, type LocalCandidate } from './localFeatures.js';
import { applyIsotonic, calibratedProbability, fitIsotonic, modelVersion, predictLogistic } from './localModel.js';
import {
  AUTO_WEIGHT, MIN_OWNER_ALBUMS, OWNER_WEIGHT, REJECTION_WEIGHT, TRAIN_FOLDS, TrainingRefused, assignFolds, localDeciderGroups, numericBreakdown,
  trainLocalModel, trainingDataHash, trainingRows, type TrainingAlbum,
} from './localTrain.js';

/** A small seeded generator (the tests' own; the training has its own). */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const hex = (n: number, width = 12) => n.toString(16).padStart(width, '0');
const albumId = (i: number) => `00000000-0000-4000-8000-${hex(i)}`;
const releaseId = (i: number, j: number) => `00000000-0000-4000-9${hex(j, 3)}-${hex(i)}`;

/**
 * A library where distance separates the winner: the label's candidate is
 * near (0..0.08), the others far (0.3..0.7). Owner albums first, then auto
 * ones; a few owner albums have one candidate the owner rejected.
 */
function library(owner: number, auto: number, seed = 1, opts: { candidates?: number; groups?: boolean } = {}): TrainingAlbum[] {
  const r = rng(seed);
  const out: TrainingAlbum[] = [];
  for (let i = 0; i < owner + auto; i++) {
    const n = opts.candidates ?? 3;
    const candidates: LocalCandidate[] = [];
    for (let j = 0; j < n; j++) {
      const near = j === 0;
      candidates.push({
        releaseId: releaseId(i, j),
        distance: Number((near ? r() * 0.08 : 0.3 + r() * 0.4).toFixed(4)),
        breakdown: { album: near ? r() * 0.05 : 0.2 + r() * 0.5, tracks: near ? 0 : r() * 0.5 },
        acoustidCoverage: near ? 0.8 + r() * 0.2 : r() * 0.3,
        provider: j % 2 === 0 ? 'musicbrainz' : 'discogs',
      });
    }
    const isOwner = i < owner;
    out.push({
      albumId: albumId(i),
      label: { releaseId: releaseId(i, 0), owner: isOwner },
      rejected: isOwner && i % 50 === 7 ? [releaseId(i, 1)] : [],
      candidates,
      groups: opts.groups === false ? null : candidates.map((c, k) => group(String.fromCharCode(65 + k), [c])),
      releaseGroups: Object.fromEntries(candidates.map((c, k) => [c.releaseId, k === 0 ? `rg-${i}` : `rg-${i}-${k}`])),
    });
  }
  return out;
}

const gc = (c: LocalCandidate): GroupingCandidate => ({ releaseId: c.releaseId, distance: c.distance, evidence: {} as CandidateEvidence });
function group(label: string, members: LocalCandidate[]): TracklistGroup {
  const m = members.map(gc);
  return { label, anchor: m[0]!, members: m, closed: false };
}

describe('local decider training: rows and folds', () => {
  it('labels the live match 1 and the others 0; owner 1.0, auto 0.3, owner rejections 1.0', () => {
    expect([OWNER_WEIGHT, AUTO_WEIGHT, REJECTION_WEIGHT]).toEqual([1, 0.3, 1]);
    const lib = library(10, 2);
    const { rows, counts } = trainingRows(lib);
    expect(counts).toEqual({ albums: 12, rows: 36, owner: 10, auto: 2, rejections: 1 });
    const ofAlbum = (i: number) => rows.filter((x) => x.albumId === albumId(i)).sort((a, b) => (a.releaseId < b.releaseId ? -1 : 1));
    expect(ofAlbum(0).map((x) => [x.releaseId, x.y, x.w])).toEqual([
      [releaseId(0, 0), 1, 1], [releaseId(0, 1), 0, 1], [releaseId(0, 2), 0, 1],
    ]);
    expect(ofAlbum(11).map((x) => [x.y, x.w])).toEqual([[1, 0.3], [0, 0.3], [0, 0.3]]);
    // album 7's rejected candidate keeps weight 1 (it is an owner album anyway)
    expect(ofAlbum(7).find((x) => x.releaseId === releaseId(7, 1))).toMatchObject({ y: 0, w: 1, rejection: true });
    // features are candidateFeatures among the album's candidates
    expect(ofAlbum(3)[1]!.x).toEqual(candidateFeatures(releaseId(3, 1), lib[3]!.candidates));
    expect(ofAlbum(3)[1]!.x).toHaveLength(LOCAL_FEATURE_NAMES.length);
  });

  it('an auto album’s rejected candidate weighs 1.0; an album with only rejections gives those rows only', () => {
    const lib = library(0, 2);
    lib[0]!.rejected = [releaseId(0, 2)];
    lib[1]!.label = null;
    lib[1]!.rejected = [releaseId(1, 0)];
    const { rows, counts } = trainingRows(lib);
    expect(counts).toEqual({ albums: 1, rows: 4, owner: 0, auto: 1, rejections: 2 });
    expect(rows.filter((x) => x.albumId === albumId(0)).map((x) => [x.releaseId, x.y, x.w]).sort()).toEqual([[releaseId(0, 0), 1, 0.3], [releaseId(0, 1), 0, 0.3], [releaseId(0, 2), 0, 1]]);
    expect(rows.filter((x) => x.albumId === albumId(1)).map((x) => [x.releaseId, x.y, x.w])).toEqual([[releaseId(1, 0), 0, 1]]);
  });

  it('a rejection of the live match itself is not a negative', () => {
    const lib = library(1, 0);
    lib[0]!.rejected = [releaseId(0, 0)];
    const { rows, counts } = trainingRows(lib);
    expect(counts.rejections).toBe(0);
    expect(rows[0]).toMatchObject({ y: 1, w: 1, rejection: false });
  });

  it('refuses a label that is not among the album’s candidates', () => {
    const lib = library(1, 0);
    lib[0]!.label = { releaseId: 'not-a-candidate', owner: true };
    expect(() => trainingRows(lib)).toThrow(/not among/);
  });

  it('folds: every album in exactly one, owner albums spread evenly, the same for the same seed', () => {
    const lib = library(53, 147);
    const a = assignFolds(lib, 5, 7);
    expect(a.size).toBe(200);
    expect(assignFolds([...lib].reverse(), 5, 7)).toEqual(a);
    const b = assignFolds(lib, 5, 8);
    expect([...b.entries()]).not.toEqual([...a.entries()]);
    const ownerPer = [0, 0, 0, 0, 0];
    for (const al of lib) if (al.label?.owner) ownerPer[a.get(al.albumId)!]!++;
    expect(Math.max(...ownerPer) - Math.min(...ownerPer)).toBeLessThanOrEqual(1);
    for (const f of a.values()) expect(f).toBeGreaterThanOrEqual(0);
  });

  it('the data hash is over the labels and rejections, whatever the order', () => {
    const lib = library(5, 5);
    const h = trainingDataHash(lib);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(trainingDataHash([...lib].reverse())).toBe(h);
    const moved = library(5, 5);
    moved[9]!.label = { releaseId: releaseId(9, 1), owner: false };
    expect(trainingDataHash(moved)).not.toBe(h);
    const reweighted = library(5, 5);
    reweighted[9]!.label = { ...reweighted[9]!.label!, owner: true };
    expect(trainingDataHash(reweighted)).not.toBe(h);
  });

  it('numericBreakdown keeps finite numbers only', () => {
    expect(numericBreakdown({ album: 0.1, year: '1', tracks: null, x: Number.NaN, y: 2 })).toEqual({ album: 0.1, y: 2 });
    expect(numericBreakdown('{"album":0.5}')).toEqual({ album: 0.5 });
    expect(numericBreakdown(null)).toBeNull();
    expect(numericBreakdown([1, 2])).toBeNull();
  });
});

describe('local decider training: the model', () => {
  it('a library where distance separates the winner: p99 decides, and decides right', () => {
    const lib = library(300, 300);
    const t = trainLocalModel(lib);
    expect(t.counts).toMatchObject({ albums: 600, owner: 300, auto: 300 });
    expect(t.model.featuresSchemaHash).toBe(featuresSchemaHash());
    expect(t.version).toBe(modelVersion(t.model));
    const p99 = t.metrics.bands.find((b) => b.band === 'p99')!;
    expect(p99.decided).toBeGreaterThan(200);
    expect(p99.wrongRelease).toBe(0);
    expect(p99.wrongAlbum).toBe(0);
    expect(p99.errorRate).toBe(0);
    expect(p99.errorUpper).toBeLessThan(0.02);
    expect(t.metrics.topPickRight).toMatchObject({ albums: 300, right: 300, rate: 1 });
    expect(t.metrics.albums).toBe(300);
    // cumulative bands include the ones above them
    const at = (b: string) => t.metrics.atOrAbove.find((x) => x.band === b)!.decided;
    expect(at('p90')).toBeGreaterThanOrEqual(at('p95'));
    expect(at('p99')).toBe(p99.decided);
    // the stored model decides a clear album with a probability over 0.99 and a far one under the cut-off
    const album = lib[0]!;
    expect(calibratedProbability(t.model, candidateFeatures(album.candidates[0]!.releaseId, album.candidates))).toBeGreaterThanOrEqual(0.99);
    expect(calibratedProbability(t.model, candidateFeatures(album.candidates[1]!.releaseId, album.candidates))).toBeLessThan(0.9);
  });

  it('calibration uses out-of-fold scores of owner albums only, never a row its fold model was fit on', () => {
    const lib = library(240, 160);
    const t = trainLocalModel(lib);
    const { folds, calibration } = t.diagnostics;
    expect(folds.k).toBe(TRAIN_FOLDS);
    // every fold model was fit on the other folds' albums only
    for (let f = 0; f < folds.k; f++) {
      const fit = new Set(folds.fitAlbums[f]);
      for (const [id, fold] of folds.foldOf) expect(fit.has(id), `${id} fold ${fold} vs model ${f}`).toBe(fold !== f);
    }
    // every calibration row is an owner album's, scored by the model of its own (held-out) fold
    const owners = new Set(lib.filter((a) => a.label?.owner).map((a) => a.albumId));
    expect(calibration.albumIds.length).toBe(calibration.scores.length);
    expect(new Set(calibration.albumIds)).toEqual(owners);
    calibration.albumIds.forEach((id, i) => {
      const f = calibration.folds[i]!;
      expect(folds.foldOf.get(id)).toBe(f);
      expect(folds.fitAlbums[f]!.includes(id)).toBe(false);
    });
    // the stored isotonic is exactly the fit on those scores
    expect(t.model.isotonic).toEqual(fitIsotonic(calibration.scores, calibration.labels, calibration.weights));
    // and those scores are not the final model's own (fit-row) scores
    const rows = trainingRows(lib).rows.filter((r) => owners.has(r.albumId));
    const inSample = rows.map((r) => predictLogistic(t.model.logistic, r.x));
    expect(inSample).not.toEqual(calibration.scores);
  });

  it('the held-out metrics are calibrated by an isotonic fit without the album’s own fold', () => {
    const t = trainLocalModel(library(240, 160));
    const { calibration, heldOutIsotonic } = t.diagnostics;
    expect(heldOutIsotonic).toHaveLength(TRAIN_FOLDS);
    for (let f = 0; f < TRAIN_FOLDS; f++) {
      const keep = calibration.folds.map((g) => g !== f);
      const pick = <T>(xs: T[]) => xs.filter((_, i) => keep[i]);
      expect(heldOutIsotonic[f]).toEqual(fitIsotonic(pick(calibration.scores), pick(calibration.labels), pick(calibration.weights)));
    }
  });

  it('deterministic: the same data and seed give the same version; another seed only changes the held-out figures', () => {
    const a = trainLocalModel(library(220, 100));
    const b = trainLocalModel([...library(220, 100)].reverse());
    expect(b.version).toBe(a.version);
    expect(b.dataHash).toBe(a.dataHash);
    expect(b.metrics).toEqual(a.metrics);
    const c = trainLocalModel(library(220, 100), { seed: 99 });
    expect(c.model.logistic).toEqual(a.model.logistic);
    expect(c.dataHash).toBe(a.dataHash);
  });

  it('refuses too few owner albums, and a single class, with a clear reason', () => {
    expect(MIN_OWNER_ALBUMS).toBe(200);
    const few = library(MIN_OWNER_ALBUMS - 1, 300);
    expect(() => trainLocalModel(few)).toThrow(TrainingRefused);
    try {
      trainLocalModel(few);
    } catch (err) {
      expect(err).toMatchObject({ reason: 'too_few_owner_albums', ownerAlbums: MIN_OWNER_ALBUMS - 1, needed: MIN_OWNER_ALBUMS });
      expect((err as Error).message).toMatch(/199 albums the owner decided; training needs 200/);
    }
    // one candidate per album: no negatives at all
    const single = library(250, 0, 1, { candidates: 1 });
    expect(() => trainLocalModel(single)).toThrow(expect.objectContaining({ reason: 'one_class' }));
    expect(() => trainLocalModel([])).toThrow(expect.objectContaining({ reason: 'too_few_owner_albums' }));
    // the minimum can be lowered (a test library), never below one fold's worth
    expect(trainLocalModel(library(40, 20), { minOwnerAlbums: 30 }).counts.owner).toBe(40);
    expect(() => trainLocalModel(library(4, 20), { minOwnerAlbums: 1 })).toThrow(expect.objectContaining({ reason: 'too_few_owner_albums' }));
  });

  it('scores the decider’s tracklist groups: a group of several editions is right when it holds the label', () => {
    const lib = library(260, 0, 3, { candidates: 4 });
    // the label and its next candidate are one tracklist group; the far two another each
    for (const a of lib) {
      const [c0, c1, c2, c3] = a.candidates as [LocalCandidate, LocalCandidate, LocalCandidate, LocalCandidate];
      a.groups = [group('A', [c0, c1]), group('B', [c2]), group('C', [c3])];
    }
    const t = trainLocalModel(lib);
    expect(t.metrics.groupedAlbums).toBe(260);
    expect(t.metrics.topPickRight.rate).toBe(1);
    // without groups (no stored evidence) each candidate is its own group
    const flat = trainLocalModel(library(260, 0, 3, { candidates: 4, groups: false }));
    expect(flat.metrics.groupedAlbums).toBe(0);
    expect(flat.metrics.albums).toBe(260);
  });

  it('a pick of another edition of the same album is a wrong release but not a wrong album', () => {
    // the owner's label is the far candidate, of the same release group as the near one: the model picks the near one
    const lib = library(260, 0, 5);
    const flipped = lib.slice(0, 20);
    for (const a of flipped) {
      a.label = { releaseId: a.candidates[1]!.releaseId, owner: true };
      a.releaseGroups[a.candidates[1]!.releaseId] = a.releaseGroups[a.candidates[0]!.releaseId]!;
    }
    const t = trainLocalModel(lib);
    const p90 = t.metrics.atOrAbove.find((b) => b.band === 'p90')!;
    expect(p90.wrongRelease).toBeGreaterThan(0);
    expect(p90.wrongAlbum).toBe(0);
    expect(p90.errorRate).toBeCloseTo(p90.wrongRelease / p90.decided, 12);
    expect(t.metrics.topPickRight.right).toBe(240);
  });
});

describe('localDeciderGroups', () => {
  it('each release once at its best distance, grouped as the decider groups them', () => {
    const ev = (titles: string[]): CandidateEvidence => ({
      v: 1, tracks: titles.map((title, i) => [1, title, 200 + i * 30]), align: [], unmatchedLocal: [], missingRemote: [], capped: false,
    } as unknown as CandidateEvidence);
    const a = ev(['one', 'two', 'three']);
    const b = ev(['four', 'five']);
    const groups = localDeciderGroups({ discsKnown: true }, [
      { releaseId: 'r2', distance: 0.2, evidence: a }, { releaseId: 'r1', distance: 0.1, evidence: a },
      { releaseId: 'r2', distance: 0.15, evidence: a }, { releaseId: 'r3', distance: 0.5, evidence: b },
    ]);
    expect(groups.map((g) => g.members.map((m) => m.releaseId))).toEqual([['r1', 'r2'], ['r3']]);
    const ids = groups.flatMap((g) => g.members.map((m) => m.releaseId)).sort();
    expect(ids).toEqual(['r1', 'r2', 'r3']);
    expect(groups.flatMap((g) => g.members).find((m) => m.releaseId === 'r2')!.distance).toBe(0.15);
    expect(groups[0]!.label).toBe('A');
    expect(applyIsotonic({ blocks: [{ lo: 0, hi: 1, p: 0.5, weight: 1 }] }, 0.3)).toBe(0.5);
  });
});
