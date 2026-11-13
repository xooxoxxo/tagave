/**
 * DJ analysis of one track (the dj module; vault "tagave - DJ Module"):
 * tempo, the beat grid's first beat, where the sound starts and ends, and
 * waveform peaks. Pure: it is fed mono float PCM in chunks (the worker's
 * dj.analyze job streams it out of ffmpeg) and keeps only small per-hop
 * summaries, so a long hi-res file costs a few megabytes, never the file.
 *
 *   onset strength  log energy of the high-passed signal per ~4 ms hop, its
 *                   positive difference, less its local mean (~100 ms)
 *   tempo           autocorrelation of the onset strength (by FFT) over
 *                   80–180 BPM, each lag scored with its multiples so the
 *                   bar's level wins over a hi-hat's, parabolic refinement,
 *                   then refined again at multiples of the period
 *   first beat      the grid offset that collects the most onset strength,
 *                   the first grid beat where the sound starts
 *   trim            first and last 20 ms window above −45 dBFS RMS
 *   peaks           the largest sample per bin, ~900 bins, 0–255
 *
 * Ported from the DJ Directions prototype's trimSilence, estimateBpm and
 * peaks, and hardened: streaming, an FFT in place of the O(n·lags) loop,
 * the tempo-octave choice, sub-hop phase, a confidence, nulls when there is
 * nothing to measure.
 */

/** What the worker decodes to: mono, this rate, 32-bit float. */
export const DJ_SAMPLE_RATE = 11025;
export const DJ_BPM_MIN = 80;
export const DJ_BPM_MAX = 180;
export const DJ_TRIM_DBFS = -45;
export const DJ_PEAK_BINS = 900;
/** Below this the tempo is not reported (no steady pulse: ambient, speech, noise). */
export const DJ_MIN_CONFIDENCE = 0.05;
/** Less sound than this has no tempo worth reporting. */
export const DJ_MIN_SOUND_S = 6;
/** The tempo is measured on at most this much of the sound, from where it starts. */
export const DJ_TEMPO_WINDOW_S = 8 * 60;

export interface DjAnalysis {
  /** decoded length */
  durationMs: number;
  /** beats per minute, 80–180, three decimals (the grid stays within a millisecond over minutes); null: no steady pulse, or too little sound */
  bpm: number | null;
  /** 0–1: how periodic the onsets are at that tempo */
  bpmConfidence: number | null;
  /** the beat grid: firstBeatMs + k · 60000 / bpm */
  firstBeatMs: number | null;
  /** where the sound starts and ends (−45 dBFS RMS, 20 ms windows); null: silent */
  trimStartMs: number | null;
  trimEndMs: number | null;
  /** waveform: the largest |sample| per bin, 0–255 (255 = full scale) */
  peaks: Uint8Array;
}

/** A Float32Array that grows: the per-hop summaries. */
class Series {
  data = new Float32Array(4096);
  length = 0;
  push(v: number): void {
    if (this.length === this.data.length) {
      const next = new Float32Array(this.data.length * 2);
      next.set(this.data);
      this.data = next;
    }
    this.data[this.length++] = v;
  }
  view(): Float32Array {
    return this.data.subarray(0, this.length);
  }
}

/** Streams mono PCM in; finish() gives the analysis. One per track. */
export class DjAnalyzer {
  readonly sampleRate: number;
  /** samples per onset hop (≈ 4 ms) and per trim window (≈ 20 ms) */
  readonly hop: number;
  readonly window: number;
  private readonly threshold: number;

  private samples = 0;
  // the hop being filled
  private hopN = 0;
  private hopEnergy = 0;
  private hopMax = 0;
  private prev = 0;
  // the trim window being filled
  private winN = 0;
  private winSq = 0;
  private windows = 0;
  private firstLoud = -1;
  private lastLoud = -1;

  private readonly energy = new Series();
  private readonly maxAbs = new Series();
  private finished = false;

