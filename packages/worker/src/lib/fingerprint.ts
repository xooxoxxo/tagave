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

/** Cache key material: fingerprints are kilobytes long, the lookup cache is keyed by their hash. */
export function fingerprintHash(fingerprint: string): string {
  return createHash('sha1').update(fingerprint).digest('hex');
}
