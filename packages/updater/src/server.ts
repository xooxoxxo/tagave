/**
 * The updater's HTTP API. It listens on the compose network the app shares
 * with it (no published port); every request must carry the app's signature
 * (token.ts).
 *
 *   GET  /v1/status   the updater's version, the install's TAGAVE_VERSION,
 *                     and the current or last run
 *   POST /v1/update   {"version", "manifest", "signature"}: start an update
 *                     (202) to the release the signed manifest describes;
 *                     422 when the manifest does not check out (release.ts),
 *                     409 while a run is under way or while the updater
 *                     restarts itself on a new version (self-replace.ts)
 *   POST /v1/release  {"manifest", "signature"}: the signed manifest of the
 *                     release that runs here, kept next to the install once
 *                     it checks out (the app fetches it from the release)
 *   GET  /v1/modules  the module catalogue of that release, each module's
 *                     state, and the current or last module run
 *   POST /v1/modules/<id>/enable           turn a module on (202)
 *   POST /v1/modules/<id>/disable          {"deleteData": false}: turn it off (202)
 *
 * One run at a time: an update and a module run refuse each other (409),
 * and both wait while the updater replaces itself.
 */
import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import type { UpdateRun, UpdaterStatus } from '@tagave/shared/updater';
import type { ModuleRun, UpdaterModules } from '@tagave/shared/modules';
import { ModuleOperation, moduleStatuses, newModuleRun, type ModuleConfig } from './modules.js';
import { dockerArch } from './preflight-space.js';
import { MANIFEST_FILE, ReleaseRefused, SIGNATURE_FILE, platformOf, verifyRelease, type TrustedKey, type VerifiedRelease } from './release.js';
import { writeFileKeepingOwner } from './safe-write.js';
import { envGet, readText, writeFileAtomic } from './envFile.js';
import { mkdirKeepingOwner } from './safe-write.js';
import { HANDOVER_LABEL, SelfReplaceGate, parseState, serializeState, type SelfReplaceLog, type SelfReplaceMarker } from './self-replace.js';
import type { AppProbe, Runner } from './runner.js';
import { SIGNATURE_HEADER, SignatureVerifier, TIME_HEADER } from './token.js';
import { RELEASE_FLOOR_FILE, Update, newRun, type UpdateConfig } from './update.js';

/** Same rule as @tagave/shared UPDATE_TARGET_RE (kept here so the image needs no runtime packages). */
const TARGET_RE = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]{1,40})?$/;
/** A signed manifest travels in the body. */
const MAX_BODY = 600 * 1024;
const MODULE_PATH_RE = /^\/v1\/modules\/([a-z][a-z0-9-]{0,30})\/(enable|disable)$/;
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
  /** The public release keys (release.ts); none refuses every release. */
  keys: TrustedKey[];
  /** Docker's architecture here (amd64, arm64); default: this process's. */
  arch?: string;
  /** Module runs; default from `config`. */
  moduleConfig?: Partial<ModuleConfig>;
}

export interface RefusedStart {
  ok: false;
  status: number;
  error: string;
  /** Which release check refused (422). */
  check?: string;
  selfReplace?: SelfReplaceMarker | null;
}

export class UpdaterService {
  private run: UpdateRun | null = null;
  private active: Promise<UpdateRun> | null = null;
  private readonly verifier: SignatureVerifier;
  private readonly statePath: string;
  private readonly selfReplace: SelfReplaceGate;
  private writing: Promise<void> = Promise.resolve();
  private moduleRun: ModuleRun | null = null;
  private moduleActive: Promise<ModuleRun> | null = null;
  private readonly modulePath: string;

