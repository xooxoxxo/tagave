import { describe, it, expect } from 'vitest';
import { bandGate, checksStillNeeded, clopperPearsonUpper, minCleanChecks } from './clopperPearson.js';

describe('clopperPearsonUpper (one-sided 95%)', () => {
  it.each([
    [0, 300, 0.009936], [0, 299, 0.009969], [0, 298, 0.010002], [1, 300, 0.015715],
    [2, 500, 0.012538], [5, 100, 0.102253], [0, 1, 0.95],
  ])('%i errors in %i checks → %f', (x, n, want) => expect(clopperPearsonUpper(x, n)).toBeCloseTo(want, 5));
  it('all wrong is 1; no checks is 1', () => {
    expect(clopperPearsonUpper(3, 3)).toBe(1);
    expect(clopperPearsonUpper(0, 0)).toBe(1);
  });
  it('refuses nonsense', () => {
    expect(() => clopperPearsonUpper(4, 3)).toThrow();
    expect(() => clopperPearsonUpper(-1, 3)).toThrow();
  });
});

describe('the gate', () => {
  it('1% needs 299 clean checks; 5% needs 59', () => {
    expect(minCleanChecks(0.01)).toBe(299);
    expect(minCleanChecks(0.05)).toBe(59);
  });
  it('298 clean checks are not enough for 1%; 299 are', () => {
    expect(bandGate(0, 298, 0.01)).toMatchObject({ allowed: false, stillNeeded: 1 });
    expect(bandGate(0, 299, 0.01)).toMatchObject({ allowed: true, stillNeeded: 0 });
  });
  it('one error moves the goal: about 473 checks in all', () => {
    const g = bandGate(1, 300, 0.01);
    expect(g.allowed).toBe(false);
    expect(300 + g.stillNeeded).toBe(473);
  });
  it('checksStillNeeded is 0 when the gate is open', () => expect(checksStillNeeded(0, 400, 0.01)).toBe(0));
});

// Independent reference: the binomial CDF summed term by term in log space
// (each term from the previous one by the ratio of binomial coefficients),
// and the bound found by plain bisection on it.
function bruteCdf(x: number, n: number, p: number): number {
  const lp = Math.log(p);
  const lq = Math.log1p(-p);
  let logTerm = n * lq; // k = 0
  let maxLog = logTerm;
  const logs = [logTerm];
  for (let k = 1; k <= x; k++) {
    logTerm += Math.log(n - k + 1) - Math.log(k) + lp - lq;
    logs.push(logTerm);
    if (logTerm > maxLog) maxLog = logTerm;
  }
  let s = 0;
  for (const l of logs) s += Math.exp(l - maxLog);
  return Math.exp(maxLog + Math.log(s));
}
function bruteUpper(x: number, n: number, confidence = 0.95): number {
  if (n === 0 || x === n) return 1;
  const alpha = 1 - confidence;
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 200 && hi - lo > 0; i++) {
    const mid = (lo + hi) / 2;
    if (mid === lo || mid === hi) break;
    if (bruteCdf(x, n, mid) > alpha) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}

describe('agrees with brute force', () => {
  it('every errors/checks pair up to 40 checks, at three confidences', () => {
    for (const c of [0.8, 0.95, 0.99]) {
      for (let n = 1; n <= 40; n++) {
        for (let x = 0; x <= n; x++) {
          expect(Math.abs(clopperPearsonUpper(x, n, c) - bruteUpper(x, n, c))).toBeLessThan(1e-9);
        }
      }
    }
  });
  it('large counts stay accurate (up to 100,000 checks)', () => {
    for (const [x, n] of [[1000, 100_000], [10, 100_000], [37, 5000], [2500, 10_000], [99_000, 100_000]] as const) {
      const want = bruteUpper(x, n);
      expect(Math.abs(clopperPearsonUpper(x, n) - want) / want).toBeLessThan(1e-7);
    }
  });
  it('no errors matches the closed form 1 − α^(1/n)', () => {
    for (const n of [1, 2, 10, 299, 1000, 100_000]) {
      for (const c of [0.9, 0.95, 0.99]) {
        expect(clopperPearsonUpper(0, n, c)).toBeCloseTo(1 - Math.pow(1 - c, 1 / n), 12);
      }
    }
  });
  it('rises with errors and falls with checks', () => {
    for (let x = 0; x < 20; x++) expect(clopperPearsonUpper(x + 1, 500)).toBeGreaterThan(clopperPearsonUpper(x, 500));
    for (let n = 20; n < 60; n++) expect(clopperPearsonUpper(3, n + 1)).toBeLessThan(clopperPearsonUpper(3, n));
  });
});

describe('the gate, at its edges', () => {
  it('minCleanChecks is the exact first n the gate opens at', () => {
    for (const [rate, c] of [[0.01, 0.95], [0.05, 0.95], [0.001, 0.99], [0.02, 0.9], [0.5, 0.5]] as const) {
      const n = minCleanChecks(rate, c);
      expect(clopperPearsonUpper(0, n, c)).toBeLessThanOrEqual(rate);
      if (n > 1) expect(clopperPearsonUpper(0, n - 1, c)).toBeGreaterThan(rate);
      expect(bandGate(0, n, rate, c).allowed).toBe(true);
      expect(bandGate(0, n - 1, rate, c).allowed).toBe(false);
    }
  });
  it('stillNeeded lands exactly on the first open gate', () => {
    for (const [x, n] of [[1, 300], [2, 10], [5, 100], [3, 400]] as const) {
      const need = checksStillNeeded(x, n, 0.01);
      expect(need).toBeGreaterThan(0);
      expect(clopperPearsonUpper(x, n + need)).toBeLessThanOrEqual(0.01);
      expect(clopperPearsonUpper(x, n + need - 1)).toBeGreaterThan(0.01);
    }
  });
  it('unreachable within 100,000 more checks is Infinity, and quick', () => {
    const t = performance.now();
    expect(checksStillNeeded(2000, 2000, 0.01)).toBe(Infinity);
    expect(bandGate(5000, 10_000, 0.01)).toMatchObject({ allowed: false, stillNeeded: Infinity });
    expect(performance.now() - t).toBeLessThan(2000);
  });
  it('no checks yet needs the full clean count', () => {
    expect(bandGate(0, 0, 0.01)).toEqual({ checks: 0, errors: 0, upper: 1, allowed: false, stillNeeded: 299 });
  });
});

describe('input checks', () => {
  it.each([
    ['errors above checks', () => clopperPearsonUpper(4, 3)],
    ['negative errors', () => clopperPearsonUpper(-1, 3)],
    ['negative checks', () => clopperPearsonUpper(0, -3)],
    ['fractional errors', () => clopperPearsonUpper(0.5, 3)],
    ['fractional checks', () => bandGate(0, 2.5, 0.01)],
    ['NaN checks', () => clopperPearsonUpper(0, NaN)],
    ['confidence 0', () => clopperPearsonUpper(0, 3, 0)],
    ['confidence 1', () => clopperPearsonUpper(0, 3, 1)],
    ['confidence NaN', () => minCleanChecks(0.01, NaN)],
    ['maxRate 0', () => minCleanChecks(0)],
    ['maxRate 1', () => checksStillNeeded(0, 3, 1)],
    ['maxRate negative', () => bandGate(0, 3, -0.1)],
    ['maxRate NaN', () => bandGate(0, 3, NaN)],
  ])('%s is a RangeError', (_label, call) => expect(call).toThrow(RangeError));
});
