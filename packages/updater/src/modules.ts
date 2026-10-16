/**
 * Turning an optional module on or off, as a state machine like an update.
 * The module comes from the signed catalogue of the release this install
 * runs (release.ts); nothing else can be installed.
 *
 * Turn on:
 *
 *   preflight  the module fits this install (role, release, not on yet, its
 *              services known to compose), room on disk for its images
 *              (preflight-space.ts), then its images pulled by digest and
 *              each pulled digest checked against the manifest. Nothing in
 *              the install has changed yet.
 *   config     its settings in .env (secrets generated once and kept), its
 *              image pins, its profile in COMPOSE_PROFILES and, for a module
 *              compose.yml does not carry, modules/<id>.yml in COMPOSE_FILE;
 *              .env kept as .env.bak; compose must accept the result
 *   start      docker compose up -d for its services, then the services that
 *              read its settings (the app reads TAGAVE_PLAYER_URL)
 *   verify     its containers report healthy, the app answers healthy
 *
 * Turn off:
 *
 *   preflight  it is on
 *   stop       its containers stopped and removed
 *   config     its profile out of COMPOSE_PROFILES (and its compose file out
 *              of COMPOSE_FILE), the settings it marks cleared; secrets stay
 *   verify     the services that read its settings restarted and healthy
 *   data       only when the owner ticked it: its volumes deleted
 *
 * A failure in preflight ends the run as `failed`: nothing changed. A
 * failure later rolls back: its containers removed (Turn on) or started
 * again (Turn off), .env and the module's compose file put back as they
 * were, the app restarted and checked. The data step runs last, after
 * everything else worked, and is never rolled back (nothing can bring
 * deleted data back), so it can only fail on its own.
 */
import { randomBytes } from 'node:crypto';
import { statfs } from 'node:fs/promises';
import { join } from 'node:path';
import type { UpdateLogLine } from '@tagave/shared/updater';
import type { ModuleEntry, ModuleRun, ModuleState, ModuleStatus, ModuleStep, ModuleStepId, ReleaseManifest } from '@tagave/shared/modules';
import { envGet, envSet, readText, writeFileAtomic } from './envFile.js';
import { compareReleases, normalizeRepository } from './image-hygiene.js';
import { checkSpace, registryClient, type Layer, type StatfsLike } from './preflight-space.js';
import { ReleaseRefused, digestFor, moduleImages, pinnedRef, type VerifiedRelease } from './release.js';
import type { AppProbe, CommandResult, Runner } from './runner.js';
import { mkdirKeepingOwner, writeFileKeepingOwner } from './safe-write.js';
import { redact } from './redact.js';
import { unlink } from 'node:fs/promises';

export const MODULE_STEP_LABELS: Record<'enable' | 'disable', Partial<Record<ModuleStepId, string>>> = {
  enable: {
    preflight: 'Check the release signature, the disk and download the images',
    config: 'Add its settings to the configuration',
    start: 'Start it',
    verify: 'Check it runs and reports healthy',
    rollback: 'Roll back',
  },
  disable: {
    preflight: 'Check the install',
    stop: 'Stop it',
    config: 'Remove it from the configuration',
    verify: 'Restart the app and check it',
    data: 'Delete its data',
    rollback: 'Roll back',
  },
};

const ENABLE: ModuleStepId[] = ['preflight', 'config', 'start', 'verify', 'rollback'];
const DISABLE: ModuleStepId[] = ['preflight', 'stop', 'config', 'verify', 'data', 'rollback'];
const MAX_LOG_LINES = 400;
export const MODULES_DIR = 'modules';

export interface ModuleConfig {
  /** Left free on Docker's filesystem once the module's images are in. */
  minFreeBytes: number;
  /** How long the app may take to answer healthy after a restart. */
  healthTimeoutMs: number;
  /** How long the module's containers may take to report healthy. */
  moduleHealthTimeoutMs: number;
  pollMs: number;
  commandTimeoutMs: number;
}

export interface ModuleDeps {
  installDir: string;
  docker: Runner;
  app: AppProbe;
  config: ModuleConfig;
  /** The signed manifest of the release this install runs, verified. */
  release: VerifiedRelease;
  /** linux/amd64, linux/arm64: which digest of each image is pulled. */
  platform: string;
  save: (run: ModuleRun) => Promise<void>;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  statfs?: (path: string) => Promise<StatfsLike>;
  layers?: (ref: string, signal?: AbortSignal) => Promise<Layer[]>;
  /** A new secret (tests make it predictable). */
  secret?: () => string;
}

