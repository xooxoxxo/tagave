/**
 * The local decider's model: L2-regularised, weighted logistic regression on
 * standardised feature rows, followed by an isotonic calibration of its
 * output. Pure and deterministic: the same rows, labels and weights always
 * give the same model, bit for bit, and nothing here reads the network.
 *
 * - Standardisation: a weighted mean and standard deviation per feature,
 *   fitted on the training rows and stored with the model. A feature that is
 *   constant on the training rows gets std 1 (its standardised value is 0
 *   on every training row, so it gets no weight from the data).
 * - Fit: Newton steps (iteratively reweighted least squares) on the
 *   penalised log-likelihood. The penalty is l2/2 * sum(beta^2) over the
 *   standardised coefficients; the intercept is not penalised. Every step is
 *   checked with a backtracking line search, and when the Hessian cannot be
 *   factored the step is damped (a multiple of the identity is added), so
 *   duplicated or constant columns do not break the fit.
 * - Calibration: pool-adjacent-violators over the sorted scores; each
 *   finished block's value is then Laplace-smoothed, (positives + 1) /
 *   (total + 2), so no block claims a certainty of exactly 0 or 1. Blocks
 *   that smoothing leaves equal or out of order are pooled again, so the
 *   steps strictly increase. Blocks are flat between
 *   their lowest and highest score; between blocks the value is
 *   interpolated linearly, outside the range it is clamped.
 */
import { createHash } from 'node:crypto';
import { stableJson } from '../matching/evidence.js';
import { LOCAL_FEATURE_NAMES, featuresSchemaHash as currentSchemaHash } from './localFeatures.js';

export interface Standardiser { means: number[]; stds: number[] }

export interface LogisticModel {
  /** Intercept, on the standardised scale. */
  intercept: number;
  /** One per feature, on the standardised scale. */
  coefficients: number[];
  means: number[];
  stds: number[];
  featureNames: readonly string[];
  /** Fit bookkeeping: Newton steps taken and whether the change in log-likelihood fell under tol. */
  iterations: number;
  converged: boolean;
}

export interface IsotonicBlock {
  /** Lowest and highest score pooled into the block. */
  lo: number;
  hi: number;
  /** The block's smoothed share of positives: (weighted positives + 1) / (weighted total + 2). */
  p: number;
  /** Total weight pooled into the block. */
  weight: number;
}

export interface IsotonicModel { blocks: IsotonicBlock[] }

export interface LocalModel {
  /** The feature schema version the model was trained on (LOCAL_FEATURES_VERSION). */
  version: number;
  featuresSchemaHash: string;
  logistic: LogisticModel;
  isotonic: IsotonicModel;
}

export interface LogisticOptions {
  /** Penalty on the standardised coefficients (not the intercept). Default 1. */
  l2?: number;
  /** Newton steps at most. Default 100. */
  maxIter?: number;
  /** Converged when the penalised log-likelihood changes by less than this. Default 1e-10. */
  tol?: number;
  /** Names stored with the model; default f0, f1, ... */
  featureNames?: readonly string[];
}

/** Smallest distance from 0 and 1 a prediction keeps, so a probability is always strictly inside (0,1). */
const P_EDGE = 1e-15;

function finiteNumber(x: unknown, what: string): number {
  if (typeof x !== 'number' || !Number.isFinite(x)) throw new RangeError(`local model: ${what} is not a finite number (${String(x)})`);
  return x;
}

function checkWeights(w: number[], n: number): number {
  if (w.length !== n) throw new Error(`local model: ${w.length} weights for ${n} rows`);
  let total = 0;
  w.forEach((v, i) => {
    finiteNumber(v, `weight ${i}`);
    if (v < 0) throw new RangeError(`local model: weight ${i} is negative (${v})`);
    total += v;
  });
  if (!(total > 0)) throw new RangeError('local model: the weights sum to zero');
  return total;
}

function checkRows(X: number[][]): number {
  if (X.length === 0) throw new Error('local model: no training rows');
  const d = X[0]!.length;
  X.forEach((x, i) => {
    if (x.length !== d) throw new Error(`local model: row ${i} has ${x.length} features, expected ${d}`);
    x.forEach((v, j) => finiteNumber(v, `feature ${j} of row ${i}`));
  });
  return d;
}

