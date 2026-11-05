/**
 * dj.analyze against the test database and a real ffmpeg, on generated
 * music (core › dj/testSignals.ts) encoded to FLAC and MP3: the switch
 * gates it; the tempo, first beat and trim points survive the decode and
 * resampling; a re-tag only re-hashes; changed audio is measured again; a
 * copy of measured audio takes its row; a cue image's track is measured in
 * its own window; a file that does not decode leaves an error row; and the
 * sweep's order puts queued, then recently played tracks first.
 */
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, stat, writeFile, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import pino from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { djEnabled, makeDb, setDjEnabled, syncInstalledModules } from '@tagave/db';
import { ledgerEntries } from '@tagave/core/facets';
import { gridError, synthTrack, type SynthSpec } from '@tagave/core/dj';
import type { WorkerContext } from '../lib/context.js';
import { djAudioHash, djDecodeAndAnalyze, type DjWindow } from '../lib/djDecode.js';
import { DJ_PRIORITY, SWEEP_BATCH, djAnalyzeJob, djSweepCandidates, type DjDecoder } from './djAnalyze.js';

function ffmpegAvailable(): boolean {
  try {
    execFileSync(process.env['FFMPEG'] ?? 'ffmpeg', ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** 32-bit float mono WAV of a synthetic track (ffmpeg then encodes it). */
function wavBytes(pcm: Float32Array, sampleRate: number): Buffer {
  const data = Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + data.length, 4);
  h.write('WAVE', 8);
  h.write('fmt ', 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(3, 20); // IEEE float
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(sampleRate, 24);
  h.writeUInt32LE(sampleRate * 4, 28);
  h.writeUInt16LE(4, 32);
  h.writeUInt16LE(32, 34);
  h.write('data', 36);
  h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

const ff = (args: string[]) => execFileSync(process.env['FFMPEG'] ?? 'ffmpeg', ['-nostdin', '-v', 'error', '-y', ...args]);

describe.skipIf(!process.env.TEST_DATABASE_URL || !ffmpegAvailable())('dj.analyze (db, ffmpeg)', () => {
  let ctx: WorkerContext;
  let sql: any;
  let was = false;
  let dir: string;
  const sent: Array<{ name: string; data: unknown; opts: any }> = [];
  const tag = randomUUID().slice(0, 8);
  const user = randomUUID();
  const libraryId = randomUUID();
  const rootId = randomUUID();
  const albumId = randomUUID();
  const synths: Record<string, ReturnType<typeof synthTrack>> = {};

  /** A file of generated music, indexed as a scan leaves it, and its track. */
  async function track(name: string, spec: SynthSpec, opts: { format?: 'flac' | 'mp3'; trackNo?: number; title?: string } = {}) {
    const s = synthTrack({ sampleRate: 44100, ...spec });
    synths[name] = s;
    const wav = path.join(dir, `${name}.wav`);
    await writeFile(wav, wavBytes(s.pcm, s.sampleRate));
    const rel = `${name}.${opts.format ?? 'flac'}`;
    ff(['-i', wav, '-ac', '2', ...(opts.format === 'mp3' ? ['-b:a', '192k'] : ['-sample_fmt', 's16']), '-metadata', `title=${opts.title ?? name}`, path.join(dir, rel)]);
    await rm(wav);
    const st = await stat(path.join(dir, rel));
    const [f] = await sql`insert into files (library_id, scan_root_id, rel_path, size_bytes, mtime, status, handler, duration_ms, last_seen_at)
                          values (${libraryId}, ${rootId}, ${rel}, ${st.size}, ${Math.floor(st.mtimeMs)}, 'present', 'audio', ${Math.round(s.pcm.length / s.sampleRate * 1000)}, now())
                          returning id::text as id`;
    const [t] = await sql`insert into local_tracks (local_album_id, audio_file_id, track_no, disc_no, title_guess, origin, duration_ms)
                          values (${albumId}, ${f.id}, ${opts.trackNo ?? 1}, 1, ${name}, 'file', ${Math.round(s.pcm.length / s.sampleRate * 1000)})
                          returning id::text as id`;
    return { fileId: f.id as string, trackId: t.id as string, rel };
  }

  const row = async (trackId: string) => {
    const [r] = await sql`select audio_hash, bpm::float8 as bpm, bpm_confidence, first_beat_ms, trim_start_ms, trim_end_ms, duration_ms,
                                 length(peaks) as bins, error, analyzed_at from dj_track_analysis where local_track_id = ${trackId}`;
    return r;
  };

  beforeAll(async () => {
    const made = await makeDb(process.env.TEST_DATABASE_URL!);
    sql = made.client;
    const boss = { send: async (name: string, data: unknown, opts: unknown) => { sent.push({ name, data, opts }); return randomUUID(); } };
    ctx = { db: made.db, sql, boss: boss as any, logger: pino({ level: 'silent' }) };
    await syncInstalledModules(sql, ledgerEntries());
    was = await djEnabled(sql);
    dir = await mkdtemp(path.join(tmpdir(), 'tagave-dj-'));
    await sql`insert into users (id, email) values (${user}, ${`dj-${tag}@example.test`})`;
    await sql`insert into libraries (id, owner_user_id, name) values (${libraryId}, ${user}, 'dj test')`;
    await sql`insert into scan_roots (id, library_id, path, display_name, validation_status) values (${rootId}, ${libraryId}, ${dir}, 'dj', 'ok')`;
    await sql`insert into local_albums (id, library_id, cluster_key, title_guess, artist_guess, state, dir_paths, track_count)
              values (${albumId}, ${libraryId}, ${`ck-dj-${tag}`}, 'DJ test', 'Artist', 'matched', ${['.']}, 9)`;
  }, 60_000);

  beforeEach(async () => {
    sent.length = 0;
    await setDjEnabled(sql, true);
  });

  afterAll(async () => {
    await setDjEnabled(sql, was);
    await sql`delete from libraries where id = ${libraryId}`;
    await sql`delete from users where id = ${user}`;
    await sql.end({ timeout: 2 });
    await rm(dir, { recursive: true, force: true });
  });

  it('off: every run skips', async () => {
    await setDjEnabled(sql, false);
    expect(await djAnalyzeJob(ctx, { localTrackId: randomUUID() })).toEqual({ skipped: 'dj is off' });
    expect(await djAnalyzeJob(ctx, { sweep: true })).toEqual({ skipped: 'dj is off' });
  });

  it('measures a FLAC through ffmpeg: tempo, first beat, trim, peaks', async () => {
    const t = await track('flac-124', { bpm: 124, seconds: 40, hats: 0.35, pad: 0.15, noise: 0.01, introSilenceS: 1.3, outroSilenceS: 2.2 });
    expect(await djAnalyzeJob(ctx, { localTrackId: t.trackId })).toEqual({ outcome: 'analyzed' });
    const r = await row(t.trackId);
    const s = synths['flac-124']!;
    expect(r.error).toBeNull();
    expect(r.audio_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(Math.abs(r.bpm - 124)).toBeLessThan(0.05);
    expect(Math.abs(gridError(r.first_beat_ms, r.bpm, s.beats[0]! * 1000))).toBeLessThan(10);
    expect(Math.abs(r.first_beat_ms - s.beats[0]! * 1000)).toBeLessThan(10);
    expect(Math.abs(r.trim_start_ms - 1300)).toBeLessThanOrEqual(25);
    expect(Math.abs(r.trim_end_ms - (1300 + 40000))).toBeLessThanOrEqual(25);
    expect(Math.abs(r.duration_ms - 43500)).toBeLessThanOrEqual(30);
    expect(r.bins).toBe(900);
    // current: a second run does nothing
    expect(await djAnalyzeJob(ctx, { localTrackId: t.trackId })).toEqual({ outcome: 'current' });
  }, 60_000);

  it('an MP3 (encoder delay and all) reads the same tempo', async () => {
    const t = await track('mp3-140', { bpm: 140, seconds: 30, hats: 0.3, pad: 0.15 }, { format: 'mp3', trackNo: 2 });
    expect(await djAnalyzeJob(ctx, { localTrackId: t.trackId })).toEqual({ outcome: 'analyzed' });
    const r = await row(t.trackId);
    expect(Math.abs(r.bpm - 140)).toBeLessThan(0.05);
    expect(Math.abs(gridError(r.first_beat_ms, r.bpm, synths['mp3-140']!.beats[0]! * 1000))).toBeLessThan(15);
  }, 60_000);

  it('a re-tag keeps the analysis (the audio hash is the same); changed audio is measured again', async () => {
    const t = await track('retag', { bpm: 100, seconds: 20, pad: 0.1 }, { trackNo: 3 });
    await djAnalyzeJob(ctx, { localTrackId: t.trackId });
    const before = await row(t.trackId);
    // a new title and a bigger padding: another size and mtime, the same audio
    const full = path.join(dir, t.rel);
    ff(['-i', full, '-c', 'copy', '-metadata', 'title=Retagged with a much longer title than before', '-metadata', 'comment=x'.repeat(50), `${full}.tmp.flac`]);
    await rename(`${full}.tmp.flac`, full);
    const st = await stat(full);
    await sql`update files set size_bytes = ${st.size}, mtime = ${Math.floor(st.mtimeMs) + 1000} where id = ${t.fileId}`;
    expect(await djAnalyzeJob(ctx, { localTrackId: t.trackId })).toEqual({ outcome: 'rehashed' });
    const after = await row(t.trackId);
    expect(after.audio_hash).toBe(before.audio_hash);
    expect(after.analyzed_at).toEqual(before.analyzed_at);
    // new audio at another tempo in the same file
    const s = synthTrack({ sampleRate: 44100, bpm: 132, seconds: 20, pad: 0.1 });
    await writeFile(`${full}.wav`, wavBytes(s.pcm, s.sampleRate));
    ff(['-i', `${full}.wav`, '-ac', '2', '-sample_fmt', 's16', full]);
    await rm(`${full}.wav`);
    const st2 = await stat(full);
    await sql`update files set size_bytes = ${st2.size}, mtime = ${Math.floor(st2.mtimeMs) + 2000} where id = ${t.fileId}`;
    expect(await djAnalyzeJob(ctx, { localTrackId: t.trackId })).toEqual({ outcome: 'analyzed' });
    const changed = await row(t.trackId);
    expect(changed.audio_hash).not.toBe(before.audio_hash);
    expect(Math.abs(changed.bpm - 132)).toBeLessThan(0.05);
  }, 60_000);

  it('a copy of measured audio takes its row without decoding', async () => {
    const a = await track('twin-a', { bpm: 118, seconds: 15, pad: 0.1, seed: 5 }, { trackNo: 4, title: 'Twin' });
    const b = await track('twin-b', { bpm: 118, seconds: 15, pad: 0.1, seed: 5 }, { trackNo: 5, title: 'Twin (compilation)' });
    await djAnalyzeJob(ctx, { localTrackId: a.trackId });
    let decoded = 0;
    const counting: DjDecoder = { hash: (p, w) => djAudioHash(p, w), analyze: (p, w) => { decoded++; return djDecodeAndAnalyze(p, w); } };
    expect(await djAnalyzeJob(ctx, { localTrackId: b.trackId }, counting)).toEqual({ outcome: 'copied' });
    expect(decoded).toBe(0);
    const [ra, rb] = [await row(a.trackId), await row(b.trackId)];
    expect(rb.audio_hash).toBe(ra.audio_hash);
    expect(rb.bpm).toBe(ra.bpm);
    expect(rb.first_beat_ms).toBe(ra.first_beat_ms);
  }, 60_000);

  it('a cue image track is measured in its own window', async () => {
    // one file: 20 s at 96 BPM, then 20 s at 150 BPM; the second track starts at 20 s
    const s1 = synthTrack({ sampleRate: 44100, bpm: 96, seconds: 20, pad: 0.1 });
    const s2 = synthTrack({ sampleRate: 44100, bpm: 150, seconds: 20, pad: 0.1, firstBeatS: 0.25 });
    const pcm = new Float32Array(s1.pcm.length + s2.pcm.length);
    pcm.set(s1.pcm);
    pcm.set(s2.pcm, s1.pcm.length);
    const wav = path.join(dir, 'image.wav');
    await writeFile(wav, wavBytes(pcm, 44100));
    ff(['-i', wav, '-ac', '2', '-sample_fmt', 's16', path.join(dir, 'image.flac')]);
    await rm(wav);
    const st = await stat(path.join(dir, 'image.flac'));
    const [f] = await sql`insert into files (library_id, scan_root_id, rel_path, size_bytes, mtime, status, handler, duration_ms, last_seen_at)
                          values (${libraryId}, ${rootId}, 'image.flac', ${st.size}, ${Math.floor(st.mtimeMs)}, 'present', 'audio', 40000, now()) returning id::text as id`;
    const start1 = Math.round((s1.pcm.length / 44100) * 1000);
    const [t1] = await sql`insert into local_tracks (local_album_id, audio_file_id, track_no, origin, cue_start_ms, duration_ms)
                           values (${albumId}, ${f.id}, 6, 'cue', 0, ${start1}) returning id::text as id`;
    const [t2] = await sql`insert into local_tracks (local_album_id, audio_file_id, track_no, origin, cue_start_ms, duration_ms)
                           values (${albumId}, ${f.id}, 7, 'cue', ${start1}, null) returning id::text as id`;
    await djAnalyzeJob(ctx, { localTrackId: t1.id });
    await djAnalyzeJob(ctx, { localTrackId: t2.id });
    const [r1, r2] = [await row(t1.id), await row(t2.id)];
    expect(Math.abs(r1.bpm - 96)).toBeLessThan(0.1);
    expect(Math.abs(r2.bpm - 150)).toBeLessThan(0.1);
    // times are from the track's own start
    expect(Math.abs(r2.first_beat_ms - 250)).toBeLessThan(12);
    expect(Math.abs(r2.duration_ms - 20000)).toBeLessThanOrEqual(30);
    expect(r1.audio_hash).not.toBe(r2.audio_hash);
  }, 60_000);

  it('a file that does not decode leaves an error row; the sweep waits a week for it', async () => {
    await writeFile(path.join(dir, 'broken.flac'), Buffer.from('not a flac at all'));
    const [f] = await sql`insert into files (library_id, scan_root_id, rel_path, size_bytes, mtime, status, handler, last_seen_at)
                          values (${libraryId}, ${rootId}, 'broken.flac', 17, 1, 'present', 'audio', now()) returning id::text as id`;
    const [t] = await sql`insert into local_tracks (local_album_id, audio_file_id, track_no, origin) values (${albumId}, ${f.id}, 8, 'file') returning id::text as id`;
    expect(await djAnalyzeJob(ctx, { localTrackId: t.id })).toEqual({ outcome: 'failed' });
    const r = await row(t.id);
    expect(r.error).toMatch(/ffmpeg/);
    expect(r.audio_hash).toBeNull();
    expect(await djSweepCandidates(sql, 100, libraryId)).not.toContain(t.id);
    await sql`update dj_track_analysis set analyzed_at = now() - interval '8 days' where local_track_id = ${t.id}`;
    expect(await djSweepCandidates(sql, 100, libraryId)).toContain(t.id);
    await sql`delete from local_tracks where id = ${t.id}`;
  });

  it('the sweep: queued tracks first (from where the person is), then recently played, then album order', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 4; i++) {
      const [f] = await sql`insert into files (library_id, scan_root_id, rel_path, size_bytes, mtime, status, handler, last_seen_at)
                            values (${libraryId}, ${rootId}, ${`sweep-${i}.flac`}, 10, 1, 'present', 'audio', now()) returning id::text as id`;
      const [t] = await sql`insert into local_tracks (local_album_id, audio_file_id, track_no, disc_no, origin) values (${albumId}, ${f.id}, ${20 + i}, 1, 'file') returning id::text as id`;
      ids.push(t.id);
    }
    const [played, queuedPast, queuedNext, plain] = ids as [string, string, string, string];
    await sql`insert into player_queue_state (user_id, items, idx, device_id)
              values (${user}, ${JSON.stringify([{ id: queuedPast, origin: 'context' }, { id: queuedNext, origin: 'context' }])}::jsonb, 1, 'dev')`;
    await sql`insert into player_plays (user_id, library_id, dedupe_key, source, local_track_id, title, started_at, heard, scrobbles)
              values (${user}, ${libraryId}, ${`dj-${tag}`}, 'web', ${played}, 'Played', now() - interval '1 day', true, true)`;
    const order = (await djSweepCandidates(sql, 100, libraryId)).filter((id) => ids.includes(id));
    // queuedPast is behind the person's place in the queue: an ordinary track
    expect(order).toEqual([queuedNext, played, queuedPast, plain]);

    const result = await djAnalyzeJob(ctx, { sweep: true });
    expect(result).toMatchObject({ queued: expect.any(Number) });
    const tracks = sent.filter((s) => (s.data as any).localTrackId);
    expect(tracks.length).toBeGreaterThan(0);
    expect(tracks.length).toBeLessThanOrEqual(SWEEP_BATCH);
    for (const s of tracks) expect(s.opts).toMatchObject({ singletonKey: `dj:${(s.data as any).localTrackId}`, priority: DJ_PRIORITY.swept });
    const chained = sent.filter((s) => (s.data as any).sweep);
    expect(chained.length).toBe(tracks.length === SWEEP_BATCH ? 1 : 0);
    if (chained.length) expect(chained[0]!.opts).toMatchObject({ singletonKey: 'dj:sweep', priority: DJ_PRIORITY.sweep });
    await sql`delete from player_queue_state where user_id = ${user}`;
    await sql`delete from player_plays where user_id = ${user}`;
    await sql`delete from local_tracks where id = any(${ids}::uuid[])`;
  });

  it('a gone file is not decoded', async () => {
    const decoder: DjDecoder = { hash: async () => { throw new Error('should not run'); }, analyze: async () => { throw new Error('should not run'); } };
    const [f] = await sql`insert into files (library_id, scan_root_id, rel_path, status, handler, last_seen_at)
                          values (${libraryId}, ${rootId}, 'gone.flac', 'missing', 'audio', now()) returning id::text as id`;
    const [t] = await sql`insert into local_tracks (audio_file_id, origin) values (${f.id}, 'file') returning id::text as id`;
    expect(await djAnalyzeJob(ctx, { localTrackId: t.id }, decoder)).toEqual({ outcome: 'gone' });
    expect(await djAnalyzeJob(ctx, { localTrackId: randomUUID() }, decoder)).toEqual({ outcome: 'gone' });
  });
});

describe.skipIf(!ffmpegAvailable())('dj decode: the audio hash ignores tags', () => {
  it('FLAC and MP3: a re-tag keeps the hash, a cue window changes it', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'tagave-djh-'));
    try {
      const s = synthTrack({ sampleRate: 44100, bpm: 120, seconds: 5, pad: 0.1 });
      await writeFile(path.join(dir, 'a.wav'), wavBytes(s.pcm, 44100));
      for (const ext of ['flac', 'mp3']) {
        ff(['-i', path.join(dir, 'a.wav'), '-metadata', 'title=One', path.join(dir, `a.${ext}`)]);
        ff(['-i', path.join(dir, `a.${ext}`), '-c', 'copy', '-metadata', 'title=Two, and longer', '-metadata', 'artist=Someone', path.join(dir, `b.${ext}`)]);
        const [ha, hb] = [await djAudioHash(path.join(dir, `a.${ext}`)), await djAudioHash(path.join(dir, `b.${ext}`))];
        expect(ha).toBe(hb);
        const w: DjWindow = { startMs: 1000, durationMs: 2000 };
        expect(await djAudioHash(path.join(dir, `a.${ext}`), w)).not.toBe(ha);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
