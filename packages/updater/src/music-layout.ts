/**
 * The music share layout an update may move an install to, decided the way
 * install-tagave.sh decides it (pick_music_layout, and write_env for the
 * keys), for a run with no terminal and no --music-parent.
 *
 * direct: MUSIC_DIR itself is bound on /mnt/music, as every install before
 * had it. parent: the folder right above MUSIC_DIR is bound on /mnt/.host
 * with rslave, and the share sits inside it, so a share that is off cannot
 * stop the parts starting.
 *
 * The parent layout is picked only when every check passes, in the
 * installer's order: a music folder; TAGAVE_MUSIC_LAYOUT is not direct;
 * Linux; MUSIC_DIR a mount point or an fstab target; a writable install
 * (TAGAVE_MUSIC_MODE=rw); a name the worker can link to; a safe parent (under
 * /mnt, /media or /srv; never /, /home, a path with . or .., the install
 * folder or one above it, Docker's data or a folder in it); the parent's
 * mount is shared; Docker not rootless, Docker Desktop or the snap; and the
 * parent holds nothing but the music and other mount points (the installer's
 * rule when there is no terminal to ask).
 *
 * decideLayout is pure. readHostFacts collects what it needs: one `docker
 * info`, then four short-lived helpers from the updater's own image (nsenter
 * into PID 1's mount namespace) that read the mount table, fstab, the
 * parent's propagation and the names in the parent. None of them names
 * MUSIC_DIR, which may sit on a share that does not answer; the parent is a
 * local folder. Each call has a 15 s limit, and any failure gives null.
 */
import { randomBytes } from 'node:crypto';
import { join, posix } from 'node:path';
import { envGet, envSet, readText, writeFileAtomic } from './envFile.js';
import { musicDirOf } from './music-heal.js';
import { decodeMountPath } from './music-probe.js';
import { Parts } from './parts.js';
import { partName } from './progress.js';
import type { CommandResult, Runner } from './runner.js';

export interface HostFacts {
  os: 'linux' | 'other';
  /**
   * the host's /proc/self/mountinfo; null when not read, because docker info
   * already ruled the move out (then fstab is '' and propagation and
   * parentEntries are null too)
   */
  mountinfo: string | null;
  /** the host's /etc/fstab ('' when there is none) */
  fstab: string;
  /** findmnt -no PROPAGATION --target <parent> */
  propagation: string | null;
  /** null: Docker named no security options, which the installer reads as not rootless */
  rootless: boolean | null;
  snap: boolean;
  dockerDesktop: boolean;
  /** where Docker keeps its data; null when it did not say */
  dockerRoot: string | null;
  /** the names in the parent folder, names only; null when not listed */
  parentEntries: string[] | null;
  installDir: string;
}

export type LayoutRefusal =
  | 'no_music_dir'
  | 'not_linux'
  | 'not_a_mount'
  | 'read_only'
  | 'bad_name'
  | 'unsafe_parent'
  | 'private_propagation'
  | 'rootless'
  | 'snap'
  | 'docker_desktop'
  | 'siblings'
  | 'owner_direct'
  | 'no_facts';

/** `noAnswer`: only with `private_propagation`, when findmnt gave no answer at all. */
export type LayoutDecision = { layout: 'parent'; keys: Record<string, string> } | { layout: 'direct'; why: LayoutRefusal; noAnswer?: true };

/**
 * Why the music share stays on the direct layout, in plain words (the
 * installer's keep_direct lines, without the paths). `noAnswer` is the
 * decision's: findmnt said nothing, so whether mounts are shared is not known.
 */