class StepFailed extends Error {}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function tail(text: string, lines = 6): string {
  return text.trim().split('\n').slice(-lines).join(' | ');
}

export function newModuleRun(id: string, entry: ModuleEntry, action: 'enable' | 'disable', version: string, deleteData: boolean, now: Date): ModuleRun {
  const labels = MODULE_STEP_LABELS[action];
  return {
    id,
    kind: 'module',
    module: entry.id,
    moduleName: entry.name,
    action,
    deleteData: action === 'disable' && deleteData,
    version,
    status: 'running',
    startedAt: now.toISOString(),
    finishedAt: null,
    steps: (action === 'enable' ? ENABLE : DISABLE).map((s): ModuleStep => ({ id: s, label: labels[s]!, status: 'pending', startedAt: null, finishedAt: null })),
    log: [],
    reason: null,
  };
}

// -- .env and compose helpers ---------------------------------------------------

export function profilesOf(env: string): string[] {
  return (envGet(env, 'COMPOSE_PROFILES') ?? '').split(',').map((p) => p.trim()).filter(Boolean);
}

export function isOn(env: string, entry: ModuleEntry): boolean {
  return profilesOf(env).includes(entry.profile);
}

function separator(env: string): string {
  return envGet(env, 'COMPOSE_PATH_SEPARATOR') || ':';
}

export function moduleComposeFile(entry: ModuleEntry): string {
  return `${MODULES_DIR}/${entry.id}.yml`;
}

/** COMPOSE_FILE with the module's file added or taken out. Unset means compose.yml alone. */
export function withComposeFile(env: string, file: string, add: boolean): string {
  const sep = separator(env);
  const current = (envGet(env, 'COMPOSE_FILE') ?? '').split(sep).map((f) => f.trim()).filter(Boolean);
  const files = current.length ? current : ['compose.yml'];
  const next = add ? (files.includes(file) ? files : [...files, file]) : files.filter((f) => f !== file);
  return envSet(env, 'COMPOSE_FILE', next.join(sep));
}

/**
 * modules/<id>.yml for a module compose.yml does not carry: its services from
 * the catalogue, each image pinned to this computer's digest. JSON, which
 * compose reads as YAML.
 */
export function renderModuleCompose(manifest: ReleaseManifest, entry: ModuleEntry, platform: string): string {
  if (!entry.compose) throw new Error(`${entry.id} has no compose file of its own`);
  const services: Record<string, Record<string, unknown>> = {};
  for (const s of entry.services) {
    services[s.name] = { image: pinnedRef(manifest, s.image, platform), ...(entry.compose.services[s.name] ?? { profiles: [entry.profile] }) };
  }
  const doc: Record<string, unknown> = { services };
  if (entry.compose.volumes) doc['volumes'] = entry.compose.volumes;
  return `# Written by the tagave updater for the module "${entry.id}" of tagave ${manifest.version}, from its signed\n# release manifest. Turning the module off takes it out of COMPOSE_FILE again.\n${JSON.stringify(doc, null, 2)}\n`;
}

/** The module's own image pins in .env differ from the release's (an update changed them; a restart picks them up). */
function pinsDiffer(env: string, manifest: ReleaseManifest, entry: ModuleEntry, platform: string): boolean {
  for (const name of moduleImages(entry)) {
    const img = manifest.images[name];
    if (!img?.env) continue;
    const want = img.platforms[platform];
    if (want && envGet(env, img.env) !== want) return true;
  }
  return false;
}

