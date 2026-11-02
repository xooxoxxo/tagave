import { describe, it, expect } from 'vitest';
import { LOCAL_FEATURES_VERSION, LOCAL_FEATURE_NAMES, featuresSchemaHash } from './localFeatures.js';
import {
  fitStandardiser, fitLogistic, predictLogistic, fitIsotonic, applyIsotonic,
  calibratedProbability, modelVersion, type LocalModel, type LogisticModel,
} from './localModel.js';

/** A small deterministic generator, so the datasets are the same on every run. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

/** The penalised log-likelihood gradient at the fitted model, in standardised space (intercept first). */
function gradient(m: LogisticModel, X: number[][], y: (0 | 1)[], w: number[], l2: number): number[] {
  const g = new Array(m.coefficients.length + 1).fill(0) as number[];
  X.forEach((x, i) => {
    const r = w[i]! * (y[i]! - predictLogistic(m, x));
    g[0]! += r;
    x.forEach((v, j) => { g[j + 1]! += r * ((v - m.means[j]!) / m.stds[j]!); });
  });
  m.coefficients.forEach((b, j) => { g[j + 1]! -= l2 * b; });
  return g;
}

/** A noisy two-feature dataset: y depends on x0 and x1, not on x2. */
function noisy(n: number, seed = 7): { X: number[][]; y: (0 | 1)[] } {
  const r = rng(seed);
  const X: number[][] = [];
  const y: (0 | 1)[] = [];
  for (let i = 0; i < n; i++) {
    const x = [r() * 4 - 2, r() * 10, r()];
    const z = 1.5 * x[0]! - 0.3 * x[1]! + 1;
    X.push(x);
    y.push(r() < 1 / (1 + Math.exp(-z)) ? 1 : 0);
  }
  return { X, y };
}

describe('feature standardisation', () => {
  it('fits a weighted mean and standard deviation; a constant feature gets std 1', () => {
    const s = fitStandardiser([[1, 5], [3, 5], [5, 5]], [1, 1, 2]);
    expect(s.means[0]).toBeCloseTo(3.5, 12);
    expect(s.stds[0]).toBeCloseTo(Math.sqrt((6.25 + 0.25 + 2 * 2.25) / 4), 12);
    expect(s.means[1]).toBe(5);
    expect(s.stds[1]).toBe(1);
  });
});

