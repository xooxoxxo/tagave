/**
 * Tells a dead network music share from slow work, without touching the
 * share. The rule: nothing here touches MUSIC_DIR. The music mount is read
 * from the host's mount table (/proc/self/mountinfo text), which the kernel
 * answers without asking the remote filesystem, so a hung NFS or CIFS share
 * can never block it.
 *
 * Only fstype, server, export and `hard` leave `musicMount`. The mount's
 * super options never do: CIFS options can carry `username=` and `domain=`.
 *
 * The first part is pure. The prober below reads the mount table through
 * a short-lived helper from the updater's own image (nsenter into PID 1's
 * mount namespace, `cat /proc/self/mountinfo`) and checks the share's port
 * over TCP, never its path. Every Docker call has a limit, and a failed one
 * gives a null reading, never a throw.
 *
 * music-heal.ts may only `import type` from this file, so the runtime
 * dependency stays one way.
 */
import { randomBytes } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { readFile } from 'node:fs/promises';
import { createConnection, isIP } from 'node:net';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { MUSIC_SERVICES, musicDirOf, selfImage } from './music-heal.js';
import type { CommandResult, Runner } from './runner.js';

export type MountKind = 'network' | 'local' | 'absent';

export interface MusicMount {
  kind: MountKind;
  fstype: string | null;
  server: string | null;
  export: string | null;
  hard: boolean;
  mountPoint: string | null;
}

export type ServerAnswer = 'answers' | 'silent' | 'unknown';
export type MusicVerdict = 'music_unreachable' | 'music_unmounted' | 'ok';

export interface PartStuck {
  service: string;
  stuck: boolean;
}

/** The parts that bind the music folder: only these can stall on a dead share. */
export const MUSIC_BOUND: readonly string[] = MUSIC_SERVICES;

const NFS_TYPES = new Set(['nfs', 'nfs4']);
const CIFS_TYPES = new Set(['cifs', 'smb3']);

/** Decodes the octal escapes mountinfo uses in paths: space, tab, newline and backslash. */
export function decodeMountPath(text: string): string {
  return text.replace(/\\(040|011|012|134)/g, (_, code: string) => String.fromCharCode(parseInt(code, 8)));
}

const IPV4 = /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/;
const IPV6_BRACKETED = /^\[([0-9A-Fa-f:.]+)\]$/;
const HOSTNAME = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,62})(?:\.[A-Za-z0-9-]{1,63})*$/;

/** A server name safe to pass on: an IPv4 address, a bracketed IPv6 address (returned bare) or a hostname. */
export function validServer(text: string): string | null {
  if (IPV4.test(text)) return text;
  const v6 = IPV6_BRACKETED.exec(text)?.[1];
  if (v6 !== undefined) return v6.includes(':') ? v6 : null;
  if (text.length <= 253 && HOSTNAME.test(text)) return text;
  return null;
}

/** The port the share's server listens on, by fstype. */
export function sharePort(fstype: string): number | null {
  if (NFS_TYPES.has(fstype)) return 2049;
  if (CIFS_TYPES.has(fstype)) return 445;
  return null;
}

interface MountLine {
  mountPoint: string;
  fstype: string;
  source: string;
  options: string[];
}

function parseLine(text: string): MountLine | null {
  const sep = text.indexOf(' - ');
  if (sep < 0) return null;
  const mountPoint = text.slice(0, sep).split(' ')[4];
  const [fstype, source, options = ''] = text.slice(sep + 3).split(' ');
  if (!mountPoint || !fstype || !source) return null;
  return { mountPoint: decodeMountPath(mountPoint), fstype, source, options: options.split(',') };
}

/** Whether `mountPoint` covers `dir`: equal, or a prefix on a `/` boundary. */
function covers(mountPoint: string, dir: string): boolean {
  if (mountPoint === '/') return dir.startsWith('/');
  return dir === mountPoint || dir.startsWith(`${mountPoint}/`);
}

/** Server and export from an NFS `host:/export` or a CIFS `//host/share` source. */
function sourceParts(fstype: string, source: string): { server: string | null; export: string | null } {
  const match = NFS_TYPES.has(fstype) ? /^(\[[^\]]*\]|[^:]+):(\/.*)$/.exec(source) : /^\/\/(\[[^\]]*\]|[^/]+)(\/.*)$/.exec(source);
  const [, host, path] = match ?? [];
  const server = host ? validServer(host) : null;
  if (!server || !path) return { server: null, export: null };
  return { server, export: decodeMountPath(path) };
}

