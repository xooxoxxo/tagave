/**
 * The flac and metaflac command-line tools (the worker image's distro `flac`
 * package), behind one runner so tests can stand in for them. Every call
 * passes its arguments as a list (no shell) and absolute paths only, so a
 * file name is never parsed as an option.
 *
 * TAGAVE_FLAC_BIN / TAGAVE_METAFLAC_BIN point at other binaries.
 */
import { spawn } from 'node:child_process';
import { tagaveEnv } from '@tagave/shared/env';

export interface RunResult {
  code: number | null;
  stdout: Buffer;
  stderr: string;
}

/** Runs one binary with these arguments and collects what it writes. */
export type BinaryRunner = (bin: string, args: readonly string[]) => Promise<RunResult>;

/** Most a decoded window may be (±6 s of 32-bit 8-channel 384 kHz is ~150 MB): a guard against a runaway decode. */
const MAX_STDOUT = 256 * 1024 * 1024;

export const spawnRunner: BinaryRunner = (bin, args) => new Promise((resolve, reject) => {
  const child = spawn(bin, [...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  const out: Buffer[] = [];
  let size = 0;
  let err = '';
  child.stdout.on('data', (d: Buffer) => {
    size += d.length;
    if (size > MAX_STDOUT) {
      child.kill();
      return;
    }
    out.push(d);
  });
  child.stderr.on('data', (d: Buffer) => { err = (err + d.toString()).slice(-4000); });
  child.on('error', reject);
  child.on('close', (code) => resolve({ code: size > MAX_STDOUT ? -1 : code, stdout: Buffer.concat(out), stderr: err }));
});

export interface StreamInfo {
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  totalSamples: number;
}

/** Paths go in absolute only, so none can read as an option (a name starting with '-'). */
function abs(p: string): string {
  if (!p.startsWith('/')) throw new Error(`Not an absolute path: ${p}`);
  return p;
}

/** The last line of what a tool wrote to stderr: why it failed. */
function why(r: RunResult): string {
  return r.stderr.trim().split('\n').filter(Boolean).slice(-1)[0] ?? `exit code ${r.code}`;
}

export class FlacTools {
  readonly flac: string;
  readonly metaflac: string;

  constructor(private readonly run: BinaryRunner = spawnRunner, bins: { flac?: string; metaflac?: string } = {}) {
    this.flac = bins.flac ?? tagaveEnv('FLAC_BIN') ?? 'flac';
    this.metaflac = bins.metaflac ?? tagaveEnv('METAFLAC_BIN') ?? 'metaflac';
  }

  /** STREAMINFO: rate, channels, bits, total samples (one metaflac call per value, so the order is never in doubt). */
  async streamInfo(file: string): Promise<StreamInfo> {
    const one = async (flag: string): Promise<number> => {
      const r = await this.run(this.metaflac, [flag, abs(file)]);
      if (r.code !== 0) throw new Error(`metaflac could not read ${flag.slice(7)}: ${why(r)}`);
      const n = Number(r.stdout.toString().trim());
      if (!Number.isSafeInteger(n) || n < 0) throw new Error(`metaflac gave no ${flag.slice(7)}`);
      return n;
    };
    return {
      sampleRate: await one('--show-sample-rate'),
      channels: await one('--show-channels'),
      bitsPerSample: await one('--show-bps'),
      totalSamples: await one('--show-total-samples'),
    };
  }

  /** True when the file holds a CUESHEET metadata block. */
  async hasCueSheet(file: string): Promise<boolean> {
    const r = await this.run(this.metaflac, ['--list', '--block-type=CUESHEET', abs(file)]);
    if (r.code !== 0) throw new Error(`metaflac could not list the file: ${why(r)}`);
    return r.stdout.length > 0;
  }

  /** Samples [skip, until) decoded to interleaved little-endian signed PCM. */
  async decodeWindow(file: string, skip: number, until: number): Promise<Buffer> {
    const r = await this.run(this.flac, [
      '-d', '-c', '-s', '--force-raw-format', '--endian=little', '--sign=signed',
      `--skip=${skip}`, `--until=${until}`, abs(file),
    ]);
    if (r.code !== 0) throw new Error(`flac could not decode around sample ${skip}: ${why(r)}`);
    return r.stdout;
  }

  /**
   * Samples [skip, until) re-encoded losslessly into `out` at -8 (the
   * source's rate and bits; flac copies the source's metadata, its pictures
   * among them). flac without -f refuses an existing `out`.
   */
  async encodePart(source: string, skip: number, until: number, out: string): Promise<void> {
    const r = await this.run(this.flac, ['-s', '-8', `--skip=${skip}`, `--until=${until}`, '-o', abs(out), abs(source)]);
    if (r.code !== 0) throw new Error(`flac could not write a track: ${why(r)}`);
  }

  /** flac -t: the whole file decodes and its MD5 matches. */
  async decodes(file: string): Promise<boolean> {
    const r = await this.run(this.flac, ['-t', '-s', abs(file)]);
    return r.code === 0;
  }
}