/** Weighted mean and (population) standard deviation per feature; a constant feature gets std 1. */
export function fitStandardiser(X: number[][], w: number[] = X.map(() => 1)): Standardiser {
  const d = checkRows(X);
  const total = checkWeights(w, X.length);
  const means = new Array<number>(d).fill(0);
  for (let i = 0; i < X.length; i++) for (let j = 0; j < d; j++) means[j]! += w[i]! * X[i]![j]!;
  for (let j = 0; j < d; j++) means[j]! /= total;
  const vars = new Array<number>(d).fill(0);
  for (let i = 0; i < X.length; i++) for (let j = 0; j < d; j++) {
    const e = X[i]![j]! - means[j]!;
    vars[j]! += w[i]! * e * e;
  }
  const stds = vars.map((v, j) => {
    const s = Math.sqrt(v / total);
    // rounding noise on a column that is constant in fact
    return s > 1e-12 * Math.max(1, Math.abs(means[j]!)) && Number.isFinite(s) ? s : 1;
  });
  return { means, stds };
}

/** log(1 + e^z) without overflow. */
function softplus(z: number): number {
  return Math.max(z, 0) + Math.log1p(Math.exp(-Math.abs(z)));
}

/** 1 / (1 + e^-z) without overflow, kept strictly inside (0,1). */
function sigmoid(z: number): number {
  const p = z >= 0 ? 1 / (1 + Math.exp(-z)) : Math.exp(z) / (1 + Math.exp(z));
  return Math.min(1 - P_EDGE, Math.max(P_EDGE, p));
}

/** Solves A x = b for a symmetric positive definite A by Cholesky; null when A is not (numerically) positive definite. */
function choleskySolve(A: number[][], b: number[]): number[] | null {
  const n = b.length;
  const L = A.map(() => new Array<number>(n).fill(0));
  let maxDiag = 0;
  for (let i = 0; i < n; i++) maxDiag = Math.max(maxDiag, Math.abs(A[i]![i]!));
  const floor = 1e-12 * Math.max(maxDiag, 1e-300);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let s = A[i]![j]!;
      for (let k = 0; k < j; k++) s -= L[i]![k]! * L[j]![k]!;
      if (i === j) {
        if (!(s > floor)) return null;
        L[i]![i] = Math.sqrt(s);
      } else {
        L[i]![j] = s / L[j]![j]!;
      }
    }
  }
  const z = new Array<number>(n).fill(0);
  for (let i = 0; i < n; i++) {
    let s = b[i]!;
    for (let k = 0; k < i; k++) s -= L[i]![k]! * z[k]!;
    z[i] = s / L[i]![i]!;
  }
  const x = new Array<number>(n).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    let s = z[i]!;
    for (let k = i + 1; k < n; k++) s -= L[k]![i]! * x[k]!;
    x[i] = s / L[i]![i]!;
  }
  return x.every(Number.isFinite) ? x : null;
}

/**
 * Fits weighted logistic regression with an L2 penalty on the standardised
 * coefficients. Rows of weight 0 are allowed and count for nothing; a row of
 * weight 2 counts the same as that row twice.
 */