describe('fitLogistic', () => {
  it('keeps coefficients finite on linearly separable data', () => {
    const X = [[-3], [-2], [-1], [-0.5], [0.5], [1], [2], [3]];
    const y: (0 | 1)[] = [0, 0, 0, 0, 1, 1, 1, 1];
    const m = fitLogistic(X, y, X.map(() => 1));
    expect(m.converged).toBe(true);
    expect(Number.isFinite(m.intercept)).toBe(true);
    for (const b of m.coefficients) expect(Number.isFinite(b)).toBe(true);
    expect(m.coefficients[0]).toBeGreaterThan(0);
    expect(predictLogistic(m, [3])).toBeGreaterThan(0.85);
    expect(predictLogistic(m, [-3])).toBeLessThan(0.15);
    // a tiny penalty still keeps the separable fit finite, only steeper
    const steep = fitLogistic(X, y, X.map(() => 1), { l2: 1e-3 });
    expect(steep.converged).toBe(true);
    expect(Number.isFinite(steep.coefficients[0]!)).toBe(true);
    expect(steep.coefficients[0]!).toBeGreaterThan(m.coefficients[0]!);
  });

  it('a stronger penalty shrinks the coefficient', () => {
    const X = [[-3], [-2], [-1], [-0.5], [0.5], [1], [2], [3]];
    const y: (0 | 1)[] = [0, 0, 0, 0, 1, 1, 1, 1];
    const w = X.map(() => 1);
    expect(fitLogistic(X, y, w, { l2: 10 }).coefficients[0]!).toBeLessThan(fitLogistic(X, y, w, { l2: 1 }).coefficients[0]!);
  });

  it('1-D: the penalised gradient is zero at the solution', () => {
    const X = [[0.1], [0.4], [0.5], [0.9], [1.3], [1.6], [2.0], [2.2], [2.9], [3.5]];
    const y: (0 | 1)[] = [0, 0, 1, 0, 0, 1, 1, 0, 1, 1];
    const w = X.map(() => 1);
    for (const l2 of [0, 0.5, 1, 4]) {
      const m = fitLogistic(X, y, w, { l2 });
      expect(m.converged).toBe(true);
      for (const g of gradient(m, X, y, w, l2)) expect(Math.abs(g)).toBeLessThan(1e-8);
    }
  });

  it('several features with weights: the penalised gradient is zero, the intercept unpenalised', () => {
    const { X, y } = noisy(200);
    const w = X.map((_, i) => 0.5 + (i % 3));
    const m = fitLogistic(X, y, w, { l2: 2 });
    expect(m.converged).toBe(true);
    for (const g of gradient(m, X, y, w, 2)) expect(Math.abs(g)).toBeLessThan(1e-7);
    expect(m.coefficients[0]).toBeGreaterThan(0);
    expect(m.coefficients[1]).toBeLessThan(0);
    expect(m.featureNames).toEqual(['f0', 'f1', 'f2']);
    expect(m.iterations).toBeGreaterThan(0);
  });

  it('a row of weight 2 fits the same model as that row twice', () => {
    const { X, y } = noisy(40, 11);
    const doubledX = [...X, X[5]!];
    const doubledY = [...y, y[5]!];
    const a = fitLogistic(doubledX, doubledY, doubledX.map(() => 1));
    const b = fitLogistic(X, y, X.map((_, i) => (i === 5 ? 2 : 1)));
    expect(a.intercept).toBeCloseTo(b.intercept, 9);
    a.coefficients.forEach((c, j) => expect(c).toBeCloseTo(b.coefficients[j]!, 9));
    a.means.forEach((c, j) => expect(c).toBeCloseTo(b.means[j]!, 12));
    a.stds.forEach((c, j) => expect(c).toBeCloseTo(b.stds[j]!, 12));
  });

  it('weights matter: weighting the positives up raises the intercept', () => {
    const { X, y } = noisy(60, 3);
    const plain = fitLogistic(X, y, X.map(() => 1));
    const heavy = fitLogistic(X, y, y.map((v) => (v === 1 ? 5 : 1)));
    expect(heavy.intercept).toBeGreaterThan(plain.intercept);
  });

  it('is deterministic', () => {
    const { X, y } = noisy(80);
    const w = X.map(() => 1);
    expect(fitLogistic(X, y, w)).toEqual(fitLogistic(X, y, w));
  });

  it('handles a constant and a duplicated column without the penalty (damped steps)', () => {
    const { X, y } = noisy(50, 5);
    const X2 = X.map((x) => [x[0]!, x[0]!, 7]);
    const m = fitLogistic(X2, y, X2.map(() => 1), { l2: 0 });
    for (const b of [m.intercept, ...m.coefficients]) expect(Number.isFinite(b)).toBe(true);
    expect(m.stds[2]).toBe(1);
    expect(m.coefficients[2]).toBe(0);
  });

  it('stops at maxIter and says it did not converge', () => {
    const { X, y } = noisy(50);
    const m = fitLogistic(X, y, X.map(() => 1), { maxIter: 1 });
    expect(m.iterations).toBe(1);
    expect(m.converged).toBe(false);
  });

  it('rejects bad input', () => {
    expect(() => fitLogistic([], [], [])).toThrow();
    expect(() => fitLogistic([[1], [2]], [0], [1, 1])).toThrow();
    expect(() => fitLogistic([[1], [2, 3]], [0, 1], [1, 1])).toThrow();
    expect(() => fitLogistic([[1], [NaN]], [0, 1], [1, 1])).toThrow(RangeError);
    expect(() => fitLogistic([[1], [2]], [0, 1], [1, -1])).toThrow(RangeError);
    expect(() => fitLogistic([[1], [2]], [0, 1], [0, 0])).toThrow(RangeError);
    expect(() => fitLogistic([[1], [2]], [0, 2 as 1], [1, 1])).toThrow(RangeError);
  });
});

