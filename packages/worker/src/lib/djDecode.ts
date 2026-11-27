/**
 * ffmpeg for the dj module's analysis (jobs/djAnalyze.ts): the audio's own
 * hash, and the audio decoded to mono float PCM streamed into the analyser.
 *
 * Nothing is held whole: ffmpeg resamples to 11025 Hz mono as it decodes
 * and the analyser keeps per-4 ms summaries, so a 24/192 album costs what a
 * CD does in memory (a few MB per track), only more reading. ffmpeg runs at
 * a low CPU priority (nice 15), one at a time.
 */
import { createHash } from 'node:crypto';
import { DJ_SAMPLE_RATE, DjAnalyzer, type DjAnalysis } from '@tagave/core/dj';
import { FolderOfflineError } from './folderOffline.js';
import { spawnGuarded, type GuardedOptions, type GuardedResult } from './spawnGuarded.js';

const NICE = 15;
/**
 * spawnGuarded's idle deadline for both: this long with no output and (on
 * Linux) no reads by ffmpeg is a hung share. The hash writes nothing until
 * it is done; its reads keep it alive.
 */
const IDLE_MS = 120_000;

/** Which scan root the file is under (a hung share counts against it), and the environment for FFMPEG. */
export interface DjRunOptions {
  rootId: string;
  env?: NodeJS.ProcessEnv;
}

function ffmpegBin(env: NodeJS.ProcessEnv = process.env): string {
  return env['FFMPEG'] ?? 'ffmpeg';
}

/** ffmpeg's last words, for the error row. */
function lastLines(text: string): string {
  return text.trim().split('\n').slice(-2).join(' | ').slice(0, 400);
}

/** ffmpeg guarded, at a low CPU priority; a missing binary reads as one, an offline share stays FolderOfflineError. */
async function runFfmpeg(ffmpeg: string, args: string[], opts: GuardedOptions): Promise<GuardedResult> {
  try {
    return await spawnGuarded(ffmpeg, args, { ...opts, nice: NICE });
  } catch (err) {
    if (err instanceof FolderOfflineError) throw err;
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw new Error(`${ffmpeg} not found — install ffmpeg on this host or set FFMPEG`);
    throw err;
  }
}

/** Why ffmpeg failed: its last words, or how it ended. */
function ending(r: GuardedResult): string {
  return lastLines(r.stderr) || `exit ${r.code}`;
}

/** One track of a file: all of it, or a cue image's window. */
export interface DjWindow {
  startMs?: number | null;
  durationMs?: number | null;
}

/**
 * The audio's key: SHA-256 of the first audio stream's packets as stored
 * (ffmpeg's hash muxer over a stream copy: nothing is decoded, and tags,
 * cover art and padding are not packets), with the cue window when there
 * is one.
 */
export async function djAudioHash(path: string, window: DjWindow, opts: DjRunOptions): Promise<string> {
  const ffmpeg = ffmpegBin(opts.env);
  const r = await runFfmpeg(ffmpeg, ['-nostdin', '-v', 'error', '-i', path, '-map', '0:a:0', '-c', 'copy', '-f', 'hash', '-hash', 'sha256', '-'],
    { rootId: opts.rootId, idleMs: IDLE_MS, maxStdout: 64 * 1024 });
  const m = /SHA256=([0-9a-f]{64})/i.exec(r.stdout.toString());
  if (r.code !== 0 || !m) throw new Error(`ffmpeg could not read the audio: ${ending(r)}`);
  const out = m[1]!.toLowerCase();
  if (window.startMs == null) return out;
  return createHash('sha256').update(`${out}:${window.startMs}:${window.durationMs ?? 'end'}`).digest('hex');
}

/**
 * Decode one track to 11025 Hz mono float and analyse it as it streams.
 * Rejects with ffmpeg's words when the file does not decode.
 */
export async function djDecodeAndAnalyze(path: string, window: DjWindow, opts: DjRunOptions): Promise<DjAnalysis> {
  const ffmpeg = ffmpegBin(opts.env);
  const args = ['-nostdin', '-v', 'error', '-threads', '1'];
  if (window.startMs != null) args.push('-ss', (window.startMs / 1000).toFixed(3));
  args.push('-i', path);
  if (window.startMs != null && window.durationMs != null) args.push('-t', (window.durationMs / 1000).toFixed(3));
  args.push('-map', '0:a:0', '-vn', '-sn', '-dn', '-ac', '1', '-ar', String(DJ_SAMPLE_RATE), '-f', 'f32le', '-');
  const analyzer = new DjAnalyzer(DJ_SAMPLE_RATE);
  let carry: Buffer | null = null;
  // A throw from the analyser kills ffmpeg and rejects with it (spawnGuarded's onStdout).
  const r = await runFfmpeg(ffmpeg, args, {
    rootId: opts.rootId,
    idleMs: IDLE_MS,
    onStdout: (chunk) => {
      const buf: Buffer = carry ? Buffer.concat([carry, chunk]) : chunk;
      const usable = buf.length - (buf.length % 4);
      if (usable > 0) {
        // an aligned copy: the chunk's offset in its pool need not be a multiple of 4
        const f = new Float32Array(usable / 4);
        new Uint8Array(f.buffer).set(buf.subarray(0, usable));
        analyzer.push(f);
      }
      carry = usable < buf.length ? Buffer.from(buf.subarray(usable)) : null;
    },
  });
  if (r.code !== 0) throw new Error(`ffmpeg could not decode the audio: ${ending(r)}`);
  return analyzer.finish();
}
