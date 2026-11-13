import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { DJ_PEAK_BINS, DjAnalyzer, analyzePcm, peaksToUnit } from './analysis.js';
import { gridError, synthTrack, type SynthSpec } from './testSignals.js';

interface Row { name: string; want: number; bpm: number | null; bpmErr: number; phaseMs: number; phaseMean: number; trimStartErr: number; trimEndErr: number; conf: number | null; msPerMin: number }
const rows: Row[] = [];

function run(name: string, spec: SynthSpec) {
  const s = synthTrack(spec);
  const t0 = performance.now();
  const a = analyzePcm(s.pcm, s.sampleRate);
  const ms = performance.now() - t0;
  const minutes = s.pcm.length / s.sampleRate / 60;
  // the grid against every kick: the worst miss
  const phaseMs = a.bpm != null && a.firstBeatMs != null
    ? Math.max(...s.beats.map((b) => Math.abs(gridError(a.firstBeatMs!, a.bpm!, b * 1000))))
    : NaN;
  const phaseMean = a.bpm != null && a.firstBeatMs != null
    ? s.beats.reduce((t, b) => t + gridError(a.firstBeatMs!, a.bpm!, b * 1000), 0) / s.beats.length
    : NaN;
  const row: Row = {
    name, want: spec.bpm, bpm: a.bpm, bpmErr: a.bpm == null ? NaN : Math.abs(a.bpm - spec.bpm), phaseMs, phaseMean,
    trimStartErr: Math.abs((a.trimStartMs ?? NaN) - s.soundStartS * 1000), trimEndErr: Math.abs((a.trimEndMs ?? NaN) - s.soundEndS * 1000),
    conf: a.bpmConfidence, msPerMin: ms / minutes,
  };
  rows.push(row);
  return { a, s, row };
}

const BASE: Omit<SynthSpec, 'bpm'> = { seconds: 90, hats: 0.35, pad: 0.15, noise: 0.01 };

describe('dj analysis: tempo', () => {
  for (const bpm of [84, 92, 100, 115, 120, 124, 128, 136, 140, 150, 165, 174]) {
    it(`${bpm} BPM, kick on every beat, hats, a chord`, () => {
      const { a, row } = run(`${bpm} four-on-the-floor`, { ...BASE, bpm, seed: bpm });
      expect(a.bpm).not.toBeNull();
      expect(row.bpmErr).toBeLessThan(0.05);
      expect(row.phaseMs).toBeLessThan(10);
      expect(a.bpmConfidence!).toBeGreaterThan(0.2);
    });
  }

  it('a fractional tempo (123.45 BPM)', () => {
    const { row } = run('123.45 fractional', { ...BASE, bpm: 123.45, seconds: 200 });
    expect(row.bpmErr).toBeLessThan(0.05);
    expect(row.phaseMs).toBeLessThan(10);
  });

  it('a backbeat: kick on 1 and 3, snare on 2 and 4, 96 BPM', () => {
    const { row } = run('96 backbeat', { ...BASE, bpm: 96, pattern: 'backbeat' });
    expect(row.bpmErr).toBeLessThan(0.05);
    expect(row.phaseMs).toBeLessThan(10);
  });
});

describe('dj analysis: a drummer, and a noisy mix', () => {
  it('108 BPM, every hit up to ±10 ms off and ±30 % in level', () => {
    const { row } = run('108 humanised ±10 ms', { ...BASE, bpm: 108, jitterMs: 10, seconds: 150 });
    expect(row.bpmErr).toBeLessThan(0.1);
    expect(Math.abs(row.phaseMean)).toBeLessThan(4);
    expect(row.phaseMs).toBeLessThan(18); // the hits themselves are up to 10 ms off
  });
  it('132 BPM under loud noise (−20 dB against the kicks)', () => {
    const { row } = run('132 noisy', { ...BASE, bpm: 132, noise: 0.1 });
    expect(row.bpmErr).toBeLessThan(0.05);
    expect(row.phaseMs).toBeLessThan(10);
  });
});