  constructor(sampleRate = DJ_SAMPLE_RATE) {
    if (!(sampleRate >= 2000)) throw new Error(`sample rate ${sampleRate} is too low`);
    this.sampleRate = sampleRate;
    this.hop = Math.max(1, Math.round(sampleRate * 0.004));
    this.window = Math.max(1, Math.round(sampleRate * 0.02));
    this.threshold = 10 ** (DJ_TRIM_DBFS / 20);
  }

  push(chunk: Float32Array): void {
    if (this.finished) throw new Error('DjAnalyzer: push after finish');
    const hop = this.hop;
    const win = this.window;
    const th2 = this.threshold * this.threshold;
    let { hopN, hopEnergy, hopMax, prev, winN, winSq } = this;
    for (let i = 0; i < chunk.length; i++) {
      let x = chunk[i]!;
      if (x !== x) x = 0; // NaN from a broken decode counts as silence
      // first-order high-pass (pre-emphasis), as the prototype: transients over bass
      const h = x - 0.6 * prev;
      prev = x;
      hopEnergy += h * h;
      const a = x < 0 ? -x : x;
      if (a > hopMax) hopMax = a;
      if (++hopN === hop) {
        this.energy.push(hopEnergy / hop);
        this.maxAbs.push(hopMax);
        hopN = 0;
        hopEnergy = 0;
        hopMax = 0;
      }
      winSq += x * x;
      if (++winN === win) {
        if (winSq / win > th2) {
          if (this.firstLoud < 0) this.firstLoud = this.windows;
          this.lastLoud = this.windows;
        }
        this.windows++;
        winN = 0;
        winSq = 0;
      }
    }
    this.samples += chunk.length;
    Object.assign(this, { hopN, hopEnergy, hopMax, prev, winN, winSq });
  }

  finish(): DjAnalysis {
    if (this.finished) throw new Error('DjAnalyzer: finish twice');
    this.finished = true;
    const sr = this.sampleRate;
    // the partial hop and window at the end
    if (this.hopN > 0) {
      this.energy.push(this.hopEnergy / this.hopN);
      this.maxAbs.push(this.hopMax);
    }
    if (this.winN > 0) {
      if (this.winSq / this.winN > this.threshold * this.threshold) {
        if (this.firstLoud < 0) this.firstLoud = this.windows;
        this.lastLoud = this.windows;
      }
      this.windows++;
    }
    const durationMs = (this.samples / sr) * 1000;
    const peaks = peakBins(this.maxAbs.view(), DJ_PEAK_BINS);
    if (this.firstLoud < 0) {
      return { durationMs: round(durationMs), bpm: null, bpmConfidence: null, firstBeatMs: null, trimStartMs: null, trimEndMs: null, peaks };
    }
    const trimStartMs = ((this.firstLoud * this.window) / sr) * 1000;
    const trimEndMs = (Math.min(this.samples, (this.lastLoud + 1) * this.window) / sr) * 1000;
    const tempo = estimateTempo(this.energy.view(), sr / this.hop, trimStartMs, trimEndMs);
    return {
      durationMs: round(durationMs),
      bpm: tempo ? Math.round(tempo.bpm * 1000) / 1000 : null,
      bpmConfidence: tempo ? Math.round(tempo.confidence * 1000) / 1000 : null,
      firstBeatMs: tempo ? round(tempo.firstBeatMs) : null,
      trimStartMs: round(trimStartMs),
      trimEndMs: round(trimEndMs),
      peaks,
    };
  }
}

/** The whole signal at once (tests, short clips). */
export function analyzePcm(pcm: Float32Array, sampleRate = DJ_SAMPLE_RATE): DjAnalysis {
  const a = new DjAnalyzer(sampleRate);
  a.push(pcm);
  return a.finish();
}

function round(ms: number): number {
  return Math.round(ms);
}

