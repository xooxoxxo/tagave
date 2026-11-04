/**
 * The real flac and metaflac (the worker image's distro package), on a
 * generated album image: three tones with silences between them, at 16-bit
 * 44.1 kHz and 24-bit 96 kHz, with an embedded picture. The plan finds the
 * silences; each track re-encodes from exactly its samples; the written
 * tracks decode (flac -t), their sample counts add up to the source's
 * exactly, their audio joined again is the source's byte for byte, and the
 * picture comes along. Skipped where flac is not installed: run it in the
 * worker image (docs in the PR) or with flac from brew.
 */
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { verifySplit } from '@tagave/core';
import { FlacTools, spawnRunner } from './flacTools.js';
import { planFromFile } from '../jobs/filesSplit.js';
import { MutagenTagWriter, resolvePythonInterpreter } from './tagWriter.js';

const hasFlac = spawnSync('flac', ['--version']).status === 0 && spawnSync('metaflac', ['--version']).status === 0;
const hasMutagen = spawnSync(resolvePythonInterpreter(), ['-c', 'import mutagen']).status === 0;

/** A 1×1 PNG. */
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082', 'hex');

/** Raw interleaved little-endian signed PCM: tones of these seconds, each followed by the gap's silence. */
function album(rate: number, bits: 16 | 24, tones: number[], gapS: number): Buffer {
  const bytes = bits / 8;
  const parts: Buffer[] = [];
  const full = 2 ** (bits - 1) - 1;
  tones.forEach((sec, k) => {
    const n = Math.round(sec * rate);
    const gap = k < tones.length - 1 ? Math.round(gapS * rate) : 0;
    const b = Buffer.alloc((n + gap) * 2 * bytes);
    const freq = 330 + 110 * k;
    for (let i = 0; i < n; i++) {
      const v = Math.round(0.5 * full * Math.sin((2 * Math.PI * freq * i) / rate));
      for (let c = 0; c < 2; c++) b.writeIntLE(v, (i * 2 + c) * bytes, bytes);
    }
    parts.push(b);
  });
  return Buffer.concat(parts);
}

