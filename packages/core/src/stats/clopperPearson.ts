/**
 * How sure a band's spot checks make us of its error rate.
 *
 * The one-sided Clopper–Pearson upper bound is the error rate p at which
 * seeing this few errors (or fewer) would happen only (1 − confidence) of the
 * time: P(X ≤ errors | checks, p) = 1 − confidence. The binomial CDF is the
 * regularized incomplete beta I_{1−p}(checks − errors, errors + 1), computed
 * in log space with a continued fraction, so it stays accurate for counts up
 * to 100,000 and beyond. The bound is solved by bisection (the CDF falls as
 * p rises). With no errors it has the closed form 1 − (1 − confidence)^(1/checks):
 * 299 clean checks bound the rate under 1% at 95%.
 *
 * A gate is open when the bound is at most maxRate, compared exactly
 * (`upper <= maxRate`, no tolerance); every count here is derived from that
 * same comparison, so the counts and the gate never disagree.
 */

/** How many more checks we look for before calling a goal unreachable. */
const SEARCH_LIMIT = 100_000;

const LANCZOS = [
  0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
  -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6,
  1.5056327351493116e-7,
];

/** ln Γ(z) for z > 0 (Lanczos, g = 7). */
function logGamma(z: number): number {
  if (z < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * z)) - logGamma(1 - z);
  const x = z - 1;
  let a = LANCZOS[0]!;
  const t = x + 7.5;
  for (let i = 1; i < 9; i++) a += LANCZOS[i]! / (x + i);
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}

/** Continued fraction for the incomplete beta (modified Lentz). */
function betaContinuedFraction(a: number, b: number, x: number): number {
  const tiny = 1e-300;
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < tiny) d = tiny;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= 100_000; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < tiny) d = tiny;
    c = 1 + aa / c;
    if (Math.abs(c) < tiny) c = tiny;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < tiny) d = tiny;
    c = 1 + aa / c;
    if (Math.abs(c) < tiny) c = tiny;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < 1e-15) return h;
  }
  return h;
}

/** Regularized incomplete beta I_x(a, b), a, b > 0. */
function regularizedBeta(x: number, a: number, b: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const logFront = logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log1p(-x);
  // The continued fraction converges fast on this side; use symmetry on the other.
  if (x < (a + 1) / (a + b + 2)) return (Math.exp(logFront) * betaContinuedFraction(a, b, x)) / a;
  return 1 - (Math.exp(logFront) * betaContinuedFraction(b, a, 1 - x)) / b;
}

/** P(X ≤ x) for X ~ Binomial(n, p), with 0 ≤ x < n. */
function binomialCdf(x: number, n: number, p: number): number {
  if (p <= 0) return 1;
  if (p >= 1) return 0;
  return regularizedBeta(1 - p, n - x, x + 1);
}

function checkCounts(errors: number, checks: number): void {
  if (!Number.isInteger(errors) || !Number.isInteger(checks) || errors < 0 || checks < 0 || errors > checks) {
    throw new RangeError(`not a count of errors in checks: ${errors} of ${checks}`);
  }
}

function checkUnit(name: string, v: number): void {
  if (!(v > 0 && v < 1)) throw new RangeError(`${name} must be between 0 and 1 (exclusive): ${v}`);
}

/** One-sided upper confidence bound on an error rate from `errors` in `checks` (Clopper–Pearson). checks 0 → 1. */
export function clopperPearsonUpper(errors: number, checks: number, confidence = 0.95): number {
  checkCounts(errors, checks);
  checkUnit('confidence', confidence);
  if (checks === 0 || errors === checks) return 1;
  const alpha = 1 - confidence;
  if (errors === 0) return -Math.expm1(Math.log(alpha) / checks);
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    if (mid <= lo || mid >= hi) break;
    if (binomialCdf(errors, checks, mid) > alpha) lo = mid; else hi = mid;
  }
  return hi;
}

/** Fewest clean (error-free) checks whose bound is at most maxRate. */
export function minCleanChecks(maxRate: number, confidence = 0.95): number {
  checkUnit('maxRate', maxRate);
  checkUnit('confidence', confidence);
  // The closed form gives the answer up to rounding; settle it on the gate's own comparison.
  let n = Math.max(1, Math.ceil(Math.log(1 - confidence) / Math.log1p(-maxRate)));
  while (clopperPearsonUpper(0, n, confidence) > maxRate) n++;
  while (n > 1 && clopperPearsonUpper(0, n - 1, confidence) <= maxRate) n--;
  return n;
}

/** More checks needed, if every one of them is clean, before the band's bound is at most maxRate (0 when it already is; Infinity when errors make it unreachable within 100,000). */
export function checksStillNeeded(errors: number, checks: number, maxRate: number, confidence = 0.95): number {
  checkCounts(errors, checks);
  checkUnit('maxRate', maxRate);
  checkUnit('confidence', confidence);
  const open = (more: number) => clopperPearsonUpper(errors, checks + more, confidence) <= maxRate;
  if (open(0)) return 0;
  if (!open(SEARCH_LIMIT)) return Infinity;
  // The bound only falls as clean checks are added, so bisect for the first open one.
  let lo = 1;
  let hi = SEARCH_LIMIT;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (open(mid)) hi = mid; else lo = mid + 1;
  }
  return lo;
}

export interface BandGate { checks: number; errors: number; upper: number; allowed: boolean; stillNeeded: number }

/** Whether a band may act on its own: its bound is at most maxRate, and how many clean checks it still needs if not. */
export function bandGate(errors: number, checks: number, maxRate: number, confidence = 0.95): BandGate {
  checkUnit('maxRate', maxRate);
  const upper = clopperPearsonUpper(errors, checks, confidence);
  return { checks, errors, upper, allowed: upper <= maxRate, stillNeeded: checksStillNeeded(errors, checks, maxRate, confidence) };
}