/** Largest value per bin, quantised to a byte. */
export function peakBins(maxAbs: Float32Array, bins: number): Uint8Array {
  const n = maxAbs.length;
  const count = Math.min(bins, n);
  const out = new Uint8Array(count);
  for (let b = 0; b < count; b++) {
    const s = Math.floor((b * n) / count);
    const e = Math.max(s + 1, Math.floor(((b + 1) * n) / count));
    let m = 0;
    for (let i = s; i < e; i++) if (maxAbs[i]! > m) m = maxAbs[i]!;
    out[b] = Math.round(Math.min(1, m) * 255);
  }
  return out;
}

/** Peaks as the API serves them: 0–1, three decimals. */
export function peaksToUnit(peaks: Uint8Array): number[] {
  return Array.from(peaks, (v) => Math.round((v / 255) * 1000) / 1000);
}

interface Tempo {
  bpm: number;
  confidence: number;
  firstBeatMs: number;
}

/**
 * Onset strength per hop: the positive difference of log energy (mean
 * square of the high-passed signal over ONSET_FRAME_HOPS hops centred on
 * the hop: one 4 ms hop alone flickers with noise and a chord's beating),
 * less its local mean (~100 ms), so a loud passage is not all onset.
 */
export function onsetStrength(energy: Float32Array, fps: number, from = 0, to = energy.length): Float32Array {
  const half = ONSET_FRAME_HOPS >> 1;
  const logAt = (f: number) => {
    let s = 0;
    let c = 0;
    for (let j = f - half; j <= f + half; j++) if (j >= 0 && j < energy.length) {
      s += energy[j]!;
      c++;
    }
    return Math.log(1 + 1e4 * (c ? s / c : 0));
  };
  const n = to - from;
  const raw = new Float32Array(n);
  let prev = logAt(from - 1);
  for (let i = 0; i < n; i++) {
    const cur = logAt(from + i);
    const d = cur - prev;
    raw[i] = d > 0 ? d : 0;
    prev = cur;
  }
  return subtractLocalMean(raw, Math.round(fps * 0.1));
}

/** Hops in the energy frame of the onset strength (5 ≈ 20 ms). */
const ONSET_FRAME_HOPS = 5;

/**
 * Tempo and phase from the per-hop energy. fps: hops per second. The
 * onset strength is measured between the trim points only, so a silent
 * intro neither dilutes the autocorrelation nor shifts the grid.
 */
