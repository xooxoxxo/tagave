/**
 * Training the local decider from a library's own decisions. Pure: the
 * caller reads the library and hands over one TrainingAlbum per album;
 * nothing here reads the database, files or the network.
 *
 * - Rows: one per candidate of an album with a live match, labelled 1 for
 *   the live match's release and 0 for the others; weight 1.0 when the owner
 *   decided the match, 0.3 when it was matched automatically and never
 *   reversed. A candidate the owner rejected is a negative of weight 1.0
 *   (also on an album with no live match, which then gives those rows only).
 *   Features are candidateFeatures among the album's candidates.
 * - Folds: grouped by album, k (5) of them, owner albums and the others
 *   spread evenly, by a seeded shuffle of the sorted album ids.
 * - Out-of-fold scores: per fold, logistic regression fitted on the other
 *   folds' albums scores the fold's albums, so every album gets a score from
 *   a model that never saw it.
 * - Calibration: isotonic regression on the out-of-fold scores of the
 *   owner's albums only (review-like decisions), never on rows a model that
 *   scored them was fitted on. The stored model is the logistic fit on every
 *   row, with that isotonic calibration.
 * - Held-out metrics: per owner album, its tracklist groups (the ones the
 *   decider scores) are scored by its fold's logistic model and calibrated
 *   by an isotonic fitted on the other folds' owner scores only, so neither
 *   stage has seen the album. Then decideFromProbabilities (the same cut-off,
 *   margin and bands as every decider) decides it.
 *
 * Deterministic: the same albums (in any order) and seed give the same
 * model, version, data hash and metrics.
 */
import { createHash } from 'node:crypto';
import { stableJson } from '../matching/evidence.js';
import type { CandidateEvidence } from '../matching/evidence.js';
import { clopperPearsonUpper } from '../stats/clopperPearson.js';
import { groupTracklists, groupLabel, type TracklistGroup } from './grouping.js';
import { JEV_SPEC, decideFromProbabilities } from './jevSpec.js';
import { LOCAL_FEATURES_VERSION, LOCAL_FEATURE_NAMES, candidateFeatures, featuresSchemaHash, groupFeatures, type LocalCandidate } from './localFeatures.js';
import { applyIsotonic, fitIsotonic, fitLogistic, modelVersion, predictLogistic, type IsotonicModel, type LocalModel, type LogisticModel } from './localModel.js';

/** Fewest albums the owner decided before a model is trained: the calibration and the held-out figures stand on them. */
export const MIN_OWNER_ALBUMS = 200;
export const TRAIN_FOLDS = 5;
export const TRAIN_SEED = 7;
export const OWNER_WEIGHT = 1;
export const AUTO_WEIGHT = 0.3;
export const REJECTION_WEIGHT = 1;
/** The penalty on the standardised coefficients. */
export const TRAIN_L2 = 1;

export interface TrainingAlbum {
  albumId: string;
  /** the live match (null: an album the owner only rejected candidates of) */
  label: { releaseId: string; owner: boolean } | null;
  /** releases the owner rejected for this album */
  rejected: string[];
  /** the album's candidates: each release once, at its best distance */
  candidates: LocalCandidate[];
  /**
   * The tracklist groups the decider scores (localDeciderGroups), every
   * member a candidate; null when the album's evidence is not all stored,
   * and each candidate is then its own group.
   */
  groups: TracklistGroup[] | null;
  /** release id → release group id, for "wrong album"; a release missing here is its own album */
  releaseGroups: Record<string, string | null>;
}

export interface TrainingRow { albumId: string; releaseId: string; x: number[]; y: 0 | 1; w: number; rejection: boolean }

export interface TrainingCounts { albums: number; rows: number; owner: number; auto: number; rejections: number }

export interface BandMetrics {
  band: string;
  min: number;
  decided: number;
  /** decided / the owner albums measured */
  coverage: number;
  /** the picked tracklist group does not hold the owner's release */
  wrongRelease: number;
  /** no release of the picked group is of the owner's release group */
  wrongAlbum: number;
  /** wrongRelease / decided; null when nothing was decided */
  errorRate: number | null;
  /** one-sided 95% Clopper–Pearson upper bound on the error rate */
  errorUpper: number;
}

export interface LocalTrainMetrics {
  /** owner albums measured, out of fold */
  albums: number;
  /** of those, scored by their tracklist groups (the rest: each candidate its own group) */
  groupedAlbums: number;
  folds: number;
  seed: number;
  cutoff: number;
  margin: number;
  /** per band, as a run would decide it (each pick in its highest band) */
  bands: BandMetrics[];
  /** per band floor, every pick at or above it */
  atOrAbove: BandMetrics[];
  undecided: number;
  /** the most probable group holds the owner's release, decided or not */
  topPickRight: { right: number; albums: number; rate: number };
}