  constructor(private readonly opts: UpdaterOptions) {
    this.verifier = new SignatureVerifier(opts.appSecret);
    this.statePath = join(opts.installDir, STATE_DIR, 'state.json');
    this.modulePath = join(opts.installDir, STATE_DIR, 'module-run.json');
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

  /** Loads the last runs; a run still marked running was cut off (the updater or the host restarted). */
  async load(): Promise<void> {
    await this.loadModuleRun();
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

  private async loadModuleRun(): Promise<void> {
    const text = await readText(this.modulePath);
    if (!text) return;
    try {
      const run = JSON.parse(text) as ModuleRun;
      if (run.status === 'running') {
        const step = run.steps.find((s) => s.status === 'running');
        run.status = 'interrupted';
        run.finishedAt = new Date().toISOString();
        run.reason = `The updater stopped during "${step?.label ?? 'the module run'}". Check COMPOSE_PROFILES in .env (.env.bak is the file from before) and run docker compose up -d --remove-orphans in the install folder.`;
        if (step) step.status = 'failed';
        run.log.push({ at: run.finishedAt, level: 'error', message: 'the updater restarted in the middle of this run' });
        await this.saveModuleRun(run);
      }
      this.moduleRun = run;
    } catch {
      /* an unreadable state file is ignored */
    }
  }

  /**
   * The module run on disk, when none runs in this process: install-tagave.sh
   * enable-module runs the same state machine in a one-off container and
   * writes the same file.
   */
  private async refreshModuleRun(): Promise<void> {
    if (this.moduleActive) return;
    const text = await readText(this.modulePath);
    if (!text) return;
    try {
      this.moduleRun = JSON.parse(text) as ModuleRun;
    } catch {
      /* keep what we have */
    }
  }

  private async saveModuleRun(run: ModuleRun): Promise<void> {
    this.moduleRun = run;
    await mkdirKeepingOwner(join(this.opts.installDir, STATE_DIR), 0o700);
    await writeFileAtomic(this.modulePath, `${JSON.stringify(run, null, 2)}\n`, false);
  }

  // -- releases ------------------------------------------------------------------

  private async env(): Promise<string> {
    return (await readText(join(this.opts.installDir, '.env'))) ?? '';
  }

  /** This computer's platform: DOCKER_DEFAULT_PLATFORM from .env, else Docker's architecture. */
  async platform(): Promise<string> {
    return platformOf(this.opts.arch ?? dockerArch(), envGet(await this.env(), 'DOCKER_DEFAULT_PLATFORM'));
  }

  private async floor(): Promise<string | null> {
    return (await readText(join(this.opts.installDir, RELEASE_FLOOR_FILE)))?.trim() || null;
  }

  /** Verifies a manifest for `version`, not older than what runs here nor than any release run here before. */
  async verify(version: string, manifest: string, signature: string | null | undefined, running: string | null): Promise<VerifiedRelease> {
    return verifyRelease(manifest, signature, this.opts.keys, { version, running, floor: await this.floor() });
  }

  /** The signed manifest of the release that runs here (kept next to the install), checked; or why there is none. */
  async currentRelease(): Promise<{ verified: VerifiedRelease; problem: null } | { verified: null; problem: string }> {
    const version = envGet(await this.env(), 'TAGAVE_VERSION');
    if (!version) return { verified: null, problem: 'TAGAVE_VERSION is not set in .env' };
    const text = await readText(join(this.opts.installDir, MANIFEST_FILE));
    if (text === null) return { verified: null, problem: `the signed manifest of ${version} is not here yet` };
    try {
      return { verified: await this.verify(version, text, await readText(join(this.opts.installDir, SIGNATURE_FILE)), version), problem: null };
    } catch (err) {
      return { verified: null, problem: (err as Error).message };
    }
  }

  /** Takes the signed manifest of the running release (POST /v1/release). */
  async acceptRelease(manifest: string, signature: string): Promise<{ ok: true } | RefusedStart> {
    const version = envGet(await this.env(), 'TAGAVE_VERSION');
    if (!version) return { ok: false, status: 409, error: 'TAGAVE_VERSION is not set in .env' };
    try {
      const v = await this.verify(version, manifest, signature, version);
      await writeFileKeepingOwner(join(this.opts.installDir, MANIFEST_FILE), v.text, { fallbackMode: 0o644 });
      await writeFileKeepingOwner(join(this.opts.installDir, SIGNATURE_FILE), v.signature, { fallbackMode: 0o644 });
      return { ok: true };
    } catch (err) {
      if (err instanceof ReleaseRefused) return { ok: false, status: 422, error: err.message, check: err.check };
      throw err;
    }
  }

  private async busy(): Promise<RefusedStart | null> {
    const restarting = await this.selfReplace.refusal();
    if (restarting) return { ok: false, status: 409, error: restarting, selfReplace: this.selfReplace.current };
    if (this.active) return { ok: false, status: 409, error: 'an update is already running' };
    await this.refreshModuleRun();
    const elsewhere = !this.moduleActive && this.moduleRun?.status === 'running' && Date.now() - Date.parse(this.moduleRun.startedAt) < 60 * 60_000;
    if (this.moduleActive || elsewhere) return { ok: false, status: 409, error: `${this.moduleRun?.moduleName ?? 'a module'} is being turned ${this.moduleRun?.action === 'disable' ? 'off' : 'on'}` };
    return null;
  }

  // -- modules ---------------------------------------------------------------------

  async modules(): Promise<UpdaterModules> {
    await this.refreshModuleRun();
    const version = envGet(await this.env(), 'TAGAVE_VERSION');
    const current = await this.currentRelease();
    const modules = current.verified
      ? await moduleStatuses({ installDir: this.opts.installDir, release: current.verified, platform: await this.platform(), run: this.moduleRun, active: this.moduleActive !== null })
      : [];
    return { version, verified: current.verified !== null, problem: current.problem, modules, run: this.moduleRun };
  }

  async startModule(id: string, action: 'enable' | 'disable', deleteData: boolean): Promise<{ ok: true; run: ModuleRun } | RefusedStart> {
    const busy = await this.busy();
    if (busy) return busy;
    const current = await this.currentRelease();
    if (!current.verified) return { ok: false, status: 422, error: `modules come only from the signed catalogue of the release that runs here, and ${current.problem}`, check: 'manifest' };
    const entry = current.verified.manifest.modules.find((m) => m.id === id);
    if (!entry) return { ok: false, status: 404, error: `${id} is not in the signed catalogue of ${current.verified.manifest.version}; only official modules can be installed` };
    const run = newModuleRun(randomUUID(), entry, action, current.verified.manifest.version, deleteData, (this.opts.now ?? (() => new Date()))());
    const c = this.opts.config;
    const op = new ModuleOperation(
      {
        installDir: this.opts.installDir,
        docker: this.opts.docker,
        app: this.opts.app,
        config: {
          minFreeBytes: c.minFreeBytes,
          healthTimeoutMs: c.healthTimeoutMs,
          moduleHealthTimeoutMs: c.playerHealthTimeoutMs,
          pollMs: c.pollMs,
          commandTimeoutMs: c.commandTimeoutMs,
          ...this.opts.moduleConfig,
        },
        release: current.verified,
        platform: await this.platform(),
        save: (r) => this.saveModuleRun(r),
      },
      run,
    );
    await this.saveModuleRun(run);
    this.moduleActive = op.execute().finally(() => { this.moduleActive = null; });
    return { ok: true, run };
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
  async start(target: string, manifest?: string, signature?: string | null): Promise<{ ok: true; run: UpdateRun } | RefusedStart> {
    if (!TARGET_RE.test(target)) return { ok: false, status: 400, error: 'version must be a release number such as 0.8.0' };
    const busy = await this.busy();
    if (busy) return busy;
    const env = (await readText(join(this.opts.installDir, '.env'))) ?? '';
    const from = envGet(env, 'TAGAVE_VERSION') ?? 'unknown';
    // Nothing of the target is used before its signed manifest checks out.
    if (!manifest) return { ok: false, status: 422, error: `the update to ${target} came without its signed release manifest; the updater installs only signed releases`, check: 'unsigned' };
    let verified: VerifiedRelease;
    try {
      verified = await this.verify(target, manifest, signature, TARGET_RE.test(from) ? from : null);
    } catch (err) {
      if (err instanceof ReleaseRefused) return { ok: false, status: 422, error: `${err.message}. Nothing was changed.`, check: err.check };
      throw err;
    }
    const run = newRun(randomUUID(), from, target, new Date());
    const update = new Update(
      {
        installDir: this.opts.installDir,
        docker: this.opts.docker,
        app: this.opts.app,
        config: this.opts.config,
        save: (r) => this.save(r),
        selfReplace: this.selfReplace,
        release: { verified, platform: await this.platform() },
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
    await this.moduleActive?.catch(() => undefined);
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
    let json: Record<string, unknown> = {};
    if (req.method === 'POST') {
      try {
        const parsed = JSON.parse(body || '{}') as unknown;
        json = typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
      } catch {
        return send(400, { error: 'body must be JSON' });
      }
    }
    const text = (k: string) => (typeof json[k] === 'string' ? (json[k] as string) : undefined);
    const refused = (r: RefusedStart) => send(r.status, { error: r.error, ...(r.check ? { check: r.check } : {}), ...(r.selfReplace ? { selfReplace: r.selfReplace } : {}) });
    if (req.method === 'POST' && path === '/v1/update') {
      const result = await this.start(text('version') ?? '', text('manifest'), text('signature'));
      return result.ok ? send(202, { run: result.run }) : refused(result);
    }
    if (req.method === 'GET' && path === '/v1/modules') return send(200, await this.modules());
    if (req.method === 'POST' && path === '/v1/release') {
      const manifest = text('manifest');
      if (!manifest) return send(400, { error: 'manifest is required' });
      const result = await this.acceptRelease(manifest, text('signature') ?? '');
      return result.ok ? send(200, await this.modules()) : refused(result);
    }
    const m = MODULE_PATH_RE.exec(path);
    if (req.method === 'POST' && m) {
      const result = await this.startModule(m[1]!, m[2] as 'enable' | 'disable', json['deleteData'] === true);
      return result.ok ? send(202, { run: result.run }) : refused(result);
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