export function fitLogistic(X: number[][], y: (0 | 1)[], w: number[], opts: LogisticOptions = {}): LogisticModel {
  const d = checkRows(X);
  const n = X.length;
  if (y.length !== n) throw new Error(`local model: ${y.length} labels for ${n} rows`);
  y.forEach((v, i) => { if (v !== 0 && v !== 1) throw new RangeError(`local model: label ${i} is not 0 or 1 (${String(v)})`); });
  checkWeights(w, n);
  const l2 = finiteNumber(opts.l2 ?? 1, 'l2');
  if (l2 < 0) throw new RangeError(`local model: l2 is negative (${l2})`);
  const maxIter = opts.maxIter ?? 100;
  if (!Number.isInteger(maxIter) || maxIter < 1) throw new RangeError(`local model: maxIter must be a positive integer (${maxIter})`);
  const tol = finiteNumber(opts.tol ?? 1e-10, 'tol');
  const featureNames = opts.featureNames ? [...opts.featureNames] : Array.from({ length: d }, (_, j) => `f${j}`);
  if (featureNames.length !== d) throw new Error(`local model: ${featureNames.length} feature names for ${d} features`);

  const { means, stds } = fitStandardiser(X, w);
  // design rows: a leading 1 for the intercept, then the standardised features
  const Z = X.map((x) => [1, ...x.map((v, j) => (v - means[j]!) / stds[j]!)]);
  const k = d + 1;

  const logits = (beta: number[]): number[] => Z.map((z) => {
    let s = 0;
    for (let j = 0; j < k; j++) s += z[j]! * beta[j]!;
    return s;
  });
  // penalised log-likelihood: sum w (y z - log(1 + e^z)) - l2/2 |beta without intercept|^2
  const objective = (beta: number[]): number => {
    const eta = logits(beta);
    let ll = 0;
    for (let i = 0; i < n; i++) if (w[i]! > 0) ll -= w[i]! * (y[i] === 1 ? softplus(-eta[i]!) : softplus(eta[i]!));
    let pen = 0;
    for (let j = 1; j < k; j++) pen += beta[j]! * beta[j]!;
    return ll - 0.5 * l2 * pen;
  };

  let beta = new Array<number>(k).fill(0);
  let obj = objective(beta);
  let iterations = 0;
  let converged = false;
  while (iterations < maxIter) {
    iterations++;
    const eta = logits(beta);
    const g = new Array<number>(k).fill(0);
    const H = Array.from({ length: k }, () => new Array<number>(k).fill(0));
    for (let i = 0; i < n; i++) {
      const wi = w[i]!;
      if (wi === 0) continue;
      const p = 1 / (1 + Math.exp(-eta[i]!));
      const r = wi * (y[i]! - p);
      const h = wi * p * (1 - p);
      const z = Z[i]!;
      for (let a = 0; a < k; a++) {
        g[a]! += r * z[a]!;
        const hz = h * z[a]!;
        for (let b = 0; b <= a; b++) H[a]![b]! += hz * z[b]!;
      }
    }
    for (let a = 0; a < k; a++) for (let b = 0; b < a; b++) H[b]![a] = H[a]![b]!;
    for (let j = 1; j < k; j++) {
      g[j]! -= l2 * beta[j]!;
      H[j]![j]! += l2;
    }

    // Newton step; when H is ill-conditioned, damp it with a growing multiple of the identity
    let step = choleskySolve(H, g);
    if (step === null) {
      let trace = 0;
      for (let j = 0; j < k; j++) trace += H[j]![j]!;
      let damping = Math.max(1e-10 * (trace / k), 1e-12);
      while (step === null && damping < 1e12) {
        const Hd = H.map((row, a) => row.map((v, b) => (a === b ? v + damping : v)));
        step = choleskySolve(Hd, g);
        damping *= 10;
      }
    }
    if (step === null) break;

    // backtracking: never accept a step that lowers the objective
    let t = 1;
    let next = beta;
    let nextObj = obj;
    for (let halvings = 0; halvings < 40; halvings++) {
      const cand = beta.map((b, j) => b + t * step![j]!);
      const candObj = objective(cand);
      if (candObj >= obj) { next = cand; nextObj = candObj; break; }
      t /= 2;
    }
    const change = nextObj - obj;
    beta = next;
    obj = nextObj;
    if (Math.abs(change) < tol) { converged = true; break; }
  }

  return { intercept: beta[0]!, coefficients: beta.slice(1), means, stds, featureNames, iterations, converged };
}

/** The model's probability for one raw (unstandardised) feature row, strictly inside (0,1). */
export function predictLogistic(model: LogisticModel, x: number[]): number {
  const d = model.coefficients.length;
  if (x.length !== d) throw new RangeError(`local model: ${x.length} features, the model takes ${d}`);
  let z = model.intercept;
  for (let j = 0; j < d; j++) z += model.coefficients[j]! * ((finiteNumber(x[j], `feature ${j}`) - model.means[j]!) / model.stds[j]!);
  // finite inputs far outside the training range can overflow into inf - inf
  if (Number.isNaN(z)) throw new RangeError('local model: the logit of this row is not defined (inputs far outside the training range)');
  return sigmoid(z);
}

/**
 * Isotonic regression by pool-adjacent-violators: monotone blocks over the
 * sorted scores, each valued (weighted positives + 1) / (weighted total + 2).
 * Equal scores are pooled first, so tied rows always share one value
 * whatever their order. Rows of weight 0 are dropped.
 */
