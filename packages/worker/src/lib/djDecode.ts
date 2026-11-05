/**
 * ffmpeg for the dj module's analysis (jobs/djAnalyze.ts): the audio's own
 * hash, and the audio decoded to mono float PCM streamed into the analyser.
 *
 * Nothing is held whole: ffmpeg resamples to 11025 Hz mono as it decodes
 * and the analyser keeps per-4 ms summaries, so a 24/192 album costs what a
 * CD does in memory (a few MB per track), only more reading. ffmpeg runs at
 * a low CPU priority (nice 15), one at a time.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { setPriority } from 'node:os';
import { DJ_SAMPLE_RATE, DjAnalyzer, type DjAnalysis } from '@tagave/core/dj';

const NICE = 15;
/** A track is decoded at many times real time; an hour's mix still ends well inside this. */
const DECODE_TIMEOUT_MS = 20 * 60_000;
const HASH_TIMEOUT_MS = 10 * 60_000;

function ffmpegBin(env: NodeJS.ProcessEnv = process.env): string {
  return env['FFMPEG'] ?? 'ffmpeg';
}

function lowPriority(child: ChildProcess): void {
  try {
    if (child.pid) setPriority(child.pid, NICE);
  } catch {
    // not allowed here (some containers): it still runs one at a time
  }
}

/** ffmpeg's last words, for the error row. */
function lastLines(text: string): string {
  return text.trim().split('\n').slice(-2).join(' | ').slice(0, 400);
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
export async function djAudioHash(path: string, window: DjWindow = {}, env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const ffmpeg = ffmpegBin(env);
  const out = await new Promise<string>((resolve, reject) => {
    const child = spawn(ffmpeg, ['-nostdin', '-v', 'error', '-i', path, '-map', '0:a:0', '-c', 'copy', '-f', 'hash', '-hash', 'sha256', '-'],
      { stdio: ['ignore', 'pipe', 'pipe'] });
    lowPriority(child);
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), HASH_TIMEOUT_MS);
    child.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(new Error((e as NodeJS.ErrnoException).code === 'ENOENT' ? `${ffmpeg} not found — install ffmpeg on this host or set FFMPEG` : e.message));
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      const m = /SHA256=([0-9a-f]{64})/i.exec(stdout);
      if (code === 0 && m) return resolve(m[1]!.toLowerCase());
      reject(new Error(`ffmpeg could not read the audio: ${lastLines(stderr) || (signal ? `killed (${signal})` : `exit ${code}`)}`));
    });
  });
  if (window.startMs == null) return out;
  return createHash('sha256').update(`${out}:${window.startMs}:${window.durationMs ?? 'end'}`).digest('hex');
}

/**
 * Decode one track to 11025 Hz mono float and analyse it as it streams.
 * Rejects with ffmpeg's words when the file does not decode.
 */
export async function djDecodeAndAnalyze(path: string, window: DjWindow = {}, env: NodeJS.ProcessEnv = process.env): Promise<DjAnalysis> {
  const ffmpeg = ffmpegBin(env);
  const args = ['-nostdin', '-v', 'error', '-threads', '1'];
  if (window.startMs != null) args.push('-ss', (window.startMs / 1000).toFixed(3));
  args.push('-i', path);
  if (window.startMs != null && window.durationMs != null) args.push('-t', (window.durationMs / 1000).toFixed(3));
  args.push('-map', '0:a:0', '-vn', '-sn', '-dn', '-ac', '1', '-ar', String(DJ_SAMPLE_RATE), '-f', 'f32le', '-');
  const analyzer = new DjAnalyzer(DJ_SAMPLE_RATE);
  return new Promise<DjAnalysis>((resolve, reject) => {
    const child = spawn(ffmpeg, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    lowPriority(child);
    let stderr = '';
    let carry: Buffer | null = null;
    let failed: Error | null = null;
    const timer = setTimeout(() => { failed = new Error('ffmpeg took too long'); child.kill('SIGKILL'); }, DECODE_TIMEOUT_MS);
    child.stdout.on('data', (chunk: Buffer) => {
      if (failed) return;
      const buf: Buffer = carry ? Buffer.concat([carry, chunk]) : chunk;
      const usable = buf.length - (buf.length % 4);
      if (usable > 0) {
        // an aligned copy: the chunk's offset in its pool need not be a multiple of 4
        const f = new Float32Array(usable / 4);
        new Uint8Array(f.buffer).set(buf.subarray(0, usable));
        try {
          analyzer.push(f);
        } catch (err) {
          failed = err as Error;
          child.kill('SIGKILL');
        }
      }
      carry = usable < buf.length ? Buffer.from(buf.subarray(usable)) : null;
    });
    child.stderr.on('data', (d: Buffer) => { if (stderr.length < 8192) stderr += d.toString(); });
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(new Error((e as NodeJS.ErrnoException).code === 'ENOENT' ? `${ffmpeg} not found — install ffmpeg on this host or set FFMPEG` : e.message));
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (failed) return reject(failed);
      if (code !== 0) return reject(new Error(`ffmpeg could not decode the audio: ${lastLines(stderr) || (signal ? `killed (${signal})` : `exit ${code}`)}`));
      try {
        resolve(analyzer.finish());
      } catch (err) {
        reject(err as Error);
      }
    });
  });
}