function estimateTempo(energy: Float32Array, fps: number, trimStartMs: number, trimEndMs: number): Tempo | null {
  const h0 = Math.max(0, Math.floor((trimStartMs / 1000) * fps));
  const h1 = Math.min(energy.length, Math.ceil((trimEndMs / 1000) * fps));
  const n = h1 - h0;
  if (n < DJ_MIN_SOUND_S * fps) return null;
  // smoothed a little: a sparse onset train correlates badly at a lag between two hops
  const onset = gaussianSmooth(onsetStrength(energy, fps, h0, h1), 1.5);

  const lagMin = (fps * 60) / DJ_BPM_MAX;
  const lagMax = (fps * 60) / DJ_BPM_MIN;
  // the tempo is measured on the first DJ_TEMPO_WINDOW_S of sound
  const m = Math.min(n, Math.round(DJ_TEMPO_WINDOW_S * fps));
  const ac = autocorrelation(onset.subarray(0, m), Math.ceil(lagMax * 64));
  if (!ac) return null;
  const r = (lag: number) => interp(ac, lag);

  // each lag with its multiples: the beat recurs at 2, 3 and 4 beats, a
  // subdivision or a 3:2 cross-rhythm does not
  let best = -1;
  let bestScore = -Infinity;
  for (let L = Math.ceil(lagMin); L <= Math.floor(lagMax); L++) {
    const s = r(L) + r(2 * L) / 2 + r(3 * L) / 3 + r(4 * L) / 4;
    if (s > bestScore) {
      bestScore = s;
      best = L;
    }
  }
  if (best < 0) return null;
  let period = refinePeak(ac, best, 1);

  // The tempo octave. An even pulse at 172 is just as periodic at 86, so
  // first go to the slowest level in range that is as periodic, then halve
  // while the half-beats are (nearly) as strong as the beats: a pulse, not
  // a hi-hat between kicks.
  while (period * 2 <= lagMax + 0.5 && r(period * 2) >= 0.85 * r(period)) {
    const slower = refinePeak(ac, Math.round(period * 2), 1);
    if (!(slower > period)) break;
    period = slower;
  }
  while (period / 2 >= lagMin - 0.5) {
    const fit = gridFit(onset, period);
    if (fit.mid < HALF_BEAT_RATIO * fit.on) break;
    const faster = refinePeak(ac, Math.round(period / 2), 1);
    if (!(faster > 0 && faster < period)) break;
    period = faster;
  }

  if (!(r(period) > 0)) return null;

  // a finer period from the peaks at 2, 4, 8 … periods (one hop is ~0.8 % of a beat at 120 BPM)
  const base = r(period);
  for (let k = 2; k * period < ac.length - 3; k *= 2) {
    const at = Math.round(k * period);
    const spread = Math.max(2, Math.ceil(at * 0.004));
    let peak = at;
    for (let L = at - spread; L <= at + spread; L++) if (L > 0 && L < ac.length - 1 && ac[L]! > ac[peak]!) peak = L;
    if (ac[peak]! < 0.35 * base) break; // the tempo drifts: stop where the pulse fades
    period = refinePeak(ac, peak, 0) / k;
  }

  // phase over the whole trimmed sound
  const fit = gridFit(onset, period);
  const { phase } = fit;
  // confidence: how periodic (the autocorrelation at the period) times how
  // much the grid stands out of the onsets between (a held chord's beating
  // is periodic too, but smooth: its grid barely stands out)
  const contrast = fit.on > 0 ? (fit.on - fit.mean) / fit.on : 0;
  const confidence = Math.max(0, Math.min(1, r(period))) * Math.max(0, Math.min(1, contrast));
  if (confidence < DJ_MIN_CONFIDENCE) return null;
  const hopMs = 1000 / fps;
  const periodMs = period * hopMs;
  let firstBeatMs = (h0 + phase + ONSET_LAG_HOPS) * hopMs;
  // the first grid beat where the sound starts (a beat right at the start may read a hair early)
  while (firstBeatMs - periodMs >= trimStartMs - 30) firstBeatMs -= periodMs;
  while (firstBeatMs < trimStartMs - 30) firstBeatMs += periodMs;
  return { bpm: (60 * 1000) / periodMs, confidence, firstBeatMs };
}

/** Half-beats at least this strong against the beats: the faster tempo. */
const HALF_BEAT_RATIO = 0.75;

/**
 * The grid offset (hops, sub-hop) that collects the most onset strength at
 * this period, the mean strength on the grid, and halfway between.
 */
function gridFit(onset: Float32Array, period: number): { phase: number; on: number; mid: number; mean: number } {
  const n = onset.length;
  const step = 0.25;
  const steps = Math.max(1, Math.floor(period / step));
  const sums = new Float64Array(steps);
  for (let p = 0; p < steps; p++) {
    let s = 0;
    for (let x = p * step; x < n - 1; x += period) s += interp(onset, x);
    sums[p] = s;
  }
  let bp = 0;
  for (let p = 1; p < steps; p++) if (sums[p]! > sums[bp]!) bp = p;
  const y0 = sums[(bp - 1 + steps) % steps]!;
  const y1 = sums[bp]!;
  const y2 = sums[(bp + 1) % steps]!;
  const den = y0 - 2 * y1 + y2;
  const phase = (bp + (den < 0 ? (0.5 * (y0 - y2)) / den : 0)) * step;
  const mid = sums[(bp + Math.round(steps / 2)) % steps]!;
  let mean = 0;
  for (let p = 0; p < steps; p++) mean += sums[p]!;
  return { phase, on: y1, mid, mean: mean / steps };
}

/** Where in its hop an attack sits on average, in hops (calibrated on the synthetic suite). */
const ONSET_LAG_HOPS = 2.15;

