/**
 * Music folder self-heal. 2026-11 a host rebooted and the NFS share behind
 * MUSIC_DIR (in the host's /etc/fstab) timed out at boot: the containers
 * ran on an empty bind for hours. The scan guard (LIB-5) refused to mark
 * anything missing, and now the updater mounts it again.
 *
 * Every minute it asks the app (signed) whether the music looks unmounted:
 * the latest scan of a root was stopped by the LIB-5 guard, the same answer
 * the owner's notice reads (db › musicFolder.ts). If so, at most once per
 * 10 minutes, longer after failures in a row, it runs a short-lived helper
 * from its own image (busybox nsenter; nothing is pulled) with
 * --privileged --pid=host that enters the host's namespaces and:
 *
 *   1. systemd-escape -p --suffix=mount <MUSIC_DIR>  the mount unit (no systemd: stop)
 *   2. systemctl show --property=SourcePath --value <unit>   it must come from /etc/fstab (else stop)
 *   3. systemctl start <unit>
 *   4. mountpoint -q <MUSIC_DIR>, and something in it
 *   5. restarts only this install's containers that bind MUSIC_DIR
 *      (worker-files, app, player), found by the compose project label
 *
 * Every argv is fixed; MUSIC_DIR comes only from the install's .env (what
 * compose binds), never from the database or a request. It never unmounts,
 * edits fstab, or touches another path or container. Each attempt is
 * reported to the app (an audit entry; a fixed reason code, never host
 * text). TAGAVE_MUSIC_SELF_HEAL=0 in .env turns it off.
 */
import { hostname } from 'node:os';
import { posix } from 'node:path';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { envGet } from './envFile.js';
import type { Runner } from './runner.js';
import { signRequest } from './token.js';

export const HEAL_REASONS = ['mounted', 'no_systemd', 'not_in_fstab', 'mount_failed', 'still_empty', 'restart_failed', 'docker_failed'] as const;
export type HealReason = (typeof HEAL_REASONS)[number];
export type HealReport = { phase: 'start' } | { phase: 'done'; ok: boolean; reason: HealReason };

/** The services of tagave's own that may bind the music; any other container is never touched. */
export const MUSIC_SERVICES = ['worker-files', 'app', 'player'] as const;
export const HELPER_NAME = 'tagave-music-heal';
export const COMPOSE_PROJECT_LABEL = 'com.docker.compose.project';
export const COMPOSE_SERVICE_LABEL = 'com.docker.compose.service';

export interface HealConfig {
  /** how often the app is asked */
  checkMs: number;
  /** the least time between two attempts */
  minGapMs: number;
  /** the most, after failures in a row */
  maxGapMs: number;
}

export const DEFAULT_HEAL_CONFIG: HealConfig = { checkMs: 60_000, minGapMs: 10 * 60_000, maxGapMs: 6 * 60 * 60_000 };

/** MUSIC_DIR from the install's .env, only as a plain absolute path (what compose binds). */
export function musicDirOf(envText: string): string | null {
  const raw = envGet(envText, 'MUSIC_DIR');
  if (!raw || !raw.startsWith('/') || raw === '/' || /[\0-\x1f\x7f]/.test(raw)) return null;
  const normal = posix.normalize(raw).replace(/\/+$/, '');
  return normal === raw.replace(/\/+$/, '') && normal !== '' && normal !== '/' ? normal : null;
}

/** On unless TAGAVE_MUSIC_SELF_HEAL is 0, false, off or no. */
export function selfHealOn(envText: string): boolean {
  const v = envGet(envText, 'TAGAVE_MUSIC_SELF_HEAL')?.trim().toLowerCase();
  return !(v === '0' || v === 'false' || v === 'off' || v === 'no');
}

/** Wait after an attempt: the minimum, doubled for each failure in a row, capped. */
export function gapAfter(failures: number, cfg: Pick<HealConfig, 'minGapMs' | 'maxGapMs'>): number {
  return Math.min(cfg.minGapMs * 2 ** Math.max(0, failures - 1), cfg.maxGapMs);
}