/** The status of every module in the catalogue, for Settings › Modules. */
export async function moduleStatuses(opts: {
  installDir: string;
  release: VerifiedRelease;
  platform: string;
  run: ModuleRun | null;
  active: boolean;
}): Promise<ModuleStatus[]> {
  const env = (await readText(join(opts.installDir, '.env'))) ?? '';
  const role = envGet(env, 'TAGAVE_ROLE') || 'all';
  const { manifest } = opts.release;
  const out: ModuleStatus[] = [];
  for (const entry of manifest.modules) {
    const on = isOn(env, entry);
    let state: ModuleState = on ? 'on' : 'off';
    const run = opts.run?.module === entry.id ? opts.run : null;
    if (run && opts.active && run.status === 'running') state = run.action === 'enable' ? 'installing' : 'removing';
    else if (!on && run && run.action === 'enable' && run.status !== 'succeeded') state = 'failed';
    else if (on && entry.compose) {
      const file = await readText(join(opts.installDir, moduleComposeFile(entry)));
      let rendered: string | null = null;
      try {
        rendered = renderModuleCompose(manifest, entry, opts.platform);
      } catch {
        /* no image for this platform: leave it on */
      }
      if (rendered !== null && file !== rendered) state = 'update_pending';
    } else if (on && pinsDiffer(env, manifest, entry, opts.platform)) {
      state = 'update_pending';
    }
    let reason: string | null = null;
    if (role === 'files') reason = 'This computer runs only the file worker; turn modules on on the app computer.';
    else if (!entry.roles.includes(role as 'all' | 'app')) reason = `${entry.name} needs everything on one computer; this is the app computer of a split install.`;
    else if ((compareReleases(manifest.version, entry.minVersion) ?? 0) < 0) reason = `${entry.name} needs tagave ${entry.minVersion} or newer.`;
    else {
      try {
        for (const img of moduleImages(entry)) digestFor(manifest, img, opts.platform);
      } catch (err) {
        reason = (err as Error).message;
      }
    }
    out.push({
      id: entry.id,
      name: entry.name,
      purpose: entry.purpose,
      state,
      estimate: entry.estimate,
      keepsOnRemoval: entry.keepsOnRemoval,
      roles: entry.roles,
      downloadBytes: null,
      available: reason === null || on,
      reason: on ? null : reason,
      lastError: state === 'failed' ? run?.reason ?? null : null,
    });
  }
  return out;
}

// -- the operation ------------------------------------------------------------------

export class ModuleOperation {
  readonly run: ModuleRun;
  private readonly entry: ModuleEntry;
  private readonly manifest: ReleaseManifest;
  private readonly now: () => Date;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly envPath: string;
  private originalEnv: string | null = null;
  /** The module's compose file before this run: text, or null when there was none. */
  private originalCompose: string | null | undefined = undefined;
  private changed = false;
  private stopped = false;
  private saving: Promise<void> = Promise.resolve();

  constructor(private readonly deps: ModuleDeps, run: ModuleRun) {
    this.run = run;
    this.manifest = deps.release.manifest;
    const entry = this.manifest.modules.find((m) => m.id === run.module);
    if (!entry) throw new Error(`${run.module} is not in the ${this.manifest.version} catalogue`);
    this.entry = entry;
    this.now = deps.now ?? (() => new Date());
    this.sleep = deps.sleep ?? realSleep;
    this.envPath = join(deps.installDir, '.env');
  }

  // -- bookkeeping ---------------------------------------------------------------

  private persist(): Promise<void> {
    const snapshot = structuredClone(this.run);
    this.saving = this.saving.then(() => this.deps.save(snapshot)).catch(() => undefined);
    return this.saving;
  }

  private log(level: UpdateLogLine['level'], message: string): void {
    this.run.log.push({ at: this.now().toISOString(), level, message: redact(message) });
    if (this.run.log.length > MAX_LOG_LINES) this.run.log.splice(0, this.run.log.length - MAX_LOG_LINES);
    void this.persist();
  }

  private step(id: ModuleStepId): ModuleStep {
    return this.run.steps.find((s) => s.id === id)!;
  }

  private begin(id: ModuleStepId): void {
    const s = this.step(id);
    s.status = 'running';
    s.startedAt = this.now().toISOString();
    this.log('info', s.label);
  }

  private end(id: ModuleStepId, status: 'done' | 'failed' | 'skipped'): void {
    const s = this.step(id);
    s.status = status;
    s.finishedAt = this.now().toISOString();
    void this.persist();
  }

  private fail(message: string): never {
    throw new StepFailed(message);
  }

  private async docker(args: string[], opts: { timeoutMs?: number; quiet?: boolean } = {}): Promise<CommandResult> {
    if (!opts.quiet) this.log('info', `$ docker ${args.join(' ')}`);
    const res = await this.deps.docker(args, { timeoutMs: opts.timeoutMs ?? this.deps.config.commandTimeoutMs });
    if (res.code !== 0 && !opts.quiet) this.log('warn', `exit ${res.code}: ${tail(res.stderr || res.stdout)}`);
    return res;
  }

