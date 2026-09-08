/**
 * Build identity for every Liner process (spec PLT-5 / XO-313): the app, the
 * workers and the doctor report the same triple so a split-host deploy can be
 * seen to lag. Resolution order, first hit wins:
 *  1. env LINER_VERSION / LINER_GIT_SHA / LINER_BUILT_AT — baked into the
 *     Docker images as build args;
 *  2. a DEPLOYED file (the short sha scripts/deploy.sh writes) found walking
 *     up from the process cwd and from this module — the bare-node workers;
 *  3. `git rev-parse HEAD` when a .git directory is reachable — dev.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface BuildInfo {
  version: string;
  sha: string | null;
  builtAt: string | null;
  source: 'env' | 'deployed-file' | 'git' | 'unknown';
}

function findUp(start: string, name: string, maxDepth = 6): string | null {
  let dir = resolve(start);
  for (let i = 0; i <= maxDepth; i++) {
    const candidate = join(dir, name);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function readRootVersion(from: string): string | null {
  const pkg = findUp(from, 'pnpm-workspace.yaml');
  if (!pkg) return null;
  try {
    const parsed = JSON.parse(readFileSync(join(dirname(pkg), 'package.json'), 'utf-8')) as { version?: string };
    return parsed.version ?? null;
  } catch {
    return null;
  }
}

let cached: BuildInfo | null = null;

export function readBuildInfo(): BuildInfo {
  if (cached) return cached;
  const here = dirname(fileURLToPath(import.meta.url));
  const version = process.env['LINER_VERSION'] || readRootVersion(process.cwd()) || readRootVersion(here) || '0.0.0';

  if (process.env['LINER_GIT_SHA']) {
    cached = { version, sha: process.env['LINER_GIT_SHA'], builtAt: process.env['LINER_BUILT_AT'] ?? null, source: 'env' };
    return cached;
  }

  const deployed = findUp(process.cwd(), 'DEPLOYED') ?? findUp(here, 'DEPLOYED');
  if (deployed) {
    try {
      const sha = readFileSync(deployed, 'utf-8').trim();
      const builtAt = statSync(deployed).mtime.toISOString();
      if (sha) {
        cached = { version, sha, builtAt, source: 'deployed-file' };
        return cached;
      }
    } catch {
      /* fall through */
    }
  }

  const gitDir = findUp(process.cwd(), '.git') ?? findUp(here, '.git');
  if (gitDir) {
    try {
      const sha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: dirname(gitDir), stdio: ['ignore', 'pipe', 'ignore'] })
        .toString().trim();
      cached = { version, sha: sha || null, builtAt: null, source: 'git' };
      return cached;
    } catch {
      /* fall through */
    }
  }

  cached = { version, sha: null, builtAt: null, source: 'unknown' };
  return cached;
}