describe.skipIf(!hasFlac)('flac and metaflac for a split (real binaries)', () => {
  let dir: string;
  const tools = new FlacTools(spawnRunner);
  beforeAll(async () => { dir = await mkdtemp(path.join(tmpdir(), 'tagave-flac-')); });
  afterAll(async () => { await rm(dir, { recursive: true, force: true }); });

  for (const { rate, bits } of [{ rate: 44_100, bits: 16 as const }, { rate: 96_000, bits: 24 as const }]) {
    it(`splits a ${bits}-bit ${rate / 1000} kHz image at its silences, every sample once`, async () => {
      // tones of 7 s, 9 s, 6 s with 1 s of silence after the first two; the
      // "release" says 7.6 s and 9.8 s (the cuts sit 0.4 s and 0.6 s later)
      const raw = album(rate, bits, [7, 9, 6], 1);
      const rawPath = path.join(dir, `src-${rate}.raw`);
      const src = path.join(dir, `Whole Album ${rate}.flac`);
      await writeFile(rawPath, raw);
      const enc = spawnSync('flac', ['-s', '--force-raw-format', '--endian=little', '--sign=signed', `--channels=2`, `--bps=${bits}`,
        `--sample-rate=${rate}`, '-o', src, rawPath]);
      expect(enc.status, enc.stderr.toString()).toBe(0);
      await writeFile(path.join(dir, 'cover.png'), PNG);
      expect(spawnSync('metaflac', ['--import-picture-from=3||||' + path.join(dir, 'cover.png'), src]).status).toBe(0);

      const info = await tools.streamInfo(src);
      const total = raw.length / (2 * (bits / 8));
      expect(info).toEqual({ sampleRate: rate, channels: 2, bitsPerSample: bits, totalSamples: total });
      expect(await tools.hasCueSheet(src)).toBe(false);

      const plan = await planFromFile(tools, src, [
        { disc: 1, position: 1, title: 'Low', lengthMs: 7_600 },
        { disc: 1, position: 2, title: 'Mid', lengthMs: 9_800 },
        { disc: 1, position: 3, title: 'High', lengthMs: 6_600 },
      ]);
      expect(plan.tracks.map((t) => t.confidence)).toEqual([null, 'high', 'high']);
      // each cut in its silence (7–8 s, 17–18 s)
      expect(plan.tracks[1]!.startSample / rate).toBeGreaterThan(7);
      expect(plan.tracks[1]!.startSample / rate).toBeLessThan(8);
      expect(plan.tracks[2]!.startSample / rate).toBeGreaterThan(17);
      expect(plan.tracks[2]!.startSample / rate).toBeLessThan(18);

      const outs: string[] = [];
      const written = [];
      for (const t of plan.tracks) {
        const out = path.join(dir, `${rate}-${t.fileName}`);
        await tools.encodePart(src, t.startSample, t.endSample, out);
        outs.push(out);
        written.push({ decodes: await tools.decodes(out), samples: (await tools.streamInfo(out)).totalSamples });
      }
      expect(verifySplit(plan, written, 100)).toEqual([]);
      expect(written.reduce((n, w) => n + w.samples, 0)).toBe(total);
      // lossless: the tracks decoded and joined are the source, byte for byte
      const back: Buffer[] = [];
      for (const out of outs) {
        const d = spawnSync('flac', ['-d', '-c', '-s', '--force-raw-format', '--endian=little', '--sign=signed', out], { maxBuffer: 64 * 1024 * 1024 });
        expect(d.status).toBe(0);
        back.push(d.stdout);
      }
      expect(Buffer.concat(back).equals(raw)).toBe(true);
      // the picture came along; the rate and bits stayed
      for (const out of outs) {
        expect(spawnSync('metaflac', ['--list', '--block-type=PICTURE', out]).stdout.length).toBeGreaterThan(0);
        expect(await tools.streamInfo(out)).toMatchObject({ sampleRate: rate, bitsPerSample: bits, channels: 2 });
      }
      // flac refuses to write over a file
      await expect(tools.encodePart(src, 0, 1000, outs[0]!)).rejects.toThrow(/flac could not write a track/);
      // a window decodes to exactly its samples
      const w = await tools.decodeWindow(src, rate, 2 * rate);
      expect(w.length).toBe(rate * 2 * (bits / 8));
      const end = await tools.decodeWindow(src, total - rate, total);
      expect(end.length).toBe(rate * 2 * (bits / 8));
    });
  }

  it('sees an embedded cue sheet', async () => {
    const src = path.join(dir, 'Whole Album 44100.flac');
    const cue = path.join(dir, 'image.cue');
    await writeFile(cue, 'FILE "x.wav" WAVE\n  TRACK 01 AUDIO\n    INDEX 01 00:00:00\n  TRACK 02 AUDIO\n    INDEX 01 00:08:00\n');
    const copy = path.join(dir, 'with-cue.flac');
    await writeFile(copy, await readFile(src));
    const r = spawnSync('metaflac', ['--import-cuesheet-from=' + cue, '--no-cued-seekpoints', copy]);
    expect(r.status, r.stderr.toString()).toBe(0);
    expect(await tools.hasCueSheet(copy)).toBe(true);
  });

  it.skipIf(!hasMutagen)('tags a written track with the mutagen writer, keeping its picture', async () => {
    const out = path.join(dir, '44100-02 - Mid.flac');
    const w = new MutagenTagWriter();
    try {
      await w.write(out, { title: 'Mid', album: 'Whole Album', tracknumber: '2', totaltracks: '3', musicbrainz_albumid: '00000000-0000-4000-8000-000000000001' });
      const tags = await w.read(out);
      expect(tags).toMatchObject({ title: 'Mid', album: 'Whole Album', tracknumber: '2', totaltracks: '3' });
    } finally {
      await w.close();
    }
    expect(spawnSync('metaflac', ['--list', '--block-type=PICTURE', out]).stdout.length).toBeGreaterThan(0);
    expect(await tools.decodes(out)).toBe(true);
  });
});
