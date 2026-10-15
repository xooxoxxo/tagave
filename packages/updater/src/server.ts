/**
 * The updater's HTTP API. It listens on the compose network the app shares
 * with it (no published port); every request must carry the app's signature
 * (token.ts).
 *
 *   GET  /v1/status   the updater's version, the install's TAGAVE_VERSION,
 *                     and the current or last run
 *   POST /v1/update   {"version": "0.8.0"}: start an update (202), or 409
 *                     while one runs or while the updater restarts itself
 *                     on a new version (self-replace.ts)
 */
import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import type { UpdateRun, UpdaterStatus } from '@tagave/shared/updater';
import { envGet, readText, writeFileAtomic } from './envFile.js';
import { mkdirKeepingOwner } from './safe-write.js';
import { HANDOVER_LABEL, SelfReplaceGate, parseState, serializeState, type SelfReplaceLog, type SelfReplaceMarker } from './self-replace.js';
import type { AppProbe, Runner } from './runner.js';
import { SIGNATURE_HEADER, SignatureVerifier, TIME_HEADER } from './token.js';
import { Update, newRun, type UpdateConfig } from './update.js';

/** Same rule as @tagave/shared UPDATE_TARGET_RE (kept here so the image needs no runtime packages). */
const TARGET_RE = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]{1,40})?$/;
const MAX_BODY = 4096;
export const STATE_DIR = '.updater';

export interface UpdaterOptions {
  installDir: string;
  appSecret: string;
  version: string;
  docker: Runner;
  app: AppProbe;
  config: UpdateConfig;
  now?: () => Date;
  log?: SelfReplaceLog;
}

export class UpdaterService {
  private run: UpdateRun | null = null;
  private active: Promise<UpdateRun> | null = null;
  private readonly verifier: SignatureVerifier;
  private readonly statePath: string;
  private readonly selfReplace: SelfReplaceGate;
  private writing: Promise<void> = Promise.resolve();

  constructor(private readonly opts: UpdaterOptions) {
    this.verifier = new SignatureVerifier(opts.appSecret);
    this.statePath = join(opts.installDir, STATE_DIR, 'state.json');
    this.selfReplace = new SelfReplaceGate({
      version: opts.version,
      persist: () => this.writeState(),
      handoverRunning: async () => {
        const res = await opts.docker(['ps', '-q', '--filter', `label=${HANDOVER_LABEL}`], { timeoutMs: 15_000 });
        return res.code === 0 ? res.stdout.trim() !== '' : null;
      },
      ...(opts.now ? { now: opts.now } : {}),
      ...(opts.log ? { log: opts.log } : {}),
    });
  }

  /** Loads the last run; a run still marked running was cut off (the updater or the host restarted). */
  async load(): Promise<void> {
    const text = await readText(this.statePath);
    if (!text) return;
    try {
      const { run, marker } = parseState(text);
      if (!run) return;
      this.run = run;
      await this.selfReplace.adopt(marker);
      if (run.status === 'running') {
        const step = run.steps.find((s) => s.status === 'running');
        run.status = 'interrupted';
        run.finishedAt = new Date().toISOString();
        run.reason = `The updater stopped during "${step?.label ?? 'the update'}". Check TAGAVE_VERSION in .env and run docker compose up -d in the install folder; the backup from before the update is ${run.backup ?? 'not taken yet'}.`;
        if (step) step.status = 'failed';
        run.log.push({ at: run.finishedAt, level: 'error', message: 'the updater restarted in the middle of this update' });
        await this.save(run);
      }
      this.run = run;
    } catch {
      /* an unreadable state file is ignored */
    }
  }

  private async save(run: UpdateRun): Promise<void> {
    this.run = run;
    await this.writeState();
  }

  /** state.json: the run, and the self-replace marker while one is pending. One write at a time. */
  private writeState(): Promise<void> {
    const write = async () => {
      if (!this.run) return;
      await mkdirKeepingOwner(join(this.opts.installDir, STATE_DIR), 0o700);
      await writeFileAtomic(this.statePath, serializeState(this.run, this.selfReplace.current), false);
    };
    const next = this.writing.then(write, write);
    this.writing = next.catch(() => undefined);
    return next;
  }

  async status(): Promise<UpdaterStatus> {
    const env = (await readText(join(this.opts.installDir, '.env'))) ?? '';
    const svc = await this.opts.docker(['compose', 'config', '--services'], { timeoutMs: 30_000 });
    return {
      version: this.opts.version,
      configuredVersion: envGet(env, 'TAGAVE_VERSION'),
      role: envGet(env, 'TAGAVE_ROLE'),
      services: svc.code === 0 ? svc.stdout.split('\n').map((s) => s.trim()).filter((s) => s && s !== 'updater') : [],
      run: this.run,
      selfReplace: await this.selfReplace.status(),
    };
  }

  /** Starts a run in the background. */
  async start(target: string): Promise<{ ok: true; run: UpdateRun } | { ok: false; status: number; error: string; selfReplace?: SelfReplaceMarker | null }> {
    if (!TARGET_RE.test(target)) return { ok: false, status: 400, error: 'version must be a release number such as 0.8.0' };
    const restarting = await this.selfReplace.refusal();
    if (restarting) return { ok: false, status: 409, error: restarting, selfReplace: this.selfReplace.current };
    if (this.active) return { ok: false, status: 409, error: 'an update is already running' };
    const env = (await readText(join(this.opts.installDir, '.env'))) ?? '';
    const from = envGet(env, 'TAGAVE_VERSION') ?? 'unknown';
    const run = newRun(randomUUID(), from, target, new Date());
    const update = new Update(
      {
        installDir: this.opts.installDir,
        docker: this.opts.docker,
        app: this.opts.app,
        config: this.opts.config,
        save: (r) => this.save(r),
        selfReplace: this.selfReplace,
      },
      run,
    );
    this.run = run;
    await this.save(run);
    this.active = update.execute().finally(() => { this.active = null; });
    return { ok: true, run };
  }

  /** Resolves when the running update (if any) has finished. For tests. */
  async idle(): Promise<void> {
    await this.active?.catch(() => undefined);
  }

  async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(body));
    };
    let body = '';
    for await (const chunk of req) {
      body += chunk;
      if (body.length > MAX_BODY) return send(413, { error: 'body too large' });
    }
    const path = req.url ?? '/';
    const header = (n: string) => {
      const v = req.headers[n];
      return Array.isArray(v) ? v[0] : v;
    };
    const auth = this.verifier.verify({ method: req.method ?? 'GET', path, body, time: header(TIME_HEADER), signature: header(SIGNATURE_HEADER) });
    if (!auth.ok) return send(401, { error: auth.reason });

    if (req.method === 'GET' && path === '/v1/status') return send(200, await this.status());
    if (req.method === 'POST' && path === '/v1/update') {
      let version: unknown;
      try {
        version = (JSON.parse(body || '{}') as { version?: unknown }).version;
      } catch {
        return send(400, { error: 'body must be JSON' });
      }
      const result = await this.start(typeof version === 'string' ? version : '');
      if (result.ok) return send(202, { run: result.run });
      return send(result.status, { error: result.error, ...(result.selfReplace ? { selfReplace: result.selfReplace } : {}) });
    }
    return send(404, { error: 'not found' });
  }

  listen(port: number, host = '0.0.0.0'): Server {
    const server = createServer((req, res) => {
      this.handle(req, res).catch((err: unknown) => {
        if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: (err as Error).message }));
      });
    });
    server.listen(port, host);
    return server;
  }
}