  /** docker compose with the module's profile on, so its services are known whatever .env says. */
  private compose(args: string[], opts: { timeoutMs?: number; quiet?: boolean } = {}): Promise<CommandResult> {
    return this.docker(['compose', '--profile', this.entry.profile, ...args], opts);
  }

  private services(): string[] {
    return this.entry.services.map((s) => s.name);
  }

  private async readEnv(): Promise<string> {
    const env = await readText(this.envPath);
    if (env === null) this.fail(`there is no .env in ${this.deps.installDir}`);
    return env;
  }

  // -- waiting -------------------------------------------------------------------

  private async waitFor(check: () => Promise<string | null>, timeoutMs: number): Promise<string | null> {
    const deadline = this.now().getTime() + timeoutMs;
    let lastLogged = '';
    for (;;) {
      const last = await check();
      if (last === null) return null;
      if (last !== lastLogged) {
        this.log('info', `waiting: ${last}`);
        lastLogged = last;
      }
      if (this.now().getTime() >= deadline) return last;
      await this.sleep(this.deps.config.pollMs);
    }
  }

  /** null when every service of the module runs (and reports healthy, when it has a health check). */
  private async servicesHealth(): Promise<string | null> {
    for (const name of this.services()) {
      const ps = await this.compose(['ps', '-q', name], { quiet: true, timeoutMs: 30_000 });
      const id = ps.stdout.trim().split('\n')[0]?.trim();
      if (ps.code !== 0 || !id) return `${name} is not running`;
      const res = await this.docker(['inspect', '--format', '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}', id], { quiet: true, timeoutMs: 30_000 });
      const state = res.stdout.trim();
      if (res.code !== 0) return `${name}: docker inspect failed`;
      if (state !== 'healthy' && state !== 'running') return `${name} reports ${state || 'nothing'}`;
    }
    return null;
  }

  private async appHealthy(): Promise<string | null> {
    const h = await this.deps.app.health();
    return h.ok ? null : h.detail;
  }

  private async restartDependents(): Promise<void> {
    const restarts = this.entry.restarts.filter((s) => s !== 'updater');
    if (restarts.length === 0) return;
    const up = await this.docker(['compose', 'up', '-d', ...restarts]);
    if (up.code !== 0) this.fail(`docker compose could not restart ${restarts.join(', ')}: ${tail(up.stderr, 3)}`);
    if (restarts.includes('app')) {
      this.log('info', 'waiting for the app to answer again with the new settings');
      const issue = await this.waitFor(() => this.appHealthy(), this.deps.config.healthTimeoutMs);
      if (issue) this.fail(`the app did not answer healthy after the restart: ${issue}`);
    }
  }

  // -- turn on -----------------------------------------------------------------------