/** The mount that holds `dir`, read from mountinfo text: the longest mount point that covers it. */
export function musicMount(mountinfo: string, dir: string): MusicMount {
  const target = dir.length > 1 ? dir.replace(/\/+$/, '') : dir;
  let best: MountLine | null = null;
  for (const text of mountinfo.split('\n')) {
    const mount = parseLine(text);
    // `>=`: a later mount on the same point sits on top of the earlier one.
    if (mount && covers(mount.mountPoint, target) && (!best || mount.mountPoint.length >= best.mountPoint.length)) best = mount;
  }
  if (!best) return { kind: 'absent', fstype: null, server: null, export: null, hard: false, mountPoint: null };
  const { fstype, mountPoint, options } = best;
  if (sharePort(fstype) !== null) {
    const hard = NFS_TYPES.has(fstype) ? !options.includes('soft') : options.includes('hard');
    return { kind: 'network', fstype, ...sourceParts(fstype, best.source), hard, mountPoint };
  }
  return { kind: mountPoint === target ? 'local' : 'absent', fstype, server: null, export: null, hard: false, mountPoint };
}

/**
 * `music_unreachable`: the music is on a network share, its server is silent
 * and a part that binds the music is stuck. `music_unmounted`: MUSIC_DIR is
 * not a mount point and the app also says the music looks unmounted.
 * Anything else, including no answer at all, is `ok`.
 */
export function musicVerdict(mount: MusicMount, answer: ServerAnswer | null, parts: PartStuck[], appUnmounted?: boolean | null): MusicVerdict {
  if (mount.kind === 'network' && answer === 'silent' && parts.some((p) => p.stuck && MUSIC_BOUND.includes(p.service))) return 'music_unreachable';
  if (mount.kind === 'absent' && appUnmounted === true) return 'music_unmounted';
  return 'ok';
}

// ---------------------------------------------------------------------------
// I/O: the server check and the prober.

/** Opens a TCP connection to `host:port` within `timeoutMs`; true when it connects. */
export type Connector = (host: string, port: number, timeoutMs: number) => Promise<boolean>;
/** Resolves `host` to one address within `timeoutMs`; null when it does not. */
export type Resolver = (host: string, timeoutMs: number) => Promise<string | null>;

export const tcpConnect: Connector = (host, port, timeoutMs) =>
  new Promise((resolve) => {
    const socket = createConnection({ host, port });
    const done = (ok: boolean) => {
      clearTimeout(timer);
      socket.destroy();
      resolve(ok);
    };
    const timer = setTimeout(() => done(false), timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });

export const dnsResolve: Resolver = async (host, timeoutMs) => {
  let timer: NodeJS.Timeout | undefined;
  const limit = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), timeoutMs); });
  const answer = lookup(host).then((r) => r.address, () => null);
  try {
    return await Promise.race([answer, limit]);
  } finally {
    clearTimeout(timer);
  }
};

const sleepMs = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const RESOLVE_MS = 3000;
const CONNECT_MS = 3000;
const CONNECT_TRIES = 3;
const CONNECT_GAP_MS = 500;

/**
 * Whether the share's server answers on its port. A hostname is resolved
 * first; if it does not resolve, the host check decides (or `unknown`).
 * Then up to 3 connects, 500 ms apart; if all fail, the host check runs
 * once: `true` answers, anything else is `silent`.
 */
export async function probeServer(
  server: string,
  port: number,
  deps: { connect?: Connector; resolve?: Resolver; sleep?: (ms: number) => Promise<void>; hostCheck?: () => Promise<boolean | null> },
): Promise<ServerAnswer> {
  const connect = deps.connect ?? tcpConnect;
  const sleep = deps.sleep ?? sleepMs;
  const hostCheck = async () => (deps.hostCheck ? deps.hostCheck().catch(() => null) : null);
  let address = server;
  if (isIP(server) === 0) {
    const found = await (deps.resolve ?? dnsResolve)(server, RESOLVE_MS).catch(() => null);
    if (found === null) {
      const host = await hostCheck();
      return host === true ? 'answers' : host === false ? 'silent' : 'unknown';
    }
    address = found;
  }
  for (let i = 0; i < CONNECT_TRIES; i++) {
    if (i > 0) await sleep(CONNECT_GAP_MS);
    if (await connect(address, port, CONNECT_MS).catch(() => false)) return 'answers';
  }
  return (await hostCheck()) === true ? 'answers' : 'silent';
}

