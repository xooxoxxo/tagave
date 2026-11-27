import { createHash } from 'node:crypto';
import { FolderOfflineError } from './folderOffline.js';
import { spawnGuarded, type GuardedResult } from './spawnGuarded.js';

/** Chromaprint fingerprints the first two minutes; AcoustID indexes that window. */
export const FPCALC_LENGTH_S = 120;

/** The deadline between two writes of fpcalc or ffmpeg (spawnGuarded's idle deadline). */
const IDLE_MS = 120_000;

/** Raw PCM as the slice decode writes it: 16-bit stereo at 44.1 kHz. */
const PCM_BYTES_PER_S = 44_100 * 2 * 2;

export interface Fingerprint {
  fingerprint: string;
  durationS: number;
}

/** The tool's last words, for the error row. */
function lastLines(text: string): string {
  return text.trim().split('\n').slice(-2).join(' | ');
}

/** Runs a tool guarded; a missing binary reads as one, an offline share stays FolderOfflineError. */
async function runTool(bin: string, args: string[], opts: Parameters<typeof spawnGuarded>[2], missing: string): Promise<GuardedResult> {
  try {
    return await spawnGuarded(bin, args, opts);
  } catch (err) {
    if (err instanceof FolderOfflineError) throw err;
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw new Error(missing);
    throw err;
  }
}

/**
 * `fpcalc -json` (libchromaprint-tools; the worker image ships it, a bare host
 * needs `apt install libchromaprint-tools`). Decodes through FFmpeg, so every
 * container the scanner indexes works, APE and WavPack included. Runs through
 * spawnGuarded: a hung music share throws FolderOfflineError for `rootId`.
 */
export async function fpcalcFingerprint(path: string, opts: { rootId: string; lengthS?: number; fpcalc?: string }): Promise<Fingerprint> {
  const bin = opts.fpcalc ?? process.env['FPCALC'] ?? 'fpcalc';
  const r = await runTool(bin, ['-json', '-length', String(opts.lengthS ?? FPCALC_LENGTH_S), path],
    { rootId: opts.rootId, idleMs: IDLE_MS, maxStdout: 4 * 1024 * 1024 },
    `${bin} not found. Install libchromaprint-tools on this host or set FPCALC`);
  if (r.code !== 0) throw new Error(`fpcalc failed: ${lastLines(r.stderr) || `exit ${r.code}`}`);
  let parsed: { duration?: number; fingerprint?: string };
  try {
    parsed = JSON.parse(r.stdout.toString()) as typeof parsed;
  } catch {
    throw new Error('fpcalc returned no fingerprint');
  }
  if (!parsed.fingerprint || typeof parsed.duration !== 'number') throw new Error('fpcalc returned no fingerprint');
  return { fingerprint: parsed.fingerprint, durationS: parsed.duration };
}

/**
 * Fingerprint one slice of a file — a virtual track of a cue image: ffmpeg
 * decodes `lengthS` seconds from `startS` to raw PCM and fpcalc reads it on
 * stdin. fpcalc reports no duration for a stream, so the caller passes the
 * track's own duration to AcoustID. The PCM is held between the two (about
 * 21 MB for two minutes), so each tool runs on its own under spawnGuarded.
 */
export async function fpcalcSliceFingerprint(
  path: string,
  startS: number,
  opts: { rootId: string; lengthS?: number; fpcalc?: string; ffmpeg?: string },
): Promise<string> {
  const ffmpeg = opts.ffmpeg ?? process.env['FFMPEG'] ?? 'ffmpeg';
  const fpcalc = opts.fpcalc ?? process.env['FPCALC'] ?? 'fpcalc';
  const lengthS = opts.lengthS ?? FPCALC_LENGTH_S;
  const dec = await runTool(ffmpeg, ['-nostdin', '-v', 'error', '-ss', String(startS), '-t', String(lengthS), '-i', path,
    '-f', 's16le', '-ac', '2', '-ar', '44100', '-'],
  { rootId: opts.rootId, idleMs: IDLE_MS, maxStdout: (Math.ceil(lengthS) + 1) * PCM_BYTES_PER_S }, `${ffmpeg} not found`);
  if (dec.code !== 0) throw new Error(`fpcalc slice failed: ${lastLines(dec.stderr) || `ffmpeg exit ${dec.code}`}`);
  const fp = await runTool(fpcalc, ['-json', '-format', 's16le', '-rate', '44100', '-channels', '2', '-length', String(lengthS), '-'],
    { rootId: opts.rootId, idleMs: IDLE_MS, input: dec.stdout, maxStdout: 4 * 1024 * 1024 },
    `${fpcalc} not found. Install libchromaprint-tools or set FPCALC`);
  try {
    const parsed = JSON.parse(fp.stdout.toString()) as { fingerprint?: string };
    if (fp.code === 0 && parsed.fingerprint) return parsed.fingerprint;
  } catch { /* fall through */ }
  throw new Error(`fpcalc slice failed: ${lastLines(fp.stderr) || `exit ${fp.code}`}`);
}

/** Cache key material: fingerprints are kilobytes long, the lookup cache is keyed by their hash. */
export function fingerprintHash(fingerprint: string): string {
  return createHash('sha1').update(fingerprint).digest('hex');
}
