/**
 * Cut points for splitting a whole album in one file (0078 album_splits).
 *
 * The release's track lengths give the expected boundaries (their running
 * sum). Each inner boundary then moves to the quietest point within ±6 s:
 * the file worker decodes only that window to raw PCM (flac -d), and the
 * functions here measure it in 10 ms frames, pick the lowest sustained run,
 * and rate the cut by how deep the dip is against the level around it. A
 * window with no clear dip (a gapless or live album) keeps the expected
 * point, marked low confidence.
 *
 * Pure: no I/O. Samples count per channel from the source's first sample.
 */
import type { CutConfidence, SplitPlan, SplitTrackPlan } from '@tagave/shared';

/** Frames of 10 ms. */
export const FRAME_MS = 10;
/** The run a dip must last to count as sustained: 5 frames, 50 ms. */
export const SUSTAIN_FRAMES = 5;
/** A dip shallower than this against the window's level is no cut point. */
export const MIN_DIP_DB = 12;
/** A dip at least this deep is a sure cut. */
export const SURE_DIP_DB = 24;
/** A cut may cost this much of its depth per second away from the expected point (so the nearer of two equal dips wins). */
const DISTANCE_COST_PER_S = 0.05;
/** Below everything a real file holds: keeps log ratios finite on digital silence. */
const FLOOR = 1e-7;

/** The expected inner boundaries in ms: the running sum of the lengths, without 0 and the end. */
export function expectedBoundariesMs(lengthsMs: readonly number[]): number[] {
  const out: number[] = [];
  let at = 0;
  for (let i = 0; i < lengthsMs.length - 1; i++) {
    at += lengthsMs[i]!;
    out.push(at);
  }
  return out;
}

/** A position in ms as a sample index, rounded. */
export function msToSample(ms: number, sampleRate: number): number {
  return Math.round((ms * sampleRate) / 1000);
}

/** Samples in one 10 ms frame. */
export function frameSamplesOf(sampleRate: number): number {
  return Math.max(1, Math.round((sampleRate * FRAME_MS) / 1000));
}

/**
 * RMS of every 10 ms frame of interleaved little-endian signed PCM (what
 * `flac -d --force-raw-format --endian=little --sign=signed` writes), all
 * channels together, as a share of full scale (0..1). A last partial frame
 * counts if it holds at least half a frame.
 */
export function frameRms(pcm: Uint8Array, bitsPerSample: number, channels: number, sampleRate: number): Float64Array {
  const bytes = Math.ceil(bitsPerSample / 8);
  if (![1, 2, 3, 4].includes(bytes)) throw new Error(`Unsupported sample size: ${bitsPerSample} bits`);
  if (channels < 1) throw new Error('No channels');
  const per = frameSamplesOf(sampleRate);
  const stride = bytes * channels;
  const samples = Math.floor(pcm.length / stride);
  const frames = Math.floor(samples / per) + (samples % per >= per / 2 ? 1 : 0);
  const out = new Float64Array(frames);
  const full = 2 ** (bytes * 8 - 1);
  const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  for (let f = 0; f < frames; f++) {
    const first = f * per;
    const last = Math.min(samples, first + per);
    let sum = 0;
    for (let s = first; s < last; s++) {
      for (let c = 0; c < channels; c++) {
        const o = s * stride + c * bytes;
        let v: number;
        switch (bytes) {
          case 1: v = view.getInt8(o); break;
          case 2: v = view.getInt16(o, true); break;
          case 3: {
            const u = pcm[o]! | (pcm[o + 1]! << 8) | (pcm[o + 2]! << 16);
            v = u & 0x800000 ? u - 0x1000000 : u;
            break;
          }
          default: v = view.getInt32(o, true);
        }
        const x = v / full;
        sum += x * x;
      }
    }
    const n = (last - first) * channels;
    out[f] = n > 0 ? Math.sqrt(sum / n) : 0;
  }
  return out;
}

/** The q-quantile (0..1) of the values. */
function quantile(values: Float64Array, q: number): number {
  if (values.length === 0) return 0;
  const sorted = Float64Array.from(values).sort();
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(q * (sorted.length - 1))))]!;
}

/** Each frame's mean over the SUSTAIN_FRAMES frames centred on it (fewer at the edges). */
export function sustained(rms: Float64Array, width = SUSTAIN_FRAMES): Float64Array {
  const out = new Float64Array(rms.length);
  const half = Math.floor(width / 2);
  for (let i = 0; i < rms.length; i++) {
    let sum = 0;
    let n = 0;
    for (let j = Math.max(0, i - half); j <= Math.min(rms.length - 1, i + half); j++) {
      sum += rms[j]!;
      n++;
    }
    out[i] = sum / n;
  }
  return out;
}