  private async enablePreflight(): Promise<void> {
    const env = await this.readEnv();
    this.originalEnv = env;
    const role = envGet(env, 'TAGAVE_ROLE') || 'all';
    if (role === 'files') this.fail('this computer runs only the file worker; turn modules on on the app computer');
    if (!this.entry.roles.includes(role as 'all' | 'app')) {
      this.fail(`${this.entry.name} needs everything on one computer (install role all); this is the ${role} computer of a split install`);
    }
    const running = envGet(env, 'TAGAVE_VERSION');
    if (running !== this.manifest.version) this.fail(`this install runs ${running ?? 'no release'}, but the catalogue is that of ${this.manifest.version}`);
    if ((compareReleases(this.manifest.version, this.entry.minVersion) ?? 0) < 0) this.fail(`${this.entry.name} needs tagave ${this.entry.minVersion} or newer`);
    if (isOn(env, this.entry)) this.fail(`${this.entry.name} is on already`);
    this.log('info', `${this.entry.id} from the signed catalogue of ${this.manifest.version} (key ${this.deps.release.keyId}); images for ${this.deps.platform}`);

    // Ports: the one in .env wins; none may clash with the app's or another one's.
    const taken = new Map<string, string>([[envGet(env, 'TAGAVE_PORT') || '3100', 'the web app (TAGAVE_PORT)']]);
    for (const other of this.manifest.modules) {
      if (other.id === this.entry.id || !isOn(env, other)) continue;
      for (const s of other.settings) if (s.kind === 'port') taken.set(envGet(env, s.key) || String(s.default), `${other.name} (${s.key})`);
    }
    for (const s of this.entry.settings) {
      if (s.kind !== 'port') continue;
      const port = envGet(env, s.key) || String(s.default);
      const owner = taken.get(port);
      if (owner) this.fail(`${this.entry.name} wants port ${port} (${s.key}), which ${owner} uses; set another ${s.key} in .env`);
    }

    if (!this.entry.compose) {
      const svc = await this.compose(['config', '--services'], { quiet: true, timeoutMs: 60_000 });
      if (svc.code !== 0) this.fail(`docker compose cannot read the configuration: ${tail(svc.stderr)}`);
      const known = svc.stdout.split('\n').map((s) => s.trim());
      const missing = this.services().filter((s) => !known.includes(s));
      if (missing.length) this.fail(`the compose files here have no ${missing.join(', ')} service; they come from an older release than the catalogue`);
    }
    if (envGet(env, `${this.entry.id.toUpperCase().replace(/-/g, '_')}_IMAGE`) || envGet(env, `TAGAVE_${this.entry.id.toUpperCase().replace(/-/g, '_')}_IMAGE`)) {
      this.fail(`.env overrides the ${this.entry.name} image; remove that line, tagave installs only the image its release pins`);
    }

    const refs = moduleImages(this.entry).map((img) => pinnedRef(this.manifest, img, this.deps.platform));
    const space = await checkSpace(
      {
        docker: (args, opts) => this.docker(args, { ...opts, quiet: true }),
        statfs: this.deps.statfs ?? statfs,
        layers: this.deps.layers ?? registryClient(fetch),
        log: (level, message) => this.log(level, message),
      },
      { target: this.manifest.version, imageCount: refs.length, dockerHeadroom: this.deps.config.minFreeBytes, images: refs, what: `turning on ${this.entry.name}` },
    );
    if (space.problem) this.fail(space.problem);

    for (const img of moduleImages(this.entry)) await pullVerified(this.deps.docker, this.manifest, img, this.deps.platform, (l, m) => this.log(l, m), this.deps.config.commandTimeoutMs);
  }

  private async enableConfig(): Promise<void> {
    let env = this.originalEnv!;
    const file = moduleComposeFile(this.entry);
    const composePath = join(this.deps.installDir, file);
    this.changed = true;
    const generated: string[] = [];
    for (const s of this.entry.settings) {
      if (s.kind === 'secret') {
        if (envGet(env, s.key)) continue;
        env = envSet(env, s.key, (this.deps.secret ?? (() => randomBytes(32).toString('hex')))());
        generated.push(s.key);
      } else if (s.kind === 'value') {
        env = envSet(env, s.key, s.value);
      } else if (!envGet(env, s.key)) {
        env = envSet(env, s.key, String(s.default));
      }
    }
    if (generated.length) this.log('info', `generated ${generated.join(', ')} (kept in .env only)`);
    for (const img of moduleImages(this.entry)) {
      const i = this.manifest.images[img]!;
      if (i.env) env = envSet(env, i.env, digestFor(this.manifest, img, this.deps.platform));
    }
    env = envSet(env, 'COMPOSE_PROFILES', [...profilesOf(env), this.entry.profile].join(','));
    if (this.entry.compose) {
      this.originalCompose = await readText(composePath);
      await mkdirKeepingOwner(join(this.deps.installDir, MODULES_DIR), 0o755);
      await writeFileKeepingOwner(composePath, renderModuleCompose(this.manifest, this.entry, this.deps.platform), { fallbackMode: 0o644 });
      env = withComposeFile(env, file, true);
      this.log('info', `${file} written (its images pinned by digest) and added to COMPOSE_FILE`);
    }
    await writeFileAtomic(this.envPath, env);
    this.log('info', `COMPOSE_PROFILES=${envGet(env, 'COMPOSE_PROFILES')} and the settings of ${this.entry.id} in .env (old file kept as .env.bak)`);
    const check = await this.docker(['compose', 'config', '--quiet'], { timeoutMs: 60_000 });
    if (check.code !== 0) this.fail(`docker compose rejects the configuration with ${this.entry.name}: ${tail(check.stderr, 3)}`);
    await this.checkPinned();
  }