export function layoutReason(why: LayoutRefusal, noAnswer?: boolean): string {
  if (why === 'private_propagation' && noAnswer) return "tagave can't tell whether mounts under the folder above it reach the parts (findmnt gave no answer)";
  switch (why) {
    case 'no_music_dir': return 'this computer has no music folder in its settings';
    case 'owner_direct': return 'you asked for it with --music-direct (TAGAVE_MUSIC_LAYOUT=direct in .env)';
    case 'not_linux': return 'this computer is not Linux';
    case 'not_a_mount': return 'the music folder is not a mount point or an fstab entry';
    case 'read_only': return 'a read-only music folder stays read-only only when it is mounted directly';
    case 'bad_name': return "the music folder's name has characters tagave can't use there";
    case 'unsafe_parent': return 'the folder above it is not one tagave shares: it must be under /mnt, /media or /srv, and hold neither the install folder nor Docker\'s data';
    case 'private_propagation': return 'mounts under the folder above it do not reach the parts (its mount is not shared)';
    case 'rootless': return 'Docker runs rootless';
    case 'snap': return 'Docker is the snap package, which only sees some folders';
    case 'docker_desktop': return 'Docker Desktop does not pass later mounts on';
    case 'siblings': return 'the folder above it also holds folders that are not mounts, and there is no terminal to ask';
    case 'no_facts': return "tagave couldn't read the mount table, fstab, the folder above the music folder or where Docker keeps its data";
  }
}

/** Every mount point in mountinfo text, escapes decoded. */
export function mountPoints(mountinfo: string): Set<string> {
  const points = new Set<string>();
  for (const line of mountinfo.split('\n')) {
    const sep = line.indexOf(' - ');
    const point = sep < 0 ? undefined : line.slice(0, sep).split(' ')[4];
    if (point) points.add(decodeMountPath(point));
  }
  return points;
}

const trimSlashes = (p: string) => (p.length > 1 ? p.replace(/\/+$/, '') || '/' : p);