describe('predictLogistic', () => {
  const m: LogisticModel = {
    intercept: 0, coefficients: [1000], means: [0], stds: [1], featureNames: ['x'], iterations: 0, converged: true,
  };

  it('stays in (0,1) and never NaN for extreme logits', () => {
    for (const x of [-1e300, -1e6, -800, -40, 0, 40, 800, 1e6, 1e300]) {
      const p = predictLogistic(m, [x]);
      expect(Number.isNaN(p)).toBe(false);
      expect(p).toBeGreaterThan(0);
      expect(p).toBeLessThan(1);
    }
    expect(predictLogistic(m, [0])).toBe(0.5);
    expect(predictLogistic(m, [1e6])).toBeGreaterThan(predictLogistic(m, [-1e6]));
  });

  it('throws on a wrong length or a non-finite input', () => {
    expect(() => predictLogistic(m, [1, 2])).toThrow(RangeError);
    expect(() => predictLogistic(m, [Infinity])).toThrow(RangeError);
    expect(() => predictLogistic(m, [NaN])).toThrow(RangeError);
  });
});

describe('isotonic calibration (pool-adjacent-violators)', () => {
  it('matches a hand-worked example', () => {
    // labels by score: 0 1 0 0 1 1 -> pool (1,0,0) at 0.2..0.4 into 1/3
    const m = fitIsotonic([0.1, 0.2, 0.3, 0.4, 0.5, 0.6], [0, 1, 0, 0, 1, 1]);
    expect(m.blocks.map((b) => [b.lo, b.hi, b.p])).toEqual([
      [0.1, 0.1, 0], [0.2, 0.4, 1 / 3], [0.5, 0.6, 1],
    ]);
    expect(applyIsotonic(m, 0.1)).toBe(0);
    expect(applyIsotonic(m, 0.3)).toBeCloseTo(1 / 3, 12);
    expect(applyIsotonic(m, 0.15)).toBeCloseTo(1 / 6, 12); // halfway between the edges 0.1 and 0.2
    expect(applyIsotonic(m, 0.45)).toBeCloseTo(2 / 3, 12);
    expect(applyIsotonic(m, -5)).toBe(0); // clamped below
    expect(applyIsotonic(m, 5)).toBe(1); // clamped above
  });

  it('uses weights, and sorts its input', () => {
    // order shuffled; weight 3 on the 0.3 negative pulls the pooled block down
    const m = fitIsotonic([0.3, 0.1, 0.2], [0, 0, 1], [3, 1, 1]);
    expect(m.blocks.map((b) => [b.lo, b.hi, b.p])).toEqual([[0.1, 0.1, 0], [0.2, 0.3, 0.25]]);
  });

  it('pools equal scores', () => {
    const m = fitIsotonic([0.5, 0.5, 0.5, 0.9], [1, 0, 0, 1]);
    expect(m.blocks.map((b) => [b.lo, b.hi, b.p])).toEqual([[0.5, 0.5, 1 / 3], [0.9, 0.9, 1]]);
    // the order of tied rows does not matter
    expect(fitIsotonic([0.5, 0.5, 0.5, 0.9], [0, 0, 1, 1])).toEqual(m);
  });

  it('is monotone non-decreasing everywhere', () => {
    const r = rng(42);
    const scores = Array.from({ length: 300 }, () => Math.round(r() * 50) / 50);
    const labels = scores.map((s) => (r() < s ? 1 : 0)) as (0 | 1)[];
    const m = fitIsotonic(scores, labels);
    for (let i = 1; i < m.blocks.length; i++) {
      expect(m.blocks[i]!.p).toBeGreaterThan(m.blocks[i - 1]!.p);
      expect(m.blocks[i]!.lo).toBeGreaterThan(m.blocks[i - 1]!.hi);
    }
    let prev = -Infinity;
    for (let s = -0.1; s <= 1.1; s += 0.001) {
      const p = applyIsotonic(m, s);
      expect(p).toBeGreaterThanOrEqual(prev);
      expect(p).toBeGreaterThanOrEqual(0);
      expect(p).toBeLessThanOrEqual(1);
      prev = p;
    }
  });

  it('maps well-separated scores to about 0 and 1', () => {
    const scores = [0.01, 0.02, 0.03, 0.05, 0.06, 0.94, 0.95, 0.97, 0.98, 0.99];
    const m = fitIsotonic(scores, [0, 0, 0, 0, 0, 1, 1, 1, 1, 1]);
    expect(applyIsotonic(m, 0.02)).toBeLessThan(0.01);
    expect(applyIsotonic(m, 0.97)).toBeGreaterThan(0.99);
  });

  it('rejects bad input', () => {
    expect(() => fitIsotonic([], [])).toThrow();
    expect(() => fitIsotonic([0.1], [0, 1])).toThrow();
    expect(() => fitIsotonic([NaN], [1])).toThrow(RangeError);
    expect(() => fitIsotonic([0.1], [1], [-1])).toThrow(RangeError);
    expect(() => applyIsotonic(fitIsotonic([0.1], [1]), NaN)).toThrow(RangeError);
  });
});

