/**
 * A throwaway tagave: Postgres in one container (data on tmpfs, so no
 * volume), the API and the worker from this checkout's build as child
 * processes. Everything is named siteshots-<run id>; stop() removes exactly
 * what start() made.
 */
import { spawn, execFile } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { createServer } from 'node:net';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function freePort() {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.unref();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

export async function until(what, fn, { timeoutMs, everyMs = 2000 }) {
  const end = Date.now() + timeoutMs;
  let last;
  while (Date.now() < end) {
    try {
      last = await fn();
      if (last) return last;
    } catch (err) {
      last = String(err?.message ?? err);
    }
    await sleep(everyMs);
  }
  throw new Error(`timed out after ${Math.round(timeoutMs / 1000)}s waiting for ${what} (last: ${JSON.stringify(last)?.slice(0, 400)})`);
}

export class Stack {
  constructor({ repo, runDir, runId, log = console.log }) {
    this.repo = repo;
    this.runDir = runDir;
    this.name = `siteshots-${runId}`;
    this.log = log;
    this.children = [];
    this.container = null;
  }

  async start() {
    const pgPort = await freePort();
    const pgPassword = randomBytes(12).toString('hex');
    this.log(`  postgres container ${this.name} on 127.0.0.1:${pgPort}`);
    await exec('docker', [
      'run', '-d', '--rm', '--name', this.name, '--label', 'siteshots=1',
      '--tmpfs', '/var/lib/postgresql/data:rw',
      '-e', 'POSTGRES_USER=tagave', '-e', `POSTGRES_PASSWORD=${pgPassword}`, '-e', 'POSTGRES_DB=tagave',
      '-p', `127.0.0.1:${pgPort}:5432`,
      'postgres:16', '-c', 'max_connections=300', '-c', 'fsync=off', '-c', 'synchronous_commit=off',
    ]);
    this.container = this.name;
    await until('postgres to accept connections', async () => {
      await exec('docker', ['exec', this.name, 'pg_isready', '-U', 'tagave', '-d', 'tagave', '-h', '127.0.0.1']);
      return true;
    }, { timeoutMs: 60_000, everyMs: 1000 });
    this.databaseUrl = `postgres://tagave:${pgPassword}@127.0.0.1:${pgPort}/tagave`;

    this.port = await freePort();
    this.baseUrl = `http://localhost:${this.port}`;
    const env = {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      NODE_ENV: 'production',
      LOG_LEVEL: 'info',
      DATABASE_URL: this.databaseUrl,
      APP_SECRET: randomBytes(32).toString('hex'),
      PUBLIC_URL: this.baseUrl,
      PORT: String(this.port),
      HOST: '127.0.0.1',
      ALLOW_INSECURE_HTTP: 'true',
      CACHE_DIR: path.join(this.runDir, 'cache'),
      BACKUP_DIR: path.join(this.runDir, 'backups'),
      TAGAVE_UPDATE_FEED: 'off',
      TAGAVE_SKIP_PREMIGRATE_BACKUP: '1',
      // the host's disk use is not the demo's: no "disk is filling up" banner
      TAGAVE_DISK_WARN_PCT: '99.8',
      TAGAVE_DISK_FAIL_PCT: '99.9',
    };
    this.env = env;
    this.spawn('api', ['packages/api/dist/index.js'], env);
    await until('the API health check', async () => (await fetch(`${this.baseUrl}/api/v1/health`)).ok, { timeoutMs: 120_000, everyMs: 1000 });
    this.spawn('worker', ['packages/worker/dist/index.js'], env);
    this.log(`  tagave at ${this.baseUrl} (logs in the run folder)`);
  }

  spawn(label, args, env) {
    const out = createWriteStream(path.join(this.runDir, `${label}.log`));
    const child = spawn(process.execPath, args, { cwd: this.repo, env, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.pipe(out);
    child.stderr.pipe(out);
    child.on('exit', (code, signal) => {
      if (!this.stopping) this.log(`  ! ${label} exited (${code ?? signal}); see ${label}.log`);
    });
    this.children.push({ label, child });
    return child;
  }

  async stop() {
    this.stopping = true;
    for (const { child } of this.children) {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    }
    await Promise.all(this.children.map(({ child }) => (child.exitCode !== null || child.signalCode !== null)
      ? null
      : Promise.race([new Promise((r) => child.once('exit', r)), sleep(8000).then(() => child.kill('SIGKILL'))])));
    if (this.container) {
      // --rm: stopping removes the container; the data was on tmpfs.
      await exec('docker', ['rm', '-f', this.container]).catch(() => undefined);
      this.log(`  removed container ${this.container}`);
      this.container = null;
    }
  }
}
