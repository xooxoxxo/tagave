/**
 * The two things the updater talks to: the Docker CLI (with the compose
 * plugin) through the mounted socket, and the app over the internal network.
 * Both are interfaces so the state machine runs against fakes in the tests.
 */
import { spawn } from 'node:child_process';
import { signRequest } from './token.js';

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  /** Extra environment for this call (overrides the install's .env in compose interpolation). */
  env?: Record<string, string>;
  timeoutMs?: number;
  /** Told each piece of stdout and stderr as it arrives (download progress). */
  onOutput?: (chunk: string) => void;
}

/** Runs `docker <args>` in the install directory. */
export type Runner = (args: string[], opts?: RunOptions) => Promise<CommandResult>;

const MAX_OUTPUT = 256 * 1024;

export function dockerRunner(cwd: string): Runner {
  return (args, opts = {}) =>
    new Promise((resolve) => {
      const child = spawn('docker', args, {
        cwd,
        env: { ...process.env, ...(opts.env ?? {}) },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      const seen = (d: Buffer) => { try { opts.onOutput?.(d.toString()); } catch { /* progress only */ } };
      child.stdout.on('data', (d: Buffer) => { seen(d); if (stdout.length < MAX_OUTPUT) stdout += d.toString(); });
      child.stderr.on('data', (d: Buffer) => { seen(d); if (stderr.length < MAX_OUTPUT) stderr += d.toString(); });
      const timer = opts.timeoutMs
        ? setTimeout(() => { stderr += `\ntimed out after ${Math.round(opts.timeoutMs! / 1000)} s`; child.kill('SIGTERM'); }, opts.timeoutMs)
        : null;
      child.on('error', (err) => {
        if (timer) clearTimeout(timer);
        resolve({ code: 127, stdout, stderr: `${stderr}${err.message}` });
      });
      child.on('close', (code) => {
        if (timer) clearTimeout(timer);
        resolve({ code: code ?? 1, stdout, stderr });
      });
    });
}

export interface HealthAnswer {
  ok: boolean;
  /** Why not, in a few words. */
  detail: string;
}

export interface VersionsAnswer {
  app: string | null;
  workers: Array<{ workerId: string; version: string | null; lastSeenAt: string }>;
}

export interface AppProbe {
  /** GET /api/v1/health answered 200 with status ok. */
  health(): Promise<HealthAnswer>;
  /** The app's version and the workers' heartbeats; null when the app does not answer. */
  versions(): Promise<VersionsAnswer | null>;
}

const PROBE_TIMEOUT_MS = 5000;

export function httpAppProbe(baseUrl: string, appSecret: string): AppProbe {
  const base = baseUrl.replace(/\/$/, '');
  return {
    async health() {
      try {
        const res = await fetch(`${base}/api/v1/health`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
        const body = (await res.json().catch(() => ({}))) as { status?: string; database?: string; migrations?: string };
        if (res.ok && body.status === 'ok') return { ok: true, detail: 'ok' };
        return { ok: false, detail: `health answered ${res.status} (database ${body.database ?? '?'}, migrations ${body.migrations ?? '?'})` };
      } catch (err) {
        const e = err as Error;
        return { ok: false, detail: e.name === 'TimeoutError' ? 'the app does not answer within 5 s' : 'the app does not answer' };
      }
    },
    async versions() {
      const path = '/api/v1/internal/updater/versions';
      try {
        const res = await fetch(`${base}${path}`, {
          headers: signRequest(appSecret, 'GET', path),
          signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
        });
        if (res.status === 404) {
          // An app from before the updater: only its own version is known.
          const v = await fetch(`${base}/api/v1/version`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
          const body = (await v.json()) as { version?: string };
          return { app: body.version ?? null, workers: [] };
        }
        if (!res.ok) return null;
        return (await res.json()) as VersionsAnswer;
      } catch {
        return null;
      }
    },
  };
}