describe('dj analysis: near the tempo octave', () => {
  it('returns control to the event loop for a sparse clip with no reliable tempo', async () => {
    const module = new URL('./analysis.ts', import.meta.url).href;
    const script = [
      'import { analyzePcm } from ' + JSON.stringify(module) + ';',
      'const pcm = new Float32Array(8 * 11025);',
      'for (let start = 0; start < pcm.length; start += 14380) {',
      '  for (let i = 0; i < 7; i++) pcm[start + i] = Math.sin(i * 0.23) * (1 - i / 7);',
      '}',
      'const analysis = analyzePcm(pcm);',
      'setImmediate(() => console.log(JSON.stringify({ bpm: analysis.bpm, durationMs: analysis.durationMs })));',
    ].join('\n');
    const { stdout } = await promisify(execFile)(process.execPath, ['--eval', script], { timeout: 3_000 });
    expect(JSON.parse(stdout)).toEqual({ bpm: null, durationMs: 8000 });
  });

  it('85 BPM with loud eighth hats reads 85, not 170', () => {
    const { row } = run('85 loud hats', { ...BASE, bpm: 85, hats: 0.5 });
    expect(row.bpmErr).toBeLessThan(0.05);
  });
  it('88 BPM backbeat with hats reads 88, not 176', () => {
    const { row } = run('88 backbeat hats', { ...BASE, bpm: 88, pattern: 'backbeat', hats: 0.45 });
    expect(row.bpmErr).toBeLessThan(0.05);
  });
  it('172 BPM even kicks read 172, not 86', () => {
    const { row } = run('172 even kicks', { ...BASE, bpm: 172, hats: 0 });
    expect(row.bpmErr).toBeLessThan(0.05);
  });
  it('176 BPM with hats reads 176, not 88', () => {
    const { row } = run('176 hats', { ...BASE, bpm: 176, hats: 0.3 });
    expect(row.bpmErr).toBeLessThan(0.05);
  });
  it('the range edges: 81 and 179 BPM', () => {
    expect(run('81 edge', { ...BASE, bpm: 81 }).row.bpmErr).toBeLessThan(0.05);
    expect(run('179 edge', { ...BASE, bpm: 179 }).row.bpmErr).toBeLessThan(0.05);
  });
});

describe('dj analysis: trim', () => {
  it('a silent intro and outro: the sound starts and ends within a window, the first beat on the first kick', () => {
    const { a, s, row } = run('120 silent intro/outro', { ...BASE, bpm: 120, introSilenceS: 3.217, outroSilenceS: 4.1 });
    expect(row.trimStartErr).toBeLessThanOrEqual(20);
    expect(row.trimEndErr).toBeLessThanOrEqual(20);
    expect(Math.abs(a.firstBeatMs! - s.beats[0]! * 1000)).toBeLessThan(10);
    expect(a.durationMs).toBe(Math.round((s.pcm.length / s.sampleRate) * 1000));
  });

  it('a gapless track (sound from the first sample to the last): no trim', () => {
    const { a, s } = run('128 gapless', { ...BASE, bpm: 128, firstBeatS: 0.3 });
    expect(a.trimStartMs).toBe(0);
    expect(Math.abs(a.trimEndMs! - a.durationMs)).toBeLessThanOrEqual(1);
    expect(a.durationMs).toBe(Math.round((s.pcm.length / s.sampleRate) * 1000));
  });

  it('a chord before the drums: the first beat is on the grid the drums set, not at the chord', () => {
    const { a, s } = run('110 pad intro', { ...BASE, bpm: 110, firstBeatS: 6.4 });
    expect(a.trimStartMs).toBeLessThanOrEqual(20);
    expect(a.firstBeatMs!).toBeLessThan(60000 / 110 + 30);
    expect(Math.abs(gridError(a.firstBeatMs!, a.bpm!, s.beats[0]! * 1000))).toBeLessThan(10);
  });

  it('a quiet fade below −45 dBFS is trimmed', () => {
    const s = synthTrack({ ...BASE, bpm: 120, seconds: 30 });
    const fadeAt = Math.round(25 * s.sampleRate);
    for (let i = fadeAt; i < s.pcm.length; i++) s.pcm[i]! *= 10 ** (-60 / 20);
    const a = analyzePcm(s.pcm, s.sampleRate);
    expect(Math.abs(a.trimEndMs! - 25000)).toBeLessThanOrEqual(20);
  });
});