  /** Every service of the module runs exactly the image the manifest pins. */
  private async checkPinned(): Promise<void> {
    const res = await this.docker(['compose', 'config', '--format', 'json'], { quiet: true, timeoutMs: 60_000 });
    let services: Record<string, { image?: string }> = {};
    try {
      services = (JSON.parse(res.stdout) as { services?: Record<string, { image?: string }> }).services ?? {};
    } catch {
      this.fail('docker compose did not print the configuration');
    }
    for (const s of this.entry.services) {
      const image = services[s.name]?.image ?? '';
      const want = digestFor(this.manifest, s.image, this.deps.platform);
      if (!image.endsWith(`@${want}`)) {
        this.fail(`the service ${s.name} would run ${image || 'no image'}, not the image the release pins (${this.manifest.images[s.image]!.ref}@${want})`);
      }
    }
  }

  private async enableStart(): Promise<void> {
    this.stopped = false;
    const up = await this.docker(['compose', 'up', '-d', ...this.services()]);
    if (up.code !== 0) this.fail(`docker compose could not start ${this.entry.name}: ${tail(up.stderr, 3)}`);
    await this.restartDependents();
  }

  private async enableVerify(): Promise<void> {
    const issue = await this.waitFor(() => this.servicesHealth(), this.deps.config.moduleHealthTimeoutMs);
    if (issue) this.fail(`${this.entry.name} did not report healthy within ${Math.round(this.deps.config.moduleHealthTimeoutMs / 1000)} s: ${issue}`);
    const app = await this.waitFor(() => this.appHealthy(), this.deps.config.healthTimeoutMs);
    if (app) this.fail(`the app is not healthy with ${this.entry.name} on: ${app}`);
    this.log('info', `${this.entry.name} runs and reports healthy`);
  }

  // -- turn off ----------------------------------------------------------------------

  private async disablePreflight(): Promise<void> {
    const env = await this.readEnv();
    this.originalEnv = env;
    if (!isOn(env, this.entry)) this.fail(`${this.entry.name} is not on`);
  }

  private async disableStop(): Promise<void> {
    this.changed = true;
    this.stopped = true;
    const rm = await this.compose(['rm', '--stop', '--force', ...this.services()]);
    if (rm.code !== 0) this.fail(`could not stop ${this.entry.name}: ${tail(rm.stderr, 3)}`);
  }

  private async disableConfig(): Promise<void> {
    let env = this.originalEnv!;
    env = envSet(env, 'COMPOSE_PROFILES', profilesOf(env).filter((p) => p !== this.entry.profile).join(','));
    const cleared: string[] = [];
    for (const s of this.entry.settings) {
      if (s.kind === 'value' && s.clearOnDisable && envGet(env, s.key)) {
        env = envSet(env, s.key, '');
        cleared.push(s.key);
      }
    }
    if (this.entry.compose) {
      const file = moduleComposeFile(this.entry);
      this.originalCompose = await readText(join(this.deps.installDir, file));
      env = withComposeFile(env, file, false);
    }
    await writeFileAtomic(this.envPath, env);
    const kept = this.entry.settings.filter((s) => s.kind === 'secret').map((s) => s.key);
    this.log('info', `COMPOSE_PROFILES=${envGet(env, 'COMPOSE_PROFILES')}${cleared.length ? `; cleared ${cleared.join(', ')}` : ''}${kept.length ? `; kept ${kept.join(', ')} so turning it on again opens the same data` : ''} (old file kept as .env.bak)`);
    if (this.entry.compose && this.originalCompose !== null) {
      await unlink(join(this.deps.installDir, moduleComposeFile(this.entry))).catch(() => undefined);
    }
    const check = await this.docker(['compose', 'config', '--quiet'], { timeoutMs: 60_000 });
    if (check.code !== 0) this.fail(`docker compose rejects the configuration without ${this.entry.name}: ${tail(check.stderr, 3)}`);
  }

  private async disableVerify(): Promise<void> {
    await this.restartDependents();
    const app = await this.waitFor(() => this.appHealthy(), this.deps.config.healthTimeoutMs);
    if (app) this.fail(`the app is not healthy without ${this.entry.name}: ${app}`);
  }