export type HealDecision = { go: true } | { go: false; why: 'off' | 'no_music_dir' | 'not_unmounted' | 'unknown' | 'busy' | 'waiting' };

export function healDecision(input: {
  on: boolean;
  musicDir: string | null;
  /** from the app; null when it did not answer */
  unmounted: boolean | null;
  /** an update or a module run is moving containers */
  busy: boolean;
  now: number;
  last: { at: number; failures: number } | null;
  cfg: Pick<HealConfig, 'minGapMs' | 'maxGapMs'>;
}): HealDecision {
  if (!input.on) return { go: false, why: 'off' };
  if (!input.musicDir) return { go: false, why: 'no_music_dir' };
  if (input.unmounted === null) return { go: false, why: 'unknown' };
  if (!input.unmounted) return { go: false, why: 'not_unmounted' };
  if (input.busy) return { go: false, why: 'busy' };
  if (input.last && input.now - input.last.at < gapAfter(input.last.failures, input.cfg)) return { go: false, why: 'waiting' };
  return { go: true };
}

/** `docker run` of the helper: its own image, nsenter into PID 1's namespaces, one fixed command. */
export function helperArgs(image: string, command: readonly string[]): string[] {
  return ['run', '--rm', '--privileged', '--pid=host', '--name', HELPER_NAME, '--entrypoint', 'nsenter', image, '-t', '1', '-m', '-u', '-n', '-i', '--', ...command];
}

/** The commands the helper runs on the host, each a fixed argv around MUSIC_DIR or its unit. */
export const hostCommand = {
  escape: (dir: string) => ['systemd-escape', '-p', '--suffix=mount', dir],
  source: (unit: string) => ['systemctl', 'show', '--property=SourcePath', '--value', unit],
  start: (unit: string) => ['systemctl', 'start', unit],
  mounted: (dir: string) => ['mountpoint', '-q', dir],
  firstEntry: (dir: string) => ['find', dir, '-mindepth', '1', '-maxdepth', '1', '-print', '-quit'],
};

const UNIT_RE = /^[A-Za-z0-9:_.\\-]+\.mount$/;

/** What the app is asked and told. */
export interface MusicApp {
  unmounted(): Promise<boolean | null>;
  report(r: HealReport): Promise<void>;
}

export function httpMusicApp(baseUrl: string, appSecret: string): MusicApp {
  const base = baseUrl.replace(/\/$/, '');
  return {
    async unmounted() {
      const path = '/api/v1/internal/updater/music';
      try {
        const res = await fetch(`${base}${path}`, { headers: signRequest(appSecret, 'GET', path), signal: AbortSignal.timeout(5000) });
        if (!res.ok) return null;
        const body = (await res.json()) as { unmounted?: unknown };
        return typeof body.unmounted === 'boolean' ? body.unmounted : null;
      } catch {
        return null;
      }
    },
    async report(r) {
      const path = '/api/v1/internal/updater/music-heal';
      const text = JSON.stringify(r);
      try {
        await fetch(`${base}${path}`, { method: 'POST', headers: { ...signRequest(appSecret, 'POST', path, text), 'content-type': 'application/json' }, body: text, signal: AbortSignal.timeout(5000) });
      } catch {
        /* the next attempt reports again */
      }
    },
  };
}

export interface HealerDeps {
  installDir: string;
  docker: Runner;
  app: MusicApp;
  busy: () => boolean;
  now?: () => number;
  /** this container's id (its hostname by default) */
  self?: string;
  config?: Partial<HealConfig>;
  log?: (msg: Record<string, unknown>) => void;
}

export class MusicHealer {
  private last: { at: number; failures: number } | null = null;
  private running = false;
  private timer: NodeJS.Timeout | null = null;
  private readonly cfg: HealConfig;
  private readonly now: () => number;

  constructor(private readonly deps: HealerDeps) {
    this.cfg = { ...DEFAULT_HEAL_CONFIG, ...deps.config };
    this.now = deps.now ?? Date.now;
  }