describe('dj analysis: nothing to measure', () => {
  it('digital silence: no tempo, no trim, flat peaks', () => {
    const a = analyzePcm(new Float32Array(11025 * 20));
    expect(a).toMatchObject({ bpm: null, bpmConfidence: null, firstBeatMs: null, trimStartMs: null, trimEndMs: null, durationMs: 20000 });
    expect(a.peaks.length).toBe(DJ_PEAK_BINS);
    expect(Math.max(...a.peaks)).toBe(0);
  });

  it('white noise has no steady pulse', () => {
    const s = synthTrack({ bpm: 120, seconds: 60, kick: 0, noise: 0.3 });
    const a = analyzePcm(s.pcm, s.sampleRate);
    expect(a.bpm == null || a.bpmConfidence! < 0.1).toBe(true);
    expect(a.trimStartMs).toBe(0);
  });

  it('a held chord without drums has no tempo', () => {
    const s = synthTrack({ bpm: 120, seconds: 60, kick: 0, pad: 0.5 });
    expect(analyzePcm(s.pcm, s.sampleRate).bpm).toBeNull();
  });

  it('a short clip (3 s) has no tempo but is trimmed', () => {
    const s = synthTrack({ ...BASE, bpm: 120, seconds: 3, introSilenceS: 1 });
    const a = analyzePcm(s.pcm, s.sampleRate);
    expect(a.bpm).toBeNull();
    expect(Math.abs(a.trimStartMs! - 1000)).toBeLessThanOrEqual(20);
  });

  it('a clip shorter than 900 hops has one peak bin per hop', () => {
    const a = analyzePcm(new Float32Array(441).fill(0.5));
    expect(a.peaks.length).toBe(11); // ten hops of 44 samples and the one left over
    expect([...a.peaks].every((p) => p === 128)).toBe(true);
  });
});

describe('dj analysis: streaming and peaks', () => {
  it('chunks of any size give the same answer as the whole signal', () => {
    const s = synthTrack({ ...BASE, bpm: 126, seconds: 40, introSilenceS: 1.5 });
    const whole = analyzePcm(s.pcm, s.sampleRate);
    const z = new DjAnalyzer(s.sampleRate);
    let i = 0;
    for (const size of [1, 7, 4096, 333, 65536, 10]) {
      while (i < s.pcm.length) {
        const end = Math.min(s.pcm.length, i + size);
        z.push(s.pcm.subarray(i, end));
        i = end;
        if (size !== 10 && Math.random() < 0.3) break;
      }
    }
    expect(z.finish()).toEqual(whole);
  });

  it('900 peak bins that follow the level; 0–1 for the API', () => {
    const s = synthTrack({ ...BASE, bpm: 120, seconds: 60 });
    for (let i = s.pcm.length / 2; i < s.pcm.length; i++) s.pcm[i] = 0;
    const a = analyzePcm(s.pcm, s.sampleRate);
    expect(a.peaks.length).toBe(900);
    expect(Math.max(...a.peaks.subarray(0, 440))).toBeGreaterThan(200);
    expect(Math.max(...a.peaks.subarray(452))).toBe(0);
    const unit = peaksToUnit(a.peaks);
    expect(unit.every((v) => v >= 0 && v <= 1)).toBe(true);
  });

  it('a NaN from a broken decode counts as silence', () => {
    const pcm = new Float32Array(11025 * 2);
    pcm[100] = NaN;
    expect(analyzePcm(pcm).trimStartMs).toBeNull();
  });

  it('a 24/192-length hour costs little memory: per-hop summaries only', () => {
    const z = new DjAnalyzer(11025);
    const chunk = synthTrack({ ...BASE, bpm: 128, seconds: 30 }).pcm;
    const before = process.memoryUsage().heapUsed;
    for (let i = 0; i < 120; i++) z.push(chunk); // an hour
    const a = z.finish();
    const grownMb = (process.memoryUsage().heapUsed - before) / 1e6;
    expect(a.durationMs).toBeGreaterThan(3_590_000);
    expect(Math.abs(a.bpm! - 128)).toBeLessThan(0.3); // a 30 s loop: its seam is off-grid, still near
    expect(grownMb).toBeLessThan(120);
  });
});

describe('dj analysis: the accuracy table', () => {
  it('prints it', () => {
    const f = (v: number | null, d = 2) => (v == null || Number.isNaN(v) ? '—' : v.toFixed(d));
    const lines = rows.map((r) => `| ${r.name} | ${r.want} | ${f(r.bpm)} | ${f(r.bpmErr, 3)} | ${f(r.phaseMs, 1)} | ${f(r.phaseMean, 1)} | ${f(r.trimStartErr, 0)} | ${f(r.trimEndErr, 0)} | ${f(r.conf, 2)} | ${f(r.msPerMin, 0)} |`);
    console.log(['| case | BPM | read | BPM err | worst beat err ms | mean beat offset ms | trim start err ms | trim end err ms | confidence | ms per min |', '|---|---|---|---|---|---|---|---|---|---|', ...lines].join('\n'));
    expect(rows.length).toBeGreaterThan(10);
  });
});