export interface TrainOptions { folds?: number; seed?: number; minOwnerAlbums?: number; l2?: number }

export interface TrainResult {
  model: LocalModel;
  version: string;
  dataHash: string;
  counts: TrainingCounts;
  metrics: LocalTrainMetrics;
  /** fold bookkeeping, for checks; not stored */
  diagnostics: {
    folds: { k: number; foldOf: Map<string, number>; fitAlbums: string[][] };
    calibration: { albumIds: string[]; folds: number[]; scores: number[]; labels: (0 | 1)[]; weights: number[] };
    heldOutIsotonic: IsotonicModel[];
  };
}

export type TrainingRefusal = 'too_few_owner_albums' | 'one_class';

/** Training refused for what the library holds (not a failure to retry). */
export class TrainingRefused extends Error {
  override readonly name = 'TrainingRefused';
  constructor(readonly reason: TrainingRefusal, message: string, readonly ownerAlbums: number, readonly needed: number) { super(message); }
}

/** A stored matcher breakdown as numbers: finite numeric values only; null when it is not an object. */
export function numericBreakdown(raw: unknown): Record<string, number> | null {
  const o = typeof raw === 'string' ? (JSON.parse(raw) as unknown) : raw;
  if (!o || typeof o !== 'object' || Array.isArray(o)) return null;
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(o as Record<string, unknown>)) if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
  return out;
}

const byId = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const byDistance = <T extends { releaseId: string; distance: number }>(a: T, b: T): number => a.distance - b.distance || byId(a.releaseId, b.releaseId);

/**
 * The tracklist groups the local decider scores for an album: its
 * candidates with evidence, each release once at its best distance, grouped
 * by the decider spec's tolerances. Every group is scored (no cap: nothing
 * is sent anywhere, so a request's size does not matter).
 */
export function localDeciderGroups(
  album: { discsKnown: boolean },
  candidates: Array<{ releaseId: string; distance: number; evidence: CandidateEvidence }>,
): TracklistGroup[] {
  const seen = new Set<string>();
  const once = [...candidates].sort(byDistance).filter((c) => (seen.has(c.releaseId) ? false : (seen.add(c.releaseId), true)));
  return groupTracklists(once.map((c) => ({ releaseId: c.releaseId, distance: c.distance, evidence: c.evidence })), { discsKnown: album.discsKnown }, JEV_SPEC.grouping);
}

const sortedAlbums = (albums: TrainingAlbum[]): TrainingAlbum[] => [...albums].sort((a, b) => byId(a.albumId, b.albumId));

/** The rows to fit, album by album (sorted by id), candidates by distance; and what they count. */
export function trainingRows(albums: TrainingAlbum[]): { rows: TrainingRow[]; counts: TrainingCounts } {
  const rows: TrainingRow[] = [];
  const counts: TrainingCounts = { albums: 0, rows: 0, owner: 0, auto: 0, rejections: 0 };
  for (const a of sortedAlbums(albums)) {
    const cands = [...a.candidates].sort(byDistance);
    const ids = new Set(cands.map((c) => c.releaseId));
    const label = a.label?.releaseId ?? null;
    if (label !== null && !ids.has(label)) throw new Error(`local training: the live match of album ${a.albumId} is not among its candidates`);
    const rejected = new Set(a.rejected.filter((r) => r !== label && ids.has(r)));
    if (a.label) {
      counts.albums++;
      if (a.label.owner) counts.owner++; else counts.auto++;
    }
    for (const c of cands) {
      const isRejection = rejected.has(c.releaseId);
      if (!a.label && !isRejection) continue;
      const y: 0 | 1 = c.releaseId === label ? 1 : 0;
      const w = isRejection ? REJECTION_WEIGHT : a.label!.owner ? OWNER_WEIGHT : AUTO_WEIGHT;
      rows.push({ albumId: a.albumId, releaseId: c.releaseId, x: candidateFeatures(c.releaseId, cands), y, w, rejection: isRejection });
      if (isRejection) counts.rejections++;
    }
  }
  counts.rows = rows.length;
  return { rows, counts };
}