export interface RefinedCut {
  /** the cut, a sample index of the source */
  sample: number;
  /** the dip's depth against the window's level, in dB (null with no frames) */
  depthDb: number | null;
  confidence: CutConfidence;
  /** false: no clear dip, the expected point kept */
  moved: boolean;
}

export interface RefineInput {
  /** frameRms of the decoded window */
  rms: Float64Array;
  sampleRate: number;
  /** the source sample the window's first frame starts at */
  windowStartSample: number;
  /** the boundary the release's lengths give */
  expectedSample: number;
}

/** The confidence a dip of this depth gives. */
export function confidenceOf(depthDb: number): CutConfidence {
  if (depthDb >= SURE_DIP_DB) return 'high';
  if (depthDb >= MIN_DIP_DB) return 'medium';
  return 'low';
}

/**
 * The quietest sustained point of the window: the frame whose 50 ms mean is
 * lowest (a little dearer the further it is from the expected point, so the
 * nearer of two equal dips wins); within its low run (frames within 6 dB of
 * it) the expected point when the run holds it, else the run's middle, kept
 * clear of the run's edges; then the quietest single frame there. Its depth is the window's
 * level (the 75th percentile frame, the music around the gap) against the
 * dip, in dB. Under MIN_DIP_DB the expected point stays, low confidence.
 */
export function refineCut({ rms, sampleRate, windowStartSample, expectedSample }: RefineInput): RefinedCut {
  const per = frameSamplesOf(sampleRate);
  const keep: RefinedCut = { sample: expectedSample, depthDb: null, confidence: 'low', moved: false };
  if (rms.length < SUSTAIN_FRAMES) return keep;
  const smooth = sustained(rms);
  const expectedFrame = (expectedSample - windowStartSample) / per;
  let best = -1;
  let bestScore = Infinity;
  for (let i = 0; i < smooth.length; i++) {
    const awayS = (Math.abs(i + 0.5 - expectedFrame) * FRAME_MS) / 1000;
    const score = (smooth[i]! + FLOOR) * (1 + DISTANCE_COST_PER_S * awayS);
    if (score < bestScore) {
      bestScore = score;
      best = i;
    }
  }
  const level = quantile(rms, 0.75);
  const dip = smooth[best]!;
  const depthDb = Math.min(120, 20 * Math.log10((level + FLOOR) / (dip + FLOOR)));
  if (depthDb < MIN_DIP_DB) return { ...keep, depthDb };

  // the low run around the pick: frames within 6 dB of the dip
  const limit = (dip + FLOOR) * 2;
  let a = best;
  let b = best;
  while (a > 0 && smooth[a - 1]! <= limit) a--;
  while (b < smooth.length - 1 && smooth[b + 1]! <= limit) b++;
  // the expected point inside the run: trust it (a long silence is cut where
  // the release says); otherwise the middle of the gap
  const margin = Math.floor(SUSTAIN_FRAMES / 2);
  let centre = expectedFrame >= a && expectedFrame < b + 1 ? best : Math.floor((a + b) / 2);
  if (b - a >= 2 * margin) centre = Math.min(Math.max(centre, a + margin), b - margin);
  // the quietest single frame next to it (the earliest of equals)
  let pick = centre;
  for (let j = Math.max(a, centre - margin); j <= Math.min(b, centre + margin); j++) {
    if (rms[j]! < rms[pick]!) pick = j;
  }
  const sample = windowStartSample + pick * per + Math.floor(per / 2);
  return { sample, depthDb, confidence: confidenceOf(depthDb), moved: true };
}

/** The window to decode around an expected boundary: ±searchMs, inside the file. */
export function windowAround(expectedSample: number, sampleRate: number, totalSamples: number, searchMs: number): { skip: number; until: number } {
  const half = msToSample(searchMs, sampleRate);
  return { skip: Math.max(0, expectedSample - half), until: Math.min(totalSamples, expectedSample + half) };
}

