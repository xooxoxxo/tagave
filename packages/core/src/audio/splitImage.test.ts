/**
 * Cut points for a whole album in one file, on synthetic PCM: tones with
 * silences between them at 16 and 24 bits, a gapless join, a quiet passage
 * against a real gap, two equal gaps, a lone click of silence.
 */
import { describe, expect, it } from 'vitest';
import { looksLikeWholeAlbum, shiftLabel, clockOf } from '@tagave/shared';
import {
  expectedBoundariesMs, frameRms, msToSample, planSplit, refineCut, safeNamePart, trackFileName, verifySplit, windowAround,
  type RefinedCut,
} from './splitImage.js';

const RATE = 44_100;

/** Interleaved little-endian signed PCM of `seconds`, each sample from amp(t) (0..1) on a 440 Hz sine. */
function pcm(seconds: number, amp: (t: number) => number, opts: { bits?: 16 | 24; channels?: number; rate?: number } = {}): Uint8Array {
  const bits = opts.bits ?? 16;
  const channels = opts.channels ?? 2;
  const rate = opts.rate ?? RATE;
  const bytes = bits / 8;
  const n = Math.round(seconds * rate);
  const out = new Uint8Array(n * channels * bytes);
  const full = 2 ** (bits - 1) - 1;
  for (let i = 0; i < n; i++) {
    const t = i / rate;
    const v = Math.round(amp(t) * Math.sin(2 * Math.PI * 440 * t) * full);
    for (let c = 0; c < channels; c++) {
      const o = (i * channels + c) * bytes;
      const u = v < 0 ? v + 2 ** bits : v;
      for (let b = 0; b < bytes; b++) out[o + b] = (u >> (8 * b)) & 0xff;
    }
  }
  return out;
}

/** A 12 s window (±6 s) around a boundary at 6 s, and the cut refineCut gives for it. */
function cutIn(window: Uint8Array, opts: { bits?: 16 | 24; expectedAtS?: number; rate?: number } = {}) {
  const rate = opts.rate ?? RATE;
  const windowStartSample = 1_000_000;
  const expectedSample = windowStartSample + Math.round((opts.expectedAtS ?? 6) * rate);
  const rms = frameRms(window, opts.bits ?? 16, 2, rate);
  const cut = refineCut({ rms, sampleRate: rate, windowStartSample, expectedSample });
  return { ...cut, atS: (cut.sample - windowStartSample) / rate, shiftS: (cut.sample - expectedSample) / rate };
}

describe('the detection rule', () => {
  it('fits a file within max(20 s, 1 %) of the release total, with every length known', () => {
    const lengths = [180_000, 200_000, 220_000]; // 600 s
    expect(looksLikeWholeAlbum(600_000, lengths)).toBe(true);
    expect(looksLikeWholeAlbum(619_000, lengths)).toBe(true);
    expect(looksLikeWholeAlbum(621_000, lengths)).toBe(false);
    // 1 % of a long album is more than 20 s: 2344 s ± 23.4 s
    const long = [1_172_000, 1_172_000];
    expect(looksLikeWholeAlbum(2_344_000 + 23_000, long)).toBe(true);
    expect(looksLikeWholeAlbum(2_344_000 + 24_000, long)).toBe(false);
  });
  it('needs more than one track and every length', () => {
    expect(looksLikeWholeAlbum(180_000, [180_000])).toBe(false);
    expect(looksLikeWholeAlbum(400_000, [200_000, null])).toBe(false);
    expect(looksLikeWholeAlbum(null, [200_000, 200_000])).toBe(false);
  });
});

describe('expected boundaries', () => {
  it('are the running sum of the lengths, without the start and the end', () => {
    expect(expectedBoundariesMs([1000, 2000, 3000])).toEqual([1000, 3000]);
    expect(expectedBoundariesMs([5000])).toEqual([]);
    expect(msToSample(1000, 192_000)).toBe(192_000);
  });
  it('decode a window of ±6 s inside the file', () => {
    expect(windowAround(10 * RATE, RATE, 100 * RATE, 6000)).toEqual({ skip: 4 * RATE, until: 16 * RATE });
    expect(windowAround(2 * RATE, RATE, 5 * RATE, 6000)).toEqual({ skip: 0, until: 5 * RATE });
  });
});

describe('frame RMS', () => {
  it('reads 16- and 24-bit little-endian signed PCM as a share of full scale', () => {
    for (const bits of [16, 24] as const) {
      const rms = frameRms(pcm(0.1, () => 0.5, { bits }), bits, 2, RATE);
      expect(rms.length).toBe(10);
      // a sine's RMS is its amplitude over √2
      for (const r of rms) expect(r).toBeCloseTo(0.5 / Math.SQRT2, 2);
    }
    const silent = frameRms(pcm(0.05, () => 0), 16, 2, RATE);
    expect([...silent]).toEqual([0, 0, 0, 0, 0]);
  });
  it('reads a negative 24-bit sample', () => {
    // one stereo frame of -1 (0xffffff) and +1
    const rms = frameRms(new Uint8Array([0xff, 0xff, 0xff, 0x01, 0x00, 0x00]), 24, 2, 100);
    expect(rms[0]).toBeCloseTo(1 / 2 ** 23, 12);
  });
});