export const PROBE_HELPER_PREFIX = 'tagave-music-probe';

/** `docker run` of the probe helper: nsenter into PID 1's mount namespace and print the mount table. */
export function mountinfoArgs(image: string, name: string): string[] {
  return ['run', '--rm', '--privileged', '--pid=host', '--name', name, '--entrypoint', 'nsenter', image, '-t', '1', '-m', '--', 'cat', '/proc/self/mountinfo'];
}

/** `docker run` of busybox nc on the host network: does the share's port answer from the host? */
export function hostConnectArgs(image: string, name: string, server: string, port: number): string[] {
  return ['run', '--rm', '--network', 'host', '--name', name, '--entrypoint', 'nc', image, '-z', '-w', '3', server, String(port)];
}

export interface MusicReading {
  dir: string;
  mount: MusicMount;
  /** null when the music is not on a network share with a valid server */
  answer: ServerAnswer | null;
  verdict: MusicVerdict;
  server: string | null;
}

export interface MusicProber {
  /** Null when there is no MUSIC_DIR or Docker could not read the mount table. */
  read(input: { parts: PartStuck[]; appUnmounted?: boolean | null }): Promise<MusicReading | null>;
}

const MOUNTINFO_MS = 15_000;
const HOST_CHECK_MS = 10_000;

/** A runner whose rejections become a failed result, so no Docker call can throw. */
function safe(docker: Runner): Runner {
  return (args, opts) => docker(args, opts).catch((err: unknown): CommandResult => ({ code: -1, stdout: '', stderr: String(err) }));
}

export function musicProber(deps: {
  installDir: string;
  docker: Runner;
  self?: string;
  connect?: Connector;
  resolve?: Resolver;
  sleep?: (ms: number) => Promise<void>;
  name?: () => string;
}): MusicProber {
  const docker = safe(deps.docker);
  const name = deps.name ?? (() => `${PROBE_HELPER_PREFIX}-${randomBytes(4).toString('hex')}`);
  return {
    async read({ parts, appUnmounted }) {
      const env = await readFile(join(deps.installDir, '.env'), 'utf8').catch(() => '');
      const dir = musicDirOf(env);
      if (!dir) return null;
      const image = await selfImage(docker, deps.self ?? hostname());
      if (!image) return null;
      const table = await docker(mountinfoArgs(image, name()), { timeoutMs: MOUNTINFO_MS });
      if (table.code !== 0) return null;
      const mount = musicMount(table.stdout, dir);
      const port = mount.kind === 'network' && mount.fstype ? sharePort(mount.fstype) : null;
      const server = mount.server;
      let answer: ServerAnswer | null = null;
      if (server && port !== null) {
        const hostCheck = async () => {
          const r = await docker(hostConnectArgs(image, name(), server, port), { timeoutMs: HOST_CHECK_MS });
          return r.code === 0 ? true : r.code === 1 ? false : null;
        };
        answer = await probeServer(server, port, { ...deps, hostCheck });
      }
      return { dir, mount, answer, verdict: musicVerdict(mount, answer, parts, appUnmounted), server };
    },
  };
}

/**
 * Shares one reading (in flight or finished, a null one too) between all
 * calls within `ttlMs`, so parallel stops probe once. The verdict is worked
 * out again for each caller's parts.
 */
export function cachedProber(p: MusicProber, now: () => number, ttlMs = 60_000): MusicProber {
  let last: { at: number; reading: Promise<MusicReading | null> } | null = null;
  return {
    async read(input) {
      if (!last || now() - last.at >= ttlMs) last = { at: now(), reading: p.read(input).catch(() => null) };
      const r = await last.reading;
      return r && { ...r, verdict: musicVerdict(r.mount, r.answer, input.parts, input.appUnmounted) };
    },
  };
}