  /** The module's volumes, by the labels compose puts on them. */
  private async volumeNames(): Promise<string[]> {
    const project = envGet(this.originalEnv ?? '', 'COMPOSE_PROJECT_NAME') || 'tagave';
    const names: string[] = [];
    for (const vol of this.entry.volumes) {
      const res = await this.docker(['volume', 'ls', '-q', '--filter', `label=com.docker.compose.project=${project}`, '--filter', `label=com.docker.compose.volume=${vol}`], { quiet: true, timeoutMs: 30_000 });
      names.push(...res.stdout.split('\n').map((l) => l.trim()).filter(Boolean));
    }
    return names;
  }

  /** Never rolled back; a failure here leaves the module off and says what is left. */
  private async disableData(): Promise<void> {
    const volumes = await this.volumeNames();
    if (!this.run.deleteData) {
      this.end('data', 'skipped');
      this.log('info', volumes.length ? `kept its data: ${volumes.join(', ')} (${this.entry.keepsOnRemoval})` : 'it has no data to keep');
      return;
    }
    this.begin('data');
    const failed: string[] = [];
    for (const v of volumes) {
      const res = await this.docker(['volume', 'rm', v], { timeoutMs: 60_000 });
      if (res.code !== 0) failed.push(`${v} (${tail(res.stderr, 1)})`);
    }
    if (failed.length) {
      this.end('data', 'failed');
      this.run.reason = redact(`${this.entry.name} is off, but deleting its data failed: ${failed.join(', ')}. Delete it with docker volume rm.`);
      this.log('warn', this.run.reason);
      return;
    }
    this.end('data', 'done');
    this.log('info', volumes.length ? `deleted ${volumes.join(', ')}` : 'it had no data');
  }

  // -- roll back ---------------------------------------------------------------------

  private async rollback(reason: string): Promise<void> {
    this.begin('rollback');
    try {
      if (this.run.action === 'enable') {
        const rm = await this.compose(['rm', '--stop', '--force', ...this.services()]);
        if (rm.code !== 0) throw new Error(`could not remove the ${this.entry.name} containers`);
      }
      if (this.originalEnv !== null) await writeFileAtomic(this.envPath, this.originalEnv, false);
      if (this.entry.compose && this.originalCompose !== undefined) {
        const path = join(this.deps.installDir, moduleComposeFile(this.entry));
        if (this.originalCompose === null) await unlink(path).catch(() => undefined);
        else await writeFileKeepingOwner(path, this.originalCompose, { fallbackMode: 0o644 });
      }
      this.log('info', 'put back .env as it was');
      if (this.run.action === 'disable' && this.stopped) {
        const up = await this.docker(['compose', 'up', '-d', ...this.services()]);
        if (up.code !== 0) throw new Error(`${this.entry.name} did not start again: ${tail(up.stderr, 3)}`);
      }
      const restarts = this.entry.restarts.filter((s) => s !== 'updater');
      if (restarts.length) {
        const up = await this.docker(['compose', 'up', '-d', ...restarts]);
        if (up.code !== 0) throw new Error(`docker compose could not restart ${restarts.join(', ')}: ${tail(up.stderr, 3)}`);
      }
      const issue = await this.waitFor(() => this.appHealthy(), this.deps.config.healthTimeoutMs);
      if (issue) throw new Error(`the app did not answer healthy: ${issue}`);
      this.end('rollback', 'done');
      this.run.status = 'rolled_back';
      this.run.reason = redact(reason);
      this.log('warn', `rolled back: ${this.entry.name} is ${this.run.action === 'enable' ? 'off' : 'on'} as before`);
    } catch (err) {
      this.end('rollback', 'failed');
      this.run.status = 'rollback_failed';
      this.run.reason = redact(`${reason}. The roll back did not finish: ${(err as Error).message}`);
      this.log('error', `roll back failed: ${(err as Error).message}`);
      this.log('error', `by hand, in the install folder: put .env.bak back as .env if COMPOSE_PROFILES ${this.run.action === 'enable' ? 'lists' : 'lacks'} ${this.entry.profile}, then docker compose up -d --remove-orphans`);
    }
  }

  // -- driver -----------------------------------------------------------------------