/** Characters no file name may hold on the systems a music folder is shared to. */
const UNSAFE = /[\\/:*?"<>|\u0000-\u001f\u007f]+/g;

/**
 * A title as one safe file name part: no path separators or characters
 * Windows and SMB refuse, no leading dots (a hidden file) or trailing dots
 * and spaces, NFC, at most 180 UTF-8 bytes.
 */
export function safeNamePart(s: string, fallback = 'Track'): string {
  let out = s.normalize('NFC').replace(UNSAFE, ' ').replace(/\s+/g, ' ').trim().replace(/^\.+/, '').replace(/[. ]+$/, '');
  while (Buffer.byteLength(out, 'utf8') > 180) out = out.slice(0, -1);
  out = out.replace(/[. ]+$/, '');
  return out || fallback;
}

/** "03 - Title.flac"; on a release of several discs "2-03 - Title.flac". */
export function trackFileName(t: { disc: number; position: number; title: string }, discs: number, digits = 2): string {
  const num = String(t.position).padStart(digits, '0');
  return `${discs > 1 ? `${t.disc}-` : ''}${num} - ${safeNamePart(t.title)}.flac`;
}

export interface PlanTrackInput {
  disc: number;
  position: number;
  title: string;
  lengthMs: number;
}

export interface PlanInput {
  tracks: readonly PlanTrackInput[];
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  totalSamples: number;
  /** one per inner boundary, in order (refineCut, or the expected point kept) */
  cuts: readonly RefinedCut[];
}

/** The shortest a track may come out: a cut that leaves less falls back to the expected point. */
const MIN_TRACK_MS = 1_000;

/**
 * The plan: each track from its start cut to the next (the last to the end
 * of the file). A refined cut that would leave a track under a second, or
 * not after the one before, falls back to its expected point, low.
 */
export function planSplit(input: PlanInput): SplitPlan {
  const { tracks, sampleRate, totalSamples } = input;
  if (tracks.length < 2) throw new Error('A split needs at least two tracks');
  if (input.cuts.length !== tracks.length - 1) throw new Error('One cut per inner boundary');
  const expected = expectedBoundariesMs(tracks.map((t) => t.lengthMs)).map((ms) => msToSample(ms, sampleRate));
  const minLen = msToSample(MIN_TRACK_MS, sampleRate);
  const cuts: Array<{ sample: number; confidence: CutConfidence }> = [];
  for (let i = 0; i < input.cuts.length; i++) {
    const prev = i === 0 ? 0 : cuts[i - 1]!.sample;
    const c = input.cuts[i]!;
    const nextExpected = i + 1 < expected.length ? expected[i + 1]! : totalSamples;
    const fits = (s: number) => s - prev >= minLen && nextExpected - s >= minLen && s < totalSamples;
    if (fits(c.sample)) cuts.push({ sample: c.sample, confidence: c.confidence });
    else if (fits(expected[i]!)) cuts.push({ sample: expected[i]!, confidence: 'low' });
    else throw new Error(`Track ${i + 1} would be shorter than a second`);
  }
  if (totalSamples - cuts[cuts.length - 1]!.sample < minLen) throw new Error('The last track would be shorter than a second');
  const discs = new Set(tracks.map((t) => t.disc)).size;
  const digits = Math.max(2, String(Math.max(...tracks.map((t) => t.position))).length);
  const out: SplitTrackPlan[] = tracks.map((t, i) => {
    const start = i === 0 ? 0 : cuts[i - 1]!.sample;
    const end = i === tracks.length - 1 ? totalSamples : cuts[i]!.sample;
    return {
      n: i + 1, disc: t.disc, position: t.position, title: t.title,
      startSample: start, endSample: end,
      fileName: trackFileName(t, discs, digits),
      shiftMs: i === 0 ? null : Math.round(((start - expected[i - 1]!) * 1000) / sampleRate),
      confidence: i === 0 ? null : cuts[i - 1]!.confidence,
    };
  });
  // two titles that give one name: the later ones get " (2)", " (3)"
  const seen = new Map<string, number>();
  for (const t of out) {
    const key = t.fileName.toLowerCase();
    const n = (seen.get(key) ?? 0) + 1;
    seen.set(key, n);
    if (n > 1) t.fileName = t.fileName.replace(/\.flac$/, ` (${n}).flac`);
  }
  return { sampleRate, channels: input.channels, bitsPerSample: input.bitsPerSample, totalSamples, tracks: out };
}

export interface WrittenTrack {
  /** the track's sample count, read from the written file */
  samples: number;
  /** flac -t passed */
  decodes: boolean;
}

/**
 * What is wrong with the written tracks, in words (empty: all good): every
 * one decodes, each holds exactly the samples the plan gave it and lasts
 * within slackMs of it, and together they hold exactly the source's samples.
 */
export function verifySplit(plan: SplitPlan, written: readonly WrittenTrack[], slackMs: number): string[] {
  const problems: string[] = [];
  if (written.length !== plan.tracks.length) return [`${written.length} of ${plan.tracks.length} tracks written`];
  let sum = 0;
  let undecodable = false;
  plan.tracks.forEach((t, i) => {
    const w = written[i]!;
    if (!w.decodes) {
      problems.push(`Track ${t.n} does not decode`);
      undecodable = true;
      return;
    }
    sum += w.samples;
    const want = t.endSample - t.startSample;
    if (w.samples !== want) problems.push(`Track ${t.n} holds ${w.samples} samples, the plan ${want}`);
    if (Math.abs(w.samples - want) * 1000 > slackMs * plan.sampleRate) problems.push(`Track ${t.n} is off its planned length by more than ${slackMs} ms`);
  });
  if (!undecodable && sum !== plan.totalSamples) problems.push(`The tracks hold ${sum} samples, the source ${plan.totalSamples}`);
  return problems;
}
