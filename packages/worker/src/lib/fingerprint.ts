import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** Chromaprint fingerprints the first two minutes; AcoustID indexes that window. */
export const FPCALC_LENGTH_S = 120;

export interface Fingerprint {
  fingerprint: string;
  durationS: number;
}

/**
 * `fpcalc -json` (libchromaprint-tools; the worker image ships it, a bare host
 * needs `apt install libchromaprint-tools`). Decodes through FFmpeg, so every
 * container the scanner indexes works, APE and WavPack included.
 */
export async function fpcalcFingerprint(path: string, opts: { lengthS?: number; fpcalc?: string } = {}): Promise<Fingerprint> {
  const bin = opts.fpcalc ?? process.env['FPCALC'] ?? 'fpcalc';
  let stdout: string;
  try {
    ({ stdout } = await run(bin, ['-json', '-length', String(opts.lengthS ?? FPCALC_LENGTH_S), path], { maxBuffer: 4 * 1024 * 1024, timeout: 120_000 }));
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stderr?: string };
    if (e.code === 'ENOENT') throw new Error(`${bin} not found — install libchromaprint-tools on this host or set FPCALC`);
    throw new Error(`fpcalc failed: ${(e.stderr ?? e.message).trim().split('\n').slice(-2).join(' | ')}`);
  }
  const parsed = JSON.parse(stdout) as { duration?: number; fingerprint?: string };
  if (!parsed.fingerprint || typeof parsed.duration !== 'number') throw new Error('fpcalc returned no fingerprint');
  return { fingerprint: parsed.fingerprint, durationS: parsed.duration };
}

/**
 * Fingerprint one slice of a file — a virtual track of a cue image: ffmpeg
 * decodes `lengthS` seconds from `startS` to raw PCM on a pipe and fpcalc reads
 * the stream. fpcalc reports no duration for a stream, so the caller passes the
 * track's own duration to AcoustID. ~0.6 s per track on g9.
 */
export async function fpcalcSliceFingerprint(
  path: string,
  startS: number,
  opts: { lengthS?: number; fpcalc?: string; ffmpeg?: string } = {},
): Promise<string> {
  const ffmpeg = opts.ffmpeg ?? process.env['FFMPEG'] ?? 'ffmpeg';
  const fpcalc = opts.fpcalc ?? process.env['FPCALC'] ?? 'fpcalc';
  const lengthS = opts.lengthS ?? FPCALC_LENGTH_S;
  const { spawn } = await import('node:child_process');
  return new Promise<string>((resolve, reject) => {
    const dec = spawn(ffmpeg, ['-nostdin', '-v', 'error', '-ss', String(startS), '-t', String(lengthS), '-i', path,
      '-f', 's16le', '-ac', '2', '-ar', '44100', '-'], { stdio: ['ignore', 'pipe', 'pipe'] });
    const fp = spawn(fpcalc, ['-json', '-format', 's16le', '-rate', '44100', '-channels', '2', '-length', String(lengthS), '-'],
      { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let errText = '';
    const timer = setTimeout(() => { dec.kill('SIGKILL'); fp.kill('SIGKILL'); reject(new Error('fpcalc slice timed out')); }, 120_000);
    dec.stdout.pipe(fp.stdin);
    dec.stderr.on('data', (d: Buffer) => { errText += d.toString(); });
    fp.stderr.on('data', (d: Buffer) => { errText += d.toString(); });
    fp.stdout.on('data', (d: Buffer) => { out += d.toString(); });
    dec.on('error', (e) => { clearTimeout(timer); reject(new Error(e.message.includes('ENOENT') ? `${ffmpeg} not found` : e.message)); });
    fp.on('error', (e) => { clearTimeout(timer); reject(new Error(e.message.includes('ENOENT') ? `${fpcalc} not found — install libchromaprint-tools or set FPCALC` : e.message)); });
    // fpcalc closes its stdin once it has -length seconds; ffmpeg then sees EPIPE, which is fine
    fp.stdin.on('error', () => undefined);
    fp.on('close', (code) => {
      clearTimeout(timer);
      try {
        const parsed = JSON.parse(out) as { fingerprint?: string };
        if (code === 0 && parsed.fingerprint) return resolve(parsed.fingerprint);
      } catch { /* fall through */ }
      reject(new Error(`fpcalc slice failed: ${errText.trim().split('\n').slice(-2).join(' | ') || `exit ${code}`}`));
    });
  });
}

/** Cache key material: fingerprints are kilobytes long, the lookup cache is keyed by their hash. */
export function fingerprintHash(fingerprint: string): string {
  return createHash('sha1').update(fingerprint).digest('hex');
}