  start(): void {
    this.timer = setInterval(() => void this.tick(), this.cfg.checkMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** One check; an attempt when the decision says so. Returns how the attempt ended, or null. */
  async tick(): Promise<HealReason | null> {
    if (this.running) return null;
    this.running = true;
    try {
      const env = await readFile(join(this.deps.installDir, '.env'), 'utf8').catch(() => '');
      const musicDir = musicDirOf(env);
      const on = selfHealOn(env);
      const unmounted = on && musicDir ? await this.deps.app.unmounted() : false;
      const decision = healDecision({ on, musicDir, unmounted, busy: this.deps.busy(), now: this.now(), last: this.last, cfg: this.cfg });
      if (!decision.go) return null;
      const project = envGet(env, 'COMPOSE_PROJECT_NAME') || 'tagave';
      const reason = await this.attempt(musicDir!, project);
      const ok = reason === 'mounted';
      this.last = { at: this.now(), failures: ok ? 0 : (this.last?.failures ?? 0) + 1 };
      await this.deps.app.report({ phase: 'done', ok, reason });
      this.deps.log?.({ msg: 'music folder self-heal', ok, reason });
      return reason;
    } finally {
      this.running = false;
    }
  }

  private async host(image: string, command: readonly string[]) {
    return this.deps.docker(helperArgs(image, command), { timeoutMs: 120_000 });
  }

  private async attempt(dir: string, project: string): Promise<HealReason> {
    const d = this.deps.docker;
    const me = await d(['inspect', '--format', '{{.Image}}', this.deps.self ?? hostname()], { timeoutMs: 30_000 });
    const image = me.stdout.trim();
    if (me.code !== 0 || !/^sha256:[0-9a-f]{64}$/.test(image)) return 'docker_failed';

    const escaped = await this.host(image, hostCommand.escape(dir));
    const unit = escaped.stdout.trim();
    if (escaped.code !== 0 || !UNIT_RE.test(unit)) return 'no_systemd';
    const source = await this.host(image, hostCommand.source(unit));
    if (source.code !== 0) return 'no_systemd';
    if (source.stdout.trim() !== '/etc/fstab') return 'not_in_fstab';

    await this.deps.app.report({ phase: 'start' });
    if ((await this.host(image, hostCommand.start(unit))).code !== 0) return 'mount_failed';
    if ((await this.host(image, hostCommand.mounted(dir))).code !== 0) return 'mount_failed';
    const first = await this.host(image, hostCommand.firstEntry(dir));
    if (first.code !== 0 || first.stdout.trim() === '') return 'still_empty';

    const targets = await musicContainers(d, project, dir);
    if (targets === null) return 'restart_failed';
    if (targets.length > 0 && (await d(['restart', ...targets], { timeoutMs: 180_000 })).code !== 0) return 'restart_failed';
    return 'mounted';
  }
}

/**
 * This install's containers (the compose project label) of the music
 * services that bind MUSIC_DIR: what a restart picks the mount up in. Null
 * when Docker did not answer.
 */
export async function musicContainers(docker: Runner, project: string, dir: string): Promise<string[] | null> {
  const ps = await docker(['ps', '-q', '--no-trunc', '--filter', `label=${COMPOSE_PROJECT_LABEL}=${project}`], { timeoutMs: 30_000 });
  if (ps.code !== 0) return null;
  const ids = ps.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
  if (ids.length === 0) return [];
  const format = `{{.Id}}\t{{index .Config.Labels "${COMPOSE_SERVICE_LABEL}"}}\t{{range .Mounts}}{{if eq .Type "bind"}}{{.Source}}\x1f{{end}}{{end}}`;
  const inspect = await docker(['inspect', '--format', format, ...ids], { timeoutMs: 30_000 });
  if (inspect.code !== 0) return null;
  const out: string[] = [];
  for (const line of inspect.stdout.split('\n')) {
    const [id, service, mounts] = line.split('\t');
    if (!id || !service || !(MUSIC_SERVICES as readonly string[]).includes(service)) continue;
    const sources = (mounts ?? '').split('\x1f').map((s) => s.replace(/\/+$/, ''));
    if (sources.includes(dir)) out.push(id);
  }
  return out;
}