/** Every mount target in fstab text (the second field), escapes decoded and trailing slashes trimmed. */
export function fstabTargets(fstab: string): Set<string> {
  const targets = new Set<string>();
  for (const line of fstab.split('\n')) {
    if (/^[ \t]*#/.test(line)) continue;
    const fields = line.trim().split(/[ \t]+/);
    if (fields.length < 3) continue;
    targets.add(trimSlashes(decodeMountPath(fields[1]!)));
  }
  return targets;
}

/** The worker links /mnt/music to /mnt/.host/NAME and takes only such names. */
const NAME_RE = /^[A-Za-z0-9._ -]+$/;
/**
 * What a .env line can hold in single quotes, as write_env writes it. No
 * backslash either: compose's dotenv reader takes \' as an escaped quote.
 */
const QUOTABLE = /^[^'\\\0-\x1f\x7f]*$/;
const BARE = /^[A-Za-z0-9._:/@,-]*$/;

/** The folder holds `path` or is it: `path` equals it or lies under it. */
function within(path: string, folder: string): boolean {
  const p = trimSlashes(path);
  const f = trimSlashes(folder);
  return f === '/' || p === f || p.startsWith(`${f}/`);
}

type Role = 'all' | 'app' | 'files';

/**
 * TAGAVE_ROLE as write_env records it. An .env from before it was written
 * has no role: DB_HOST is written only on a files computer, so with it the
 * role is files, without it all (the player keys are then written too, and
 * a computer that runs no player never reads them).
 */
function roleOf(env: string): Role {
  const role = envGet(env, 'TAGAVE_ROLE')?.trim();
  if (role === 'all' || role === 'app' || role === 'files') return role;
  return envGet(env, 'DB_HOST')?.trim() ? 'files' : 'all';
}

interface Music {
  dir: string;
  parent: string;
  name: string;
  role: Role;
}

/**
 * The first checks, before any fact: a music folder (an app computer has
 * none), then the owner's TAGAVE_MUSIC_LAYOUT=direct. A MUSIC_DIR that is not
 * a plain absolute path (musicDirOf refuses it) has no safe parent.
 */
function musicOf(env: string): Music | LayoutRefusal {
  const role = roleOf(env);
  if (role === 'app' || !envGet(env, 'MUSIC_DIR')?.trim()) return 'no_music_dir';
  if (envGet(env, 'TAGAVE_MUSIC_LAYOUT')?.trim() === 'direct') return 'owner_direct';
  const dir = musicDirOf(env);
  if (!dir) return 'unsafe_parent';
  const cut = dir.lastIndexOf('/');
  return { dir, parent: cut > 0 ? dir.slice(0, cut) : '/', name: dir.slice(cut + 1), role };
}

function modeCheck(env: string): LayoutRefusal | null {
  return envGet(env, 'TAGAVE_MUSIC_MODE')?.trim() === 'rw' ? null : 'read_only';
}

function nameCheck(name: string): LayoutRefusal | null {
  return NAME_RE.test(name) && name !== '.' && name !== '..' ? null : 'bad_name';
}

/** The parent's own checks: not too wide, a plain path, under /mnt, /media or /srv, not holding the install folder. */
function parentCheck(parent: string, installDir?: string): LayoutRefusal | null {
  // The installer's check against the home folder ($HOME) is left out on
  // purpose: the updater cannot know the owner's HOME (ruling R3), and a
  // home folder already fails the /mnt, /media, /srv rule below.
  if (parent === '/' || parent === '/home') return 'unsafe_parent';
  if (/\/\.\.?(\/|$)/.test(`${parent}/`) || posix.normalize(parent) !== parent) return 'unsafe_parent';
  if (!QUOTABLE.test(parent)) return 'unsafe_parent';
  if (installDir !== undefined && within(installDir, parent)) return 'unsafe_parent';
  if (!['/mnt', '/media', '/srv'].some((top) => within(parent, top))) return 'unsafe_parent';
  return null;
}

/**
 * What `docker info` says against the move, in the installer's order: no
 * data folder named (`no_facts`), the data folder inside or above the
 * parent, rootless, Docker Desktop, the snap.
 */
function dockerCheck(facts: Pick<HostFacts, 'dockerRoot' | 'rootless' | 'dockerDesktop' | 'snap'>, parent: string): LayoutRefusal | null {
  if (facts.dockerRoot === null) return 'no_facts';
  if (within(facts.dockerRoot, parent) || within(parent, facts.dockerRoot)) return 'unsafe_parent';
  if (facts.rootless === true) return 'rootless';
  if (facts.dockerDesktop) return 'docker_desktop';
  if (facts.snap) return 'snap';
  return null;
}

/**
 * What .env (and the install folder, when given) alone says against the
 * move: no music folder, the owner's TAGAVE_MUSIC_LAYOUT=direct, a read-only
 * install, a name or a parent that cannot be used. Null when the host must
 * be asked. readHostFacts asks nothing while this refuses, so an install
 * that cannot move never starts a privileged helper.
 */
export function cheapRefusal(env: string, installDir?: string): LayoutRefusal | null {
  const music = musicOf(env);
  if (typeof music === 'string') return music;
  return modeCheck(env) ?? nameCheck(music.name) ?? parentCheck(music.parent, installDir);
}

/**
 * The layout for this .env on this host. With no facts, the cheap refusal
 * when there is one, otherwise `no_facts`: nothing moves on a guess.
 * Docker not saying where it keeps its data, or the parent not listed, is
 * `no_facts` too (the installer keeps direct for both).
 */
export function decideLayout(env: string, facts: HostFacts | null): LayoutDecision {
  const direct = (why: LayoutRefusal): LayoutDecision => ({ layout: 'direct', why });
  const music = musicOf(env);
  if (typeof music === 'string') return direct(music);
  if (!facts) return direct(cheapRefusal(env) ?? 'no_facts');
  const { dir, parent, name, role } = music;

  if (facts.os !== 'linux') return direct('not_linux');
  // The helpers were not run (docker info already ruled the move out): the
  // Docker-level reason comes ahead of the checks that need the mount table.
  if (facts.mountinfo === null) {
    return direct(modeCheck(env) ?? nameCheck(name) ?? parentCheck(parent, facts.installDir) ?? dockerCheck(facts, parent) ?? 'no_facts');
  }
  const points = mountPoints(facts.mountinfo);
  if (!points.has(dir) && !fstabTargets(facts.fstab).has(dir)) return direct('not_a_mount');
  const early = modeCheck(env) ?? nameCheck(name) ?? parentCheck(parent, facts.installDir);
  if (early) return direct(early);

  const propagation = (facts.propagation ?? '').replace(/\s/g, '');
  if (propagation === '') return { layout: 'direct', why: 'private_propagation', noAnswer: true };
  if (!propagation.split(',').includes('shared')) return direct('private_propagation');

  const docker = dockerCheck(facts, parent);
  if (docker) return direct(docker);

  if (facts.parentEntries === null) return direct('no_facts');
  if (facts.parentEntries.some((e) => e !== '' && e !== name && !points.has(`${parent}/${e}`))) return direct('siblings');

  const keys: Record<string, string> = {
    TAGAVE_MUSIC_BIND_SOURCE: parent,
    TAGAVE_MUSIC_BIND_TARGET: '/mnt/.host',
  };
  // Only an all-in-one computer runs the player.
  if (role === 'all') keys['TAGAVE_PLAYER_BIND_TARGET'] = '/host';
  keys['TAGAVE_MUSIC_PROPAGATION'] = 'rslave';
  keys['TAGAVE_MUSIC_NAME'] = name;
  if (role === 'all') keys['TAGAVE_PLAYER_MUSIC_FOLDER'] = `/host/${name}`;
  return { layout: 'parent', keys };
}

/**
 * `envText` with each key set, the way write_env writes them: a value that
 * envSet takes is written bare, any other in single quotes (a name or a
 * folder with a space). A value with a quote or a control character is
 * refused, as no .env line can hold it.
 */
export function withLayoutKeys(envText: string, keys: Record<string, string>): string {
  let text = envText;
  for (const [key, value] of Object.entries(keys)) {
    if (BARE.test(value)) {
      text = envSet(text, key, value);
      continue;
    }
    if (!QUOTABLE.test(value)) throw new Error(`refusing to write ${key}: unexpected characters in its value`);
    // envSet writes the line; the placeholder is then swapped for the quoted value.
    const lines = envSet(text, key, 'x').split('\n');
    let idx = -1;
    lines.forEach((line, i) => { if (line.startsWith(`${key}=`)) idx = i; });
    lines[idx] = `${key}='${value}'`;
    text = lines.join('\n');
  }
  return text;
}

// ---------------------------------------------------------------------------
// I/O: the host facts.

export const LAYOUT_HELPER_PREFIX = 'tagave-layout';
const FACT_MS = 15_000;

/** `docker run` of a helper from the updater's own image: nsenter into PID 1's mount namespace, one fixed command. */
export function layoutHelperArgs(image: string, name: string, command: readonly string[]): string[] {
  return ['run', '--rm', '--privileged', '--pid=host', '--name', name, '--entrypoint', 'nsenter', image, '-t', '1', '-m', '--', ...command];
}

/** One `docker info`: the system, its name, the data folder and the security options, a line each. */
export const DOCKER_INFO_ARGS = ['info', '--format', '{{.OSType}}{{"\\n"}}{{.OperatingSystem}}{{"\\n"}}{{.DockerRootDir}}{{"\\n"}}{{range .SecurityOptions}}{{.}} {{end}}'];

/**
 * Names only, never a stat: the parent is a local folder, but what it holds
 * may be other shares, and a stat on one whose server is gone could hang.
 * Plain sh globs (POSIX sh, dash and busybox ash alike) read the folder and
 * match the names without a stat. A pattern that matches nothing stays as it
 * is written and is skipped; so a file named exactly `*` is not listed.
 * The parent comes in as $1, never inside the script; a parent that is not
 * a folder fails the `cd` (the parent's own lookup, a local one).
 */
export const LIST_SCRIPT = [
  'p=$1',
  'cd "$p" || exit 1',
  'for e in "$p"/* "$p"/.[!.]* "$p"/..?*; do',
  '  case $e in "$p/*"|"$p/.[!.]*"|"$p/..?*") continue ;; esac',
  '  printf \'%s\\n\' "${e##*/}"',
  'done',
].join('\n');

export const hostFactCommand = {
  mountinfo: ['cat', '/proc/self/mountinfo'],
  fstab: ['cat', '/etc/fstab'],
  propagation: (parent: string) => ['findmnt', '-no', 'PROPAGATION', '--target', parent],
  list: (parent: string) => ['sh', '-c', LIST_SCRIPT, 'sh', parent],
} as const;

/** What `docker info` says, read from DOCKER_INFO_ARGS' output. Snap: the data folder under /var/snap/ (ruling R4). */
export function parseDockerInfo(stdout: string): Pick<HostFacts, 'os' | 'dockerDesktop' | 'dockerRoot' | 'rootless' | 'snap'> {
  const [os = '', system = '', root = '', security = ''] = stdout.split('\n').map((l) => l.trim());
  const dockerRoot = root.startsWith('/') ? trimSlashes(root) : null;
  const options = security.split(/\s+/).filter((o) => o !== '');
  return {
    os: os === 'linux' ? 'linux' : 'other',
    dockerDesktop: system.includes('Docker Desktop'),
    dockerRoot,
    rootless: options.length === 0 ? null : options.some((o) => o.split(',').includes('name=rootless')),
    snap: dockerRoot !== null && dockerRoot.startsWith('/var/snap/'),
  };
}

/** A runner whose rejections become a failed result, so no Docker call can throw. */
function safe(docker: Runner): Runner {
  return (args, opts) => docker(args, opts).catch((err: unknown): CommandResult => ({ code: -1, stdout: '', stderr: String(err) }));
}

/**
 * The host facts decideLayout needs, or null when any of them could not be
 * read (or .env alone already refuses: then nothing runs at all). `image` is
 * the updater's own image (selfImage); `env` the install's .env text, for
 * MUSIC_DIR's parent. Never throws.
 */
export async function readHostFacts(docker: Runner, image: string, installDir: string, env: string, deps: { name?: () => string } = {}): Promise<HostFacts | null> {
  try {
    if (cheapRefusal(env, installDir) !== null) return null;
    const dir = musicDirOf(env);
    if (!dir) return null;
    const parent = dir.slice(0, dir.lastIndexOf('/'));
    const run = safe(docker);
    const name = deps.name ?? (() => `${LAYOUT_HELPER_PREFIX}-${randomBytes(4).toString('hex')}`);
    const helper = (command: readonly string[]) => run(layoutHelperArgs(image, name(), command), { timeoutMs: FACT_MS });

    const info = await run(DOCKER_INFO_ARGS, { timeoutMs: FACT_MS });
    if (info.code !== 0) return null;
    const daemon = parseDockerInfo(info.stdout);
    // docker info alone rules the move out: no privileged helper runs.
    if (daemon.os !== 'linux' || dockerCheck(daemon, parent) !== null) {
      return { ...daemon, mountinfo: null, fstab: '', propagation: null, parentEntries: null, installDir };
    }
    const mountinfo = await helper(hostFactCommand.mountinfo);
    if (mountinfo.code !== 0) return null;
    const fstab = await helper(hostFactCommand.fstab);
    const noFstab = fstab.code !== 0 && fstab.stderr.includes('/etc/fstab') && fstab.stderr.includes('No such file or directory');
    if (fstab.code !== 0 && !noFstab) return null;
    const propagation = await helper(hostFactCommand.propagation(parent));
    if (propagation.code !== 0) return null;
    const list = await helper(hostFactCommand.list(parent));
    if (list.code !== 0) return null;

    return {
      ...daemon,
      mountinfo: mountinfo.stdout,
      fstab: noFstab ? '' : fstab.stdout,
      propagation: propagation.stdout.trim(),
      parentEntries: list.stdout.split('\n').filter((e) => e !== ''),
      installDir,
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// The one-time move: the update's config step, Repair's start step and
// `cli.js music-layout --apply` (install-tagave.sh update runs that one).

/** The parts that bind the music share: the only ones started again after a move. */
export const LAYOUT_PARTS = ['worker-files', 'player'] as const;

export interface LayoutPlan {
  /** The .env text to write: with the parent keys when it moves, else as it was. */
  env: string;
  moved: boolean;
  /** Why it stays direct; null when it moves or already has the parent keys. */
  why: LayoutRefusal | null;
  /** The one line to log; null when the parent keys are there already. */
  message: string | null;
}

const stays = (why: LayoutRefusal, noAnswer?: boolean) => `the music share stays on the direct layout: ${layoutReason(why, noAnswer)}`;

/**
 * The .env text a decision gives, pure: the update folds it into its own
 * single .env write (so .env.bak stays the file from before the update, and
 * a roll back puts the direct layout back), moveLayout writes it on its own.
 */
export function applyLayout(env: string, decision: LayoutDecision): LayoutPlan {
  if (decision.layout === 'direct') return { env, moved: false, why: decision.why, message: stays(decision.why, decision.noAnswer) };
  try {
    const source = decision.keys['TAGAVE_MUSIC_BIND_SOURCE'] ?? '';
    return {
      env: withLayoutKeys(env, decision.keys),
      moved: true,
      why: null,
      message: `the music share moves to the parent layout: tagave mounts ${source}, the folder above it, so the parts start while the share is off`,
    };
  } catch {
    return { env, moved: false, why: 'unsafe_parent', message: stays('unsafe_parent') };
  }
}

/** The parent keys are there already (TAGAVE_MUSIC_BIND_SOURCE set): an earlier move or the installer wrote them. */
export const hasParentLayout = (env: string) => !!envGet(env, 'TAGAVE_MUSIC_BIND_SOURCE')?.trim();

/**
 * What the move would do to this .env, without writing anything: nothing
 * when the parent keys are there; the cheap refusal without asking the host
 * (`image` is not even looked up then); else readHostFacts and decideLayout.
 * No image: nothing moves on a guess (`no_facts`). Never throws.
 */
export async function planLayout(deps: {
  env: string;
  docker: Runner;
  image: string | null | (() => Promise<string | null>);
  installDir: string;
  name?: () => string;
}): Promise<LayoutPlan> {
  const { env } = deps;
  if (hasParentLayout(env)) return { env, moved: false, why: null, message: null };
  const cheap = cheapRefusal(env, deps.installDir);
  if (cheap !== null) return applyLayout(env, { layout: 'direct', why: cheap });
  const image = typeof deps.image === 'function' ? await deps.image().catch(() => null) : deps.image;
  const facts = image ? await readHostFacts(deps.docker, image, deps.installDir, env, deps.name ? { name: deps.name } : {}) : null;
  return applyLayout(env, decideLayout(env, facts));
}

export interface MoveDeps {
  /** The install folder, the same path on the host and in this container. */
  installDir: string;
  docker: Runner;
  /** The updater's own image for the helpers (selfImage), or how to find it. */
  image: string | null | (() => Promise<string | null>);
  log: (level: 'info' | 'warn', message: string) => void;
  /**
   * Starts the music parts on the new .env. Repair passes its own (its Parts,
   * with the music prober, so a part stuck on a silent share waits as
   * usual); the default is Parts.startParts without a prober.
   */
  start?: (services: string[]) => Promise<void>;
  /** Test seam: the helper containers' names. */
  name?: () => string;
}

/**
 * The move on its own (Repair, cli.js): reads .env, does nothing when the
 * parent keys are there, logs a refusal once and writes nothing; on the
 * parent layout writes the keys (writeFileAtomic keeps .env.bak), checks
 * compose takes them (else puts .env back and throws), then starts only the
 * music parts this install has. Nothing in the music folder changes.
 */
export async function moveLayout(deps: MoveDeps): Promise<{ moved: boolean; why: LayoutRefusal | null }> {
  const path = join(deps.installDir, '.env');
  const env = await readText(path);
  if (env === null) throw new Error(`there is no .env in ${deps.installDir}`);
  const plan = await planLayout({ env, docker: deps.docker, image: deps.image, installDir: deps.installDir, ...(deps.name ? { name: deps.name } : {}) });
  if (plan.message) deps.log('info', plan.message);
  if (!plan.moved) return { moved: false, why: plan.why };

  await writeFileAtomic(path, plan.env);
  const run = safe(deps.docker);
  const svc = await run(['compose', 'config', '--services'], { timeoutMs: 60_000 });
  if (svc.code !== 0) {
    // Without a backup: .env.bak already holds this same text.
    await writeFileAtomic(path, env, false);
    const said = svc.stderr.trim().split('\n').at(-1) ?? '';
    throw new Error(`docker compose rejects the new music share settings, so .env is as it was${said ? `: ${said}` : ''}`);
  }
  const have = new Set(svc.stdout.split('\n').map((s) => s.trim()));
  const services = LAYOUT_PARTS.filter((s) => have.has(s));
  deps.log('info', `.env has the parent layout's settings (old file kept as .env.bak)${services.length ? `; starting ${services.map(partName).join(' and ')} on them` : ''}`);
  if (services.length > 0) {
    const start = deps.start ?? (async (wanted: string[]) => {
      const parts = new Parts({ docker: run, music: null, now: Date.now, log: (l, m) => deps.log(l === 'error' ? 'warn' : l, m) });
      const res = await parts.startParts(wanted);
      for (const p of res.stuck) deps.log('warn', `${partName(p.service)} did not start on the new settings`);
    });
    await start(services);
  }
  return { moved: true, why: null };
}