describe('the local model', () => {
  const n = LOCAL_FEATURE_NAMES.length;
  function trained(seed = 9): LocalModel {
    const r = rng(seed);
    const X: number[][] = [];
    const y: (0 | 1)[] = [];
    for (let i = 0; i < 120; i++) {
      const x = Array.from({ length: n }, () => r());
      X.push(x);
      y.push(r() < 1 / (1 + Math.exp(-(4 * x[0]! - 4 * x[1]!))) ? 1 : 0);
    }
    const logistic = fitLogistic(X, y, X.map(() => 1), { featureNames: LOCAL_FEATURE_NAMES });
    const isotonic = fitIsotonic(X.map((x) => predictLogistic(logistic, x)), y);
    return { version: LOCAL_FEATURES_VERSION, featuresSchemaHash: featuresSchemaHash(), logistic, isotonic };
  }

  it('gives the isotonic value of the logistic output', () => {
    const m = trained();
    const x = Array.from({ length: n }, (_, i) => (i === 0 ? 0.9 : 0.2));
    const p = calibratedProbability(m, x);
    expect(p).toBe(applyIsotonic(m.isotonic, predictLogistic(m.logistic, x)));
    expect(p).toBeGreaterThanOrEqual(0);
    expect(p).toBeLessThanOrEqual(1);
  });

  it('never returns NaN for extreme inputs', () => {
    const m = trained();
    for (const v of [-1e300, -1e9, 0, 1e9, 1e300]) {
      const p = calibratedProbability(m, new Array(n).fill(v) as number[]);
      expect(Number.isNaN(p)).toBe(false);
    }
  });

  it('throws on a wrong feature length, a schema mismatch or a non-finite input', () => {
    const m = trained();
    const x = new Array(n).fill(0.5) as number[];
    expect(() => calibratedProbability(m, x.slice(1))).toThrow(RangeError);
    expect(() => calibratedProbability({ ...m, featuresSchemaHash: 'other' }, x)).toThrow(RangeError);
    expect(() => calibratedProbability(m, [...x.slice(1), NaN])).toThrow(RangeError);
    expect(() => calibratedProbability(m, [...x.slice(1), Infinity])).toThrow(RangeError);
    const renamed = { ...m, logistic: { ...m.logistic, featureNames: [...m.logistic.featureNames].reverse() } };
    expect(() => calibratedProbability(renamed, x)).toThrow(RangeError);
  });

  it('has a stable version that any coefficient change changes', () => {
    const a = trained();
    const v = modelVersion(a);
    expect(v).toMatch(/^local@[0-9a-f]{12}$/);
    expect(modelVersion(trained())).toBe(v);
    // fitting noise far below the rounding does not change it
    const nudged = { ...a, logistic: { ...a.logistic, intercept: a.logistic.intercept * (1 + 1e-15) } };
    expect(modelVersion(nudged)).toBe(v);
    const coefficients = [...a.logistic.coefficients];
    coefficients[3] = coefficients[3]! + 1e-3;
    expect(modelVersion({ ...a, logistic: { ...a.logistic, coefficients } })).not.toBe(v);
    const blocks = a.isotonic.blocks.map((b, i) => (i === 0 ? { ...b, p: b.p + 1e-3 } : b));
    expect(modelVersion({ ...a, isotonic: { blocks } })).not.toBe(v);
    expect(modelVersion({ ...a, featuresSchemaHash: 'other' })).not.toBe(v);
    // the fit's bookkeeping is not part of the model
    expect(modelVersion({ ...a, logistic: { ...a.logistic, iterations: 99, converged: false } })).toBe(v);
    expect(modelVersion(trained(10))).not.toBe(v);
  });
});