export function fitIsotonic(scores: number[], labels: (0 | 1)[], weights?: number[]): IsotonicModel {
  const n = scores.length;
  if (n === 0) throw new Error('isotonic: no scores');
  if (labels.length !== n) throw new Error(`isotonic: ${labels.length} labels for ${n} scores`);
  const w = weights ?? scores.map(() => 1);
  checkWeights(w, n);
  const rows: Array<{ s: number; y: number; w: number }> = [];
  for (let i = 0; i < n; i++) {
    const s = finiteNumber(scores[i], `score ${i}`);
    if (labels[i] !== 0 && labels[i] !== 1) throw new RangeError(`isotonic: label ${i} is not 0 or 1 (${String(labels[i])})`);
    if (w[i]! > 0) rows.push({ s, y: labels[i]!, w: w[i]! });
  }
  rows.sort((a, b) => a.s - b.s);

  // blocks carry the weighted label sum so the pooled value is exact
  type Block = { lo: number; hi: number; sum: number; weight: number };
  const raw = (b: Block): number => b.sum / b.weight;
  const smoothed = (b: Block): number => (b.sum + 1) / (b.weight + 2);
  /** Pushes a block, then pools while the last two violate (or tie) the order under `value`. */
  const pool = (stack: Block[], next: Block, value: (b: Block) => number): void => {
    stack.push(next);
    while (stack.length > 1 && value(stack[stack.length - 2]!) >= value(stack[stack.length - 1]!)) {
      const b = stack.pop()!;
      const a = stack[stack.length - 1]!;
      a.hi = b.hi;
      a.sum += b.sum;
      a.weight += b.weight;
    }
  };
  // plain PAV on the weighted share of positives, equal scores pooled first
  const blocks: Block[] = [];
  for (const r of rows) {
    const top = blocks[blocks.length - 1];
    if (top && top.hi === r.s) {
      top.sum += r.w * r.y;
      top.weight += r.w;
      // the grown block may now violate the order with the one before it
      const last = blocks.pop()!;
      pool(blocks, last, raw);
    } else {
      pool(blocks, { lo: r.s, hi: r.s, sum: r.w * r.y, weight: r.w }, raw);
    }
  }
  // smoothing can make neighbours equal or out of order (a small pure block
  // is pulled further toward 1/2 than a large one); pool those again
  const stack: Block[] = [];
  for (const b of blocks) pool(stack, { ...b }, smoothed);
  return { blocks: stack.map((b) => ({ lo: b.lo, hi: b.hi, p: smoothed(b), weight: b.weight })) };
}

/** The calibrated value of a score: flat within a block, linear between blocks, clamped outside. */
export function applyIsotonic(model: IsotonicModel, s: number): number {
  finiteNumber(s, 'score');
  const blocks = model.blocks;
  if (blocks.length === 0) throw new Error('isotonic: the model has no blocks');
  if (s <= blocks[0]!.hi) return blocks[0]!.p;
  // binary search for the first block whose hi is >= s
  let lo = 1;
  let hi = blocks.length - 1;
  if (s >= blocks[hi]!.lo) return blocks[hi]!.p;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (blocks[mid]!.hi < s) lo = mid + 1;
    else hi = mid;
  }
  const b = blocks[lo]!;
  if (s >= b.lo) return b.p;
  const a = blocks[lo - 1]!;
  const t = (s - a.hi) / (b.lo - a.hi);
  return a.p + t * (b.p - a.p);
}

/**
 * The calibrated probability for one feature row. Throws a RangeError when
 * the model was trained on another feature schema, when the row's length
 * does not match, or when a value is not finite.
 */
export function calibratedProbability(local: LocalModel, features: number[]): number {
  if (local.featuresSchemaHash !== currentSchemaHash()) {
    throw new RangeError('local model: trained on another feature schema; retrain it');
  }
  const names = local.logistic.featureNames;
  if (names.length !== LOCAL_FEATURE_NAMES.length || names.some((nm, j) => nm !== LOCAL_FEATURE_NAMES[j])) {
    throw new RangeError('local model: its feature names do not match the current schema');
  }
  if (features.length !== local.logistic.coefficients.length) {
    throw new RangeError(`local model: ${features.length} features, the model takes ${local.logistic.coefficients.length}`);
  }
  features.forEach((v, j) => finiteNumber(v, `feature ${LOCAL_FEATURE_NAMES[j]}`));
  return applyIsotonic(local.isotonic, predictLogistic(local.logistic, features));
}

/** Significant digits kept in the version hash: far above fitting noise, far below any real change. */
const VERSION_DIGITS = 10;

function rounded(x: number): number {
  const r = Number(finiteNumber(x, 'model value').toPrecision(VERSION_DIGITS));
  return r === 0 ? 0 : r; // -0 and 0 hash the same
}

/**
 * The model's version: 'local@' + the first 12 hex characters of a sha256
 * over its coefficients, standardisation, isotonic blocks and feature schema,
 * rounded so the same data always gives the same version.
 */
export function modelVersion(m: LocalModel): string {
  const view = {
    featuresVersion: m.version,
    featuresSchemaHash: m.featuresSchemaHash,
    featureNames: [...m.logistic.featureNames],
    intercept: rounded(m.logistic.intercept),
    coefficients: m.logistic.coefficients.map(rounded),
    means: m.logistic.means.map(rounded),
    stds: m.logistic.stds.map(rounded),
    isotonic: m.isotonic.blocks.map((b) => [rounded(b.lo), rounded(b.hi), rounded(b.p)]),
  };
  return `local@${createHash('sha256').update(stableJson(view)).digest('hex').slice(0, 12)}`;
}