/** mulberry32: a small seeded generator, the same numbers on every platform. */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffled<T>(xs: T[], next: () => number): T[] {
  const out = [...xs];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/** Album id → fold (0..k-1): owner albums dealt round-robin after a seeded shuffle, then the others, so both spread evenly. */
export function assignFolds(albums: TrainingAlbum[], k: number = TRAIN_FOLDS, seed: number = TRAIN_SEED): Map<string, number> {
  if (!Number.isInteger(k) || k < 2) throw new RangeError(`local training: folds must be a whole number of at least 2 (${k})`);
  const next = seeded(seed);
  const sorted = sortedAlbums(albums);
  const owner = sorted.filter((a) => a.label?.owner === true).map((a) => a.albumId);
  const other = sorted.filter((a) => a.label?.owner !== true).map((a) => a.albumId);
  const out = new Map<string, number>();
  let i = 0;
  for (const id of [...shuffled(owner, next), ...shuffled(other, next)]) out.set(id, i++ % k);
  return out;
}

/** sha256 over the sorted (album, label release, weight) triples and the owner's rejections. */
export function trainingDataHash(albums: TrainingAlbum[]): string {
  const labels: Array<[string, string, number]> = [];
  const rejections: Array<[string, string, number]> = [];
  for (const a of albums) {
    if (a.label) labels.push([a.albumId, a.label.releaseId, a.label.owner ? OWNER_WEIGHT : AUTO_WEIGHT]);
    for (const r of a.rejected) if (r !== a.label?.releaseId) rejections.push([a.albumId, r, REJECTION_WEIGHT]);
  }
  const order = (x: [string, string, number], y: [string, string, number]) => byId(x[0], y[0]) || byId(x[1], y[1]) || x[2] - y[2];
  labels.sort(order);
  rejections.sort(order);
  return createHash('sha256').update(stableJson({ labels, rejections })).digest('hex');
}

function fit(rows: TrainingRow[], l2: number): LogisticModel {
  return fitLogistic(rows.map((r) => r.x), rows.map((r) => r.y), rows.map((r) => r.w), { l2, featureNames: LOCAL_FEATURE_NAMES });
}

/** right / sameAlbum: of the most probable group, whether or not it was picked. */
interface AlbumOutcome { pick: { band: string; probability: number } | null; right: boolean; sameAlbum: boolean; grouped: boolean }

/** One owner album, decided as a run would from its groups' calibrated probabilities. */
function decideHeldOut(a: TrainingAlbum, logistic: LogisticModel, iso: IsotonicModel): AlbumOutcome {
  const cands = [...a.candidates].sort(byDistance);
  const ids = new Set(cands.map((c) => c.releaseId));
  const usable = a.groups !== null && a.groups.length > 0 && a.groups.every((g) => g.members.every((m) => ids.has(m.releaseId)));
  const scored: Array<{ label: string; features: number[]; members: string[] }> = usable
    ? (() => {
      const members = new Map(a.groups!.map((g) => [g.label, g.members.map((m) => m.releaseId)]));
      return groupFeatures(a.groups!, cands).map((r) => ({ ...r, members: members.get(r.label)! }));
    })()
    : cands.map((c, i) => ({ label: groupLabel(i), features: candidateFeatures(c.releaseId, cands), members: [c.releaseId] }));
  const probs: Record<string, number> = {};
  for (const s of scored) probs[s.label] = applyIsotonic(iso, predictLogistic(logistic, s.features));
  const d = decideFromProbabilities(probs, JEV_SPEC, { labels: scored.map((s) => s.label) });
  const label = a.label!.releaseId;
  const rg = a.releaseGroups[label] ?? null;
  const top = scored.find((s) => s.label === d.label);
  const holds = (m: string[]) => m.includes(label);
  const sameAlbum = (m: string[]) => holds(m) || (rg !== null && m.some((r) => (a.releaseGroups[r] ?? null) === rg));
  return {
    pick: d.kind === 'pick' ? { band: d.band, probability: d.probability } : null,
    right: top ? holds(top.members) : false,
    sameAlbum: top ? sameAlbum(top.members) : false,
    grouped: usable,
  };
}

function bandRow(band: string, min: number, picked: AlbumOutcome[], albums: number): BandMetrics {
  const decided = picked.length;
  const wrongRelease = picked.filter((o) => !o.right).length;
  const wrongAlbum = picked.filter((o) => !o.sameAlbum).length;
  return {
    band, min, decided, coverage: albums === 0 ? 0 : decided / albums, wrongRelease, wrongAlbum,
    errorRate: decided === 0 ? null : wrongRelease / decided, errorUpper: clopperPearsonUpper(wrongRelease, decided),
  };
}

/**
 * Trains the local decider on `albums`. Throws TrainingRefused when the
 * owner decided fewer than `minOwnerAlbums` of them (default
 * MIN_OWNER_ALBUMS; never fewer than one per fold), or when the rows, or
 * the owner's rows, are all of one class.
 */
export function trainLocalModel(albums: TrainingAlbum[], opts: TrainOptions = {}): TrainResult {
  const k = opts.folds ?? TRAIN_FOLDS;
  const seed = opts.seed ?? TRAIN_SEED;
  const l2 = opts.l2 ?? TRAIN_L2;
  const needed = Math.max(opts.minOwnerAlbums ?? MIN_OWNER_ALBUMS, k);
  const { rows, counts } = trainingRows(albums);
  if (counts.owner < needed) {
    throw new TrainingRefused('too_few_owner_albums', `${counts.owner} albums the owner decided; training needs ${needed}`, counts.owner, needed);
  }
  const ownerIds = new Set(sortedAlbums(albums).filter((a) => a.label?.owner === true).map((a) => a.albumId));
  const ownerRows = rows.filter((r) => ownerIds.has(r.albumId));
  const twoClasses = (rs: TrainingRow[]) => rs.some((r) => r.y === 1) && rs.some((r) => r.y === 0);
  if (!twoClasses(rows) || !twoClasses(ownerRows)) {
    throw new TrainingRefused('one_class', 'the albums have no candidate besides their match, so there is nothing to tell apart', counts.owner, needed);
  }

  const foldOf = assignFolds(albums, k, seed);
  const fitAlbums: string[][] = [];
  const foldModels: LogisticModel[] = [];
  const oof = new Map<TrainingRow, number>();
  for (let f = 0; f < k; f++) {
    const fitRows = rows.filter((r) => foldOf.get(r.albumId) !== f);
    fitAlbums.push([...new Set(fitRows.map((r) => r.albumId))]);
    const m = fit(fitRows, l2);
    foldModels.push(m);
    for (const r of rows) if (foldOf.get(r.albumId) === f) oof.set(r, predictLogistic(m, r.x));
  }

  // calibration: owner albums' out-of-fold scores only
  const calibration = { albumIds: [] as string[], folds: [] as number[], scores: [] as number[], labels: [] as (0 | 1)[], weights: [] as number[] };
  for (const r of ownerRows) {
    calibration.albumIds.push(r.albumId);
    calibration.folds.push(foldOf.get(r.albumId)!);
    calibration.scores.push(oof.get(r)!);
    calibration.labels.push(r.y);
    calibration.weights.push(r.w);
  }
  const isotonic = fitIsotonic(calibration.scores, calibration.labels, calibration.weights);
  const model: LocalModel = { version: LOCAL_FEATURES_VERSION, featuresSchemaHash: featuresSchemaHash(), logistic: fit(rows, l2), isotonic };

  // held out: each fold's owner albums calibrated without their own fold
  const heldOutIsotonic: IsotonicModel[] = [];
  for (let f = 0; f < k; f++) {
    const keep = calibration.folds.map((g) => g !== f);
    const pick = <T>(xs: T[]) => xs.filter((_, i) => keep[i]);
    heldOutIsotonic.push(fitIsotonic(pick(calibration.scores), pick(calibration.labels), pick(calibration.weights)));
  }
  const outcomes = sortedAlbums(albums)
    .filter((a) => ownerIds.has(a.albumId))
    .map((a) => {
      const f = foldOf.get(a.albumId)!;
      return decideHeldOut(a, foldModels[f]!, heldOutIsotonic[f]!);
    });
  const n = outcomes.length;
  const bands = JEV_SPEC.bands.map((b) => bandRow(b.id, b.min, outcomes.filter((o) => o.pick?.band === b.id), n));
  const atOrAbove = JEV_SPEC.bands.map((b) => bandRow(b.id, b.min, outcomes.filter((o) => o.pick !== null && o.pick.probability >= b.min), n));
  const right = outcomes.filter((o) => o.right).length;
  const metrics: LocalTrainMetrics = {
    albums: n, groupedAlbums: outcomes.filter((o) => o.grouped).length, folds: k, seed, cutoff: JEV_SPEC.cutoff, margin: JEV_SPEC.margin,
    bands, atOrAbove, undecided: outcomes.filter((o) => o.pick === null).length,
    topPickRight: { right, albums: n, rate: n === 0 ? 0 : right / n },
  };

  return {
    model, version: modelVersion(model), dataHash: trainingDataHash(albums), counts, metrics,
    diagnostics: { folds: { k, foldOf, fitAlbums }, calibration, heldOutIsotonic },
  };
}