describe('refining a cut', () => {
  it('moves to the silence between two tracks, sure of it (16 and 24 bit)', () => {
    for (const bits of [16, 24] as const) {
      // music to 6.8 s, 400 ms of digital silence, music again; the release says 6.0 s
      const w = pcm(12, (t) => (t >= 6.8 && t < 7.2 ? 0 : 0.6), { bits });
      const c = cutIn(w, { bits });
      expect(c.moved).toBe(true);
      expect(c.confidence).toBe('high');
      // the middle of the gap, within a frame
      expect(Math.abs(c.atS - 7.0)).toBeLessThan(0.011);
      expect(c.shiftS).toBeGreaterThan(0.8);
      expect(c.depthDb).toBeGreaterThanOrEqual(24);
    }
  });
  it('a long silence: cuts at the expected point inside it, else in its middle', () => {
    // 3 s of silence from 4 s to 7 s; the release says 6.0 s, inside it
    const c = cutIn(pcm(12, (t) => (t >= 4 && t < 7 ? 0 : 0.5)));
    expect(c.confidence).toBe('high');
    expect(Math.abs(c.shiftS)).toBeLessThan(0.05);
    // the release says 3.5 s, before it: the middle of the silence
    const early = cutIn(pcm(12, (t) => (t >= 4 && t < 7 ? 0 : 0.5)), { expectedAtS: 3.5 });
    expect(early.atS).toBeGreaterThan(5.4);
    expect(early.atS).toBeLessThan(5.6);
  });
  it('keeps the expected point, low, when there is no dip (gapless)', () => {
    // the level wanders by ±1 dB: no gap anywhere
    const c = cutIn(pcm(12, (t) => 0.5 * (1 + 0.1 * Math.sin(t * 3))));
    expect(c.moved).toBe(false);
    expect(c.confidence).toBe('low');
    expect(c.shiftS).toBe(0);
    expect(c.depthDb).toBeLessThan(12);
  });
  it('a shallow dip is medium', () => {
    // a 500 ms dip of -16 dB (a fade between live songs)
    const c = cutIn(pcm(12, (t) => (t >= 5.5 && t < 6.0 ? 0.6 * 10 ** (-16 / 20) : 0.6)));
    expect(c.confidence).toBe('medium');
    expect(c.atS).toBeGreaterThan(5.5);
    expect(c.atS).toBeLessThan(6.0);
  });
  it('prefers a sustained low run to a lone frame of silence', () => {
    // a 10 ms dropout at 6.5 s, and a 300 ms quiet run at -30 dB at 4.0 s
    const c = cutIn(pcm(12, (t) => {
      if (t >= 6.5 && t < 6.51) return 0;
      if (t >= 4.0 && t < 4.3) return 0.6 * 10 ** (-30 / 20);
      return 0.6;
    }));
    expect(c.atS).toBeGreaterThan(4.0);
    expect(c.atS).toBeLessThan(4.3);
  });
  it('of two equal gaps takes the nearer one', () => {
    const c = cutIn(pcm(12, (t) => ((t >= 2 && t < 2.3) || (t >= 7 && t < 7.3) ? 0 : 0.5)));
    expect(c.atS).toBeGreaterThan(7);
    expect(c.atS).toBeLessThan(7.3);
  });
  it('works at 192 kHz', () => {
    const rate = 192_000;
    const w = pcm(12, (t) => (t >= 5 && t < 5.4 ? 0 : 0.4), { rate, channels: 2 });
    const c = cutIn(w, { rate });
    expect(c.confidence).toBe('high');
    expect(c.atS).toBeGreaterThan(5);
    expect(c.atS).toBeLessThan(5.4);
  });
});