  async execute(): Promise<ModuleRun> {
    const plan: Array<[ModuleStepId, () => Promise<void>]> = this.run.action === 'enable'
      ? [['preflight', () => this.enablePreflight()], ['config', () => this.enableConfig()], ['start', () => this.enableStart()], ['verify', () => this.enableVerify()]]
      : [['preflight', () => this.disablePreflight()], ['stop', () => this.disableStop()], ['config', () => this.disableConfig()], ['verify', () => this.disableVerify()]];
    let current: ModuleStepId = 'preflight';
    try {
      for (const [id, fn] of plan) {
        current = id;
        this.begin(id);
        await fn();
        this.end(id, 'done');
      }
      this.end('rollback', 'skipped');
      this.run.status = 'succeeded';
      if (this.run.action === 'disable') await this.disableData();
      this.log('info', this.run.action === 'enable' ? `${this.entry.name} is on` : `${this.entry.name} is off`);
    } catch (err) {
      const reason = err instanceof StepFailed || err instanceof ReleaseRefused ? err.message : `unexpected error: ${(err as Error).message}`;
      this.end(current, 'failed');
      this.log('error', reason);
      for (const s of this.run.steps) if (s.status === 'pending' && s.id !== 'rollback') s.status = 'skipped';
      if (this.changed) {
        await this.rollback(reason);
      } else {
        this.end('rollback', 'skipped');
        this.run.status = 'failed';
        this.run.reason = redact(`${reason}. Nothing was changed.`);
      }
    }
    this.run.finishedAt = this.now().toISOString();
    await this.persist();
    return this.run;
  }
}

// -- pulling by digest ------------------------------------------------------------------

/** `docker pull` of `ref@digest`, then the pulled image's digest checked; tagged `ref` so old-image cleanup finds it. */
export async function pullVerified(
  docker: Runner,
  manifest: ReleaseManifest,
  image: string,
  platform: string,
  log: (level: 'info' | 'warn', message: string) => void,
  timeoutMs: number,
  registry?: string | null,
  /** Each piece of docker pull's output as it comes (update.ts turns it into download progress). */
  onOutput?: (chunk: string) => void,
): Promise<void> {
  const img = manifest.images[image];
  if (!img) throw new ReleaseRefused('format', `the ${manifest.version} manifest does not pin the image ${image}`);
  const digest = digestFor(manifest, image, platform);
  const ref = withRegistry(img.ref, registry);
  const pinned = `${ref}@${digest}`;
  log('info', `$ docker pull ${pinned}`);
  const pull = await docker(['pull', pinned], { timeoutMs, ...(onOutput ? { onOutput } : {}) });
  if (pull.code !== 0) {
    const text = `${pull.stderr}\n${pull.stdout}`;
    if (/not found|manifest unknown|does not exist/i.test(text)) throw new ReleaseRefused('digest', `${pinned} is not in its registry: the registry does not hold the image the release pins`);
    throw new Error(`downloading ${pinned} failed: ${tail(text, 3)}`);
  }
  await checkPulledDigest(docker, ref, digest);
  const tag = await docker(['tag', pinned, ref], { timeoutMs: 30_000 });
  if (tag.code !== 0) log('warn', `could not tag ${pinned} as ${ref}: ${tail(tag.stderr, 1)}`);
}

/** The image here that `repo@digest` names really is that digest, by Docker's own record. */
export async function checkPulledDigest(docker: Runner, ref: string, digest: string): Promise<void> {
  const repo = normalizeRepository(ref.replace(/:[^/:@]+$/, ''));
  const res = await docker(['image', 'inspect', '--format', '{{json .RepoDigests}}', `${ref}@${digest}`], { timeoutMs: 30_000 });
  let digests: string[] = [];
  try {
    digests = res.code === 0 ? (JSON.parse(res.stdout.trim()) as string[]) : [];
  } catch {
    digests = [];
  }
  const mine = digests.filter((d) => normalizeRepository(d.split('@')[0] ?? '') === repo).map((d) => d.split('@')[1]);
  if (!mine.includes(digest)) {
    throw new ReleaseRefused('digest', `the image pulled for ${ref} is ${mine[0] ?? 'not recorded'}, not ${digest} as the signed manifest pins; nothing was changed`);
  }
}

/** A tagave image under another registry (TAGAVE_REGISTRY): same digest, other host. */
export function withRegistry(ref: string, registry?: string | null): string {
  const r = registry?.replace(/\/$/, '');
  if (!r) return ref;
  const name = ref.slice(ref.lastIndexOf('/') + 1);
  return name.startsWith('tagave-') ? `${r}/${name}` : ref;
}