function subtractLocalMean(x: Float32Array, radius: number): Float32Array {
  const n = x.length;
  const out = new Float32Array(n);
  let sum = 0;
  let lo = 0;
  let hi = 0;
  for (let i = 0; i < n; i++) {
    while (hi < n && hi <= i + radius) sum += x[hi++]!;
    while (lo < i - radius) sum -= x[lo++]!;
    const v = x[i]! - sum / (hi - lo);
    out[i] = v > 0 ? v : 0;
  }
  return out;
}

function gaussianSmooth(x: Float32Array, sigma: number): Float32Array {
  const r = Math.ceil(sigma * 3);
  const k = new Float32Array(2 * r + 1);
  let t = 0;
  for (let i = -r; i <= r; i++) t += k[i + r] = Math.exp(-(i * i) / (2 * sigma * sigma));
  for (let i = 0; i < k.length; i++) k[i]! /= t;
  const n = x.length;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let j = -r; j <= r; j++) {
      const q = i + j;
      if (q >= 0 && q < n) s += x[q]! * k[j + r]!;
    }
    out[i] = s;
  }
  return out;
}

function interp(a: ArrayLike<number>, x: number): number {
  if (x < 0) return 0;
  const i = Math.floor(x);
  if (i >= a.length - 1) return i === a.length - 1 ? a[i]! : 0;
  const f = x - i;
  return a[i]! * (1 - f) + a[i + 1]! * f;
}

/** The parabola's vertex through the peak at i and its neighbours (searching ±search first). */
function refinePeak(a: Float64Array, i: number, search: number): number {
  let p = i;
  for (let j = i - search; j <= i + search; j++) if (j > 0 && j < a.length - 1 && a[j]! > a[p]!) p = j;
  if (p <= 0 || p >= a.length - 1) return p;
  const y0 = a[p - 1]!;
  const y1 = a[p]!;
  const y2 = a[p + 1]!;
  // At the edge of the search, p can sit on a slope. Extrapolating from
  // a slope can return a negative period, so refine actual peaks only.
  if (y1 < y0 || y1 < y2) return p;
  const den = y0 - 2 * y1 + y2;
  return den < 0 ? p + (0.5 * (y0 - y2)) / den : p;
}

/**
 * Normalised, unbiased autocorrelation of the mean-removed signal up to
 * maxLag (r[0] = 1), by FFT. null when the signal is flat.
 */
function autocorrelation(x: Float32Array, maxLag: number): Float64Array | null {
  const n = x.length;
  let mean = 0;
  for (let i = 0; i < n; i++) mean += x[i]!;
  mean /= n;
  let size = 1;
  while (size < 2 * n) size <<= 1;
  const re = new Float64Array(size);
  const im = new Float64Array(size);
  for (let i = 0; i < n; i++) re[i] = x[i]! - mean;
  fft(re, im, false);
  for (let i = 0; i < size; i++) {
    re[i] = re[i]! * re[i]! + im[i]! * im[i]!;
    im[i] = 0;
  }
  fft(re, im, true);
  const zero = re[0]!;
  if (!(zero > 1e-12)) return null;
  const len = Math.min(maxLag + 1, n - 1);
  const out = new Float64Array(len);
  for (let L = 0; L < len; L++) out[L] = (re[L]! / zero) * (n / (n - L));
  return out;
}

/** In-place iterative radix-2 FFT; inverse is scaled by 1/n. */
function fft(re: Float64Array, im: Float64Array, inverse: boolean): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j]!, re[i]!];
      [im[i], im[j]] = [im[j]!, im[i]!];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = ((inverse ? 2 : -2) * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k;
        const b = a + len / 2;
        const xr = re[b]! * cr - im[b]! * ci;
        const xi = re[b]! * ci + im[b]! * cr;
        re[b] = re[a]! - xr;
        im[b] = im[a]! - xi;
        re[a] = re[a]! + xr;
        im[a] = im[a]! + xi;
        const t = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = t;
      }
    }
  }
  if (inverse) for (let i = 0; i < n; i++) {
    re[i] = re[i]! / n;
    im[i] = im[i]! / n;
  }
}