describe('the plan', () => {
  const tracks = [
    { disc: 1, position: 1, title: 'One', lengthMs: 10_000 },
    { disc: 1, position: 2, title: 'Two/Three: "Live"', lengthMs: 20_000 },
    { disc: 1, position: 3, title: 'One', lengthMs: 30_000 },
  ];
  const sure = (sample: number): RefinedCut => ({ sample, depthDb: 60, confidence: 'high', moved: true });

  it('gives each track its samples, every sample once, with the shift of its start cut', () => {
    const total = 60 * RATE + 123;
    const plan = planSplit({ tracks, sampleRate: RATE, channels: 2, bitsPerSample: 16, totalSamples: total, cuts: [sure(10 * RATE + 35_280), sure(30 * RATE - 4410)] });
    expect(plan.tracks.map((t) => [t.startSample, t.endSample])).toEqual([[0, 10 * RATE + 35_280], [10 * RATE + 35_280, 30 * RATE - 4410], [30 * RATE - 4410, total]]);
    expect(plan.tracks.map((t) => t.shiftMs)).toEqual([null, 800, -100]);
    expect(plan.tracks.map((t) => t.confidence)).toEqual([null, 'high', 'high']);
    const sum = plan.tracks.reduce((n, t) => n + t.endSample - t.startSample, 0);
    expect(sum).toBe(total);
    // safe names; two titles alike differ by their number
    expect(plan.tracks.map((t) => t.fileName)).toEqual(['01 - One.flac', '02 - Two Three Live.flac', '03 - One.flac']);
  });
  it('falls back to the expected point, low, when a cut would leave a track under a second', () => {
    const plan = planSplit({ tracks, sampleRate: RATE, channels: 2, bitsPerSample: 16, totalSamples: 60 * RATE, cuts: [sure(10 * RATE), sure(10 * RATE + 100)] });
    expect(plan.tracks[2]!.startSample).toBe(30 * RATE);
    expect(plan.tracks[2]!.confidence).toBe('low');
    expect(plan.tracks[2]!.shiftMs).toBe(0);
  });
  it('numbers two titles that give one file name', () => {
    const same = [
      { disc: 1, position: 1, title: 'Intro', lengthMs: 10_000 },
      { disc: 1, position: 1, title: 'Intro', lengthMs: 10_000 },
    ];
    const plan = planSplit({ tracks: same, sampleRate: RATE, channels: 2, bitsPerSample: 16, totalSamples: 20 * RATE, cuts: [sure(10 * RATE)] });
    expect(plan.tracks.map((t) => t.fileName)).toEqual(['01 - Intro.flac', '01 - Intro (2).flac']);
  });
  it('names tracks of a release of several discs with the disc', () => {
    expect(trackFileName({ disc: 2, position: 3, title: 'X' }, 2)).toBe('2-03 - X.flac');
    expect(trackFileName({ disc: 1, position: 3, title: 'X' }, 1)).toBe('03 - X.flac');
  });
  it('makes safe file names', () => {
    expect(safeNamePart('AC/DC: Back?')).toBe('AC DC Back');
    expect(safeNamePart('...hidden')).toBe('hidden');
    expect(safeNamePart('trailing. ')).toBe('trailing');
    expect(safeNamePart('   ')).toBe('Track');
    expect(Buffer.byteLength(safeNamePart('é'.repeat(200)), 'utf8')).toBeLessThanOrEqual(180);
    expect(safeNamePart('Café')).toBe('Café');
  });
});

describe('checking the written tracks', () => {
  const plan = planSplit({
    tracks: [{ disc: 1, position: 1, title: 'A', lengthMs: 5000 }, { disc: 1, position: 2, title: 'B', lengthMs: 5000 }],
    sampleRate: RATE, channels: 2, bitsPerSample: 16, totalSamples: 10 * RATE,
    cuts: [{ sample: 5 * RATE, depthDb: 60, confidence: 'high', moved: true }],
  });
  it('passes exact sample counts', () => {
    expect(verifySplit(plan, [{ samples: 5 * RATE, decodes: true }, { samples: 5 * RATE, decodes: true }], 100)).toEqual([]);
  });
  it('catches one sample lost or duplicated at a boundary', () => {
    const p = verifySplit(plan, [{ samples: 5 * RATE + 1, decodes: true }, { samples: 5 * RATE, decodes: true }], 100);
    expect(p).toContain(`Track 1 holds ${5 * RATE + 1} samples, the plan ${5 * RATE}`);
    expect(p).toContain(`The tracks hold ${10 * RATE + 1} samples, the source ${10 * RATE}`);
  });
  it('catches a track that does not decode, one too long, one missing', () => {
    expect(verifySplit(plan, [{ samples: 5 * RATE, decodes: false }, { samples: 5 * RATE, decodes: true }], 100)).toEqual(['Track 1 does not decode']);
    expect(verifySplit(plan, [{ samples: 5 * RATE, decodes: true }, { samples: 6 * RATE, decodes: true }], 100)).toContain('Track 2 is off its planned length by more than 100 ms');
    expect(verifySplit(plan, [{ samples: 5 * RATE, decodes: true }], 100)).toEqual(['1 of 2 tracks written']);
  });
});

describe('labels', () => {
  it('shift and clock', () => {
    expect(shiftLabel(800)).toBe('+0.8 s');
    expect(shiftLabel(-1240)).toBe('−1.2 s');
    expect(shiftLabel(20)).toBe('0.0 s');
    expect(clockOf(187_000)).toBe('3:07');
    expect(clockOf(3_725_000)).toBe('1:02:05');
  });
});
