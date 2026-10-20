/**
 * Free space before an update. The 0.8.0 update filled a server's disk: a
 * pre-update dump and the new images landed on top of leftover build cache,
 * Postgres crash-looped and the app answered 502. So before anything is
 * pulled or dumped, the updater works out what the update writes and where,
 * and refuses with numbers and a way out when it does not fit.
 *
 * What lands where:
 *
 *   Docker's data root   the new images, unpacked; the database volume
 *                        (Postgres must keep room to run, and a heavy
 *                        migration of the target writes there: see
 *                        heavy-migrations.ts)
 *   the backups folder   one dump: the new app's own, right before it
 *                        migrates (rollback-dump.ts). Two only when the
 *                        updater must take one too and the app may as well.
 *
 * The backups folder is often a volume inside Docker's data root, and then
 * both loads share one filesystem. The two count as one when they report
 * the same total or the same free space (a named volume reports the data
 * root's numbers; ZFS datasets and btrfs subvolumes of one pool share their
 * free space). They count as two only when the backups are a host folder
 * (TAGAVE_BACKUP_DIR) whose numbers differ. Anything in between is unsure:
 * the dumps are counted on both. (Device numbers cannot settle it: the
 * updater's root is an overlay with a device of its own.)
 *
 * With no dump to go by, a dump is taken to be the database minus its
 * indexes (pg_dump writes index definitions, not their contents).
 *
 * The rule, per filesystem:
 *
 *   required = (images × UNPACK_FACTOR + backup × copies + migration) × 1.2 + headroom
 *
 * with headroom = TAGAVE_UPDATER_MIN_FREE_MB (3 GB by default) on the Docker
 * filesystem and 512 MB on a separate backups filesystem. The headroom is
 * added, not a floor under the total, so it is what is still free once the
 * update has written everything. Image sizes are the compressed layer sizes
 * from the registry; unpacked layers take about 2.5 times that. Layers the
 * current images already have, and images already here, are not counted.
 *
 * The measurements run through the Docker CLI (the app container reads the
 * backups folder; the updater's own root filesystem is an overlay on
 * Docker's data root, so statfs("/") here measures that). Each one has a
 * conservative default when it cannot be made, and the log says so.
 */
import type { Runner } from './runner.js';

export const GB = 1024 ** 3;
export const MB = 1024 ** 2;

export const SPACE_RULES = {
  /** Added on top of everything the update writes. */
  margin: 0.2,
  /** Left free on a backups filesystem that is not Docker's (the Docker one uses config.minFreeBytes). */
  backupHeadroomBytes: 512 * MB,
  /** Unpacked image layers take about this many times their compressed size. */
  unpackFactor: 2.5,
  /** Dumps per update: the new app's pre-migration dump (the updater takes none of its own). */
  backupCopies: 1,
  /** Compressed size assumed for an image the registry does not describe. */
  defaultImageBytes: 1 * GB,
  /** Dump size assumed when neither a dump nor the database can be measured. */
  defaultBackupBytes: 2 * GB,
} as const;

// -- the arithmetic ----------------------------------------------------------

export interface FsReading {
  /** Where this is, for the message: a path on the host or in a container. */
  where: string;
  freeBytes: number;
  /** null when unknown; then it is never matched to another filesystem. */
  totalBytes: number | null;
}

export interface SpaceNeeds {
  /** Compressed bytes still to download. */
  imageBytes: number;
  /** One dump. */
  backupBytes: number;
  /** How many dumps the update writes (default SPACE_RULES.backupCopies). */
  backupCopies?: number;
  /** What the target's migrations write to the database while they run (heavy-migrations.ts); on Docker's filesystem. */
  migrationBytes?: number;
  /** Says what the migration bytes are for, in the check's parts. */
  migrationWhat?: string;
}

export interface FsCheck {
  label: string;
  where: string;
  freeBytes: number;
  requiredBytes: number;
  /** What goes on this filesystem, before margin and headroom. */
  parts: Array<{ what: string; bytes: number }>;
  headroomBytes: number;
  ok: boolean;
}

/** Free space read moments apart on one filesystem differs by less than this. */
const SAME_FREE_TOLERANCE = (a: number, b: number) => Math.max(64 * MB, Math.max(a, b) * 0.005);

export type FsRelation = 'same' | 'separate' | 'unsure';

/**
 * Whether the backups land on Docker's filesystem. `backupsOnHost`: the
 * backups are a host folder (TAGAVE_BACKUP_DIR), not a named volume.
 */
export function filesystemRelation(docker: FsReading, backups: FsReading, backupsOnHost: boolean): FsRelation {
  if (docker.totalBytes !== null && docker.totalBytes === backups.totalBytes) return 'same';
  if (Math.abs(docker.freeBytes - backups.freeBytes) <= SAME_FREE_TOLERANCE(docker.freeBytes, backups.freeBytes)) return 'same';
  if (backupsOnHost && docker.totalBytes !== null && backups.totalBytes !== null) return 'separate';
  return 'unsure';
}

export function requiredBytes(load: number, headroom: number, margin: number = SPACE_RULES.margin): number {
  return Math.ceil(load * (1 + margin)) + headroom;
}

/**
 * One check per filesystem the update writes to. `backups` null: the
 * backups folder could not be measured, so its load is put on the Docker
 * filesystem (where the default named volume lives). Unsure where the
 * backups land: their load is counted on both.
 */
export function planSpace(docker: FsReading, backups: FsReading | null, needs: SpaceNeeds, dockerHeadroom: number, backupsOnHost = false): FsCheck[] {
  const images = { what: 'the new images, unpacked', bytes: Math.ceil(needs.imageBytes * SPACE_RULES.unpackFactor) };
  const copies = needs.backupCopies ?? SPACE_RULES.backupCopies;
  const dumps = { what: copies === 1 ? 'a database backup' : `${copies} database backups`, bytes: needs.backupBytes * copies };
  // Postgres's volume is a named volume on Docker's filesystem.
  const migration = { what: needs.migrationWhat ?? 'the database changes of the new version', bytes: Math.ceil(needs.migrationBytes ?? 0) };
  const check = (label: string, fs: FsReading, parts: FsCheck['parts'], headroom: number): FsCheck => {
    const kept = parts.filter((p) => p.bytes > 0);
    const required = requiredBytes(kept.reduce((n, p) => n + p.bytes, 0), headroom);
    return { label, where: fs.where, freeBytes: fs.freeBytes, requiredBytes: required, parts: kept, headroomBytes: headroom, ok: fs.freeBytes >= required };
  };
  const relation = backups ? filesystemRelation(docker, backups, backupsOnHost) : 'same';
  if (!backups || relation === 'same') {
    return [check("Docker's data", docker, [images, dumps, migration], dockerHeadroom)];
  }
  return [
    check("Docker's data", docker, relation === 'unsure' ? [images, dumps, migration] : [images, migration], dockerHeadroom),
    check('the backups', backups, [dumps], SPACE_RULES.backupHeadroomBytes),
  ];
}

export function formatBytes(n: number): string {
  if (n >= GB) return `${(n / GB).toFixed(1)} GB`;
  return `${Math.max(0, Math.round(n / MB))} MB`;
}

/** What is safe to delete to make room, for the refusal. */
export const FREE_SPACE_HINTS = [
  'docker builder prune (build cache, never needed to run tagave)',
  'docker image prune (images no container uses and no tag names)',
  "old tagave images: docker image ls --filter 'reference=*/tagave-*', then docker image rm the versions you no longer run",
  'old backups: Settings › Backups, or the backups folder (keep the newest)',
];

export function describeCheck(c: FsCheck): string {
  const parts = c.parts.map((p) => `${p.what} ~${formatBytes(p.bytes)}`);
  parts.push(`${Math.round(SPACE_RULES.margin * 100)} % margin`, `${formatBytes(c.headroomBytes)} left free`);
  return `${c.label} (${c.where}): ${formatBytes(c.freeBytes)} free, needs ${formatBytes(c.requiredBytes)} (${parts.join(', ')})`;
}

/** null when every filesystem has room; else the reason the update refuses. */
export function spaceShortMessage(checks: FsCheck[], what = 'the update'): string | null {
  const short = checks.filter((c) => !c.ok);
  if (short.length === 0) return null;
  const lines = short.map((c) => `${c.label} on ${c.where} has ${formatBytes(c.freeBytes)} free and ${what} needs ${formatBytes(c.requiredBytes)}`);
  const missing = short.map((c) => formatBytes(c.requiredBytes - c.freeBytes)).join(' and ');
  return `not enough free disk space: ${lines.join('; ')}. Free at least ${missing}; safe to delete: ${FREE_SPACE_HINTS.join('; ')}`;
}

// -- image sizes from the registry -------------------------------------------

export interface ImageRef {
  registry: string;
  repository: string;
  /** A tag or a digest. */
  reference: string;
}

export function parseImageRef(ref: string): ImageRef {
  let rest = ref.trim();
  let reference = 'latest';
  const at = rest.indexOf('@');
  if (at >= 0) {
    reference = rest.slice(at + 1);
    rest = rest.slice(0, at);
  }
  // A tag, also in front of a digest (name:tag@sha256:…, as the release's
  // pins write it): the digest wins and the tag is not part of the name.
  const colon = rest.lastIndexOf(':');
  if (colon > rest.lastIndexOf('/')) {
    if (at < 0) reference = rest.slice(colon + 1);
    rest = rest.slice(0, colon);
  }
  const parts = rest.split('/');
  const first = parts[0] ?? '';
  if (parts.length > 1 && (first.includes('.') || first.includes(':') || first === 'localhost')) {
    return { registry: first, repository: parts.slice(1).join('/'), reference };
  }
  return { registry: 'registry-1.docker.io', repository: parts.length === 1 ? `library/${rest}` : rest, reference };
}

export type Fetch = (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<{
  status: number;
  headers: { get(name: string): string | null };
  json(): Promise<unknown>;
}>;

export interface Layer {
  digest: string;
  size: number;
}

const MANIFEST_ACCEPT = [
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.docker.distribution.manifest.v2+json',
].join(', ');
const REGISTRY_TIMEOUT_MS = 10_000;

/** node's process.arch in the names image indexes use. */
export function dockerArch(arch: string = process.arch): string {
  return ({ x64: 'amd64', arm64: 'arm64', arm: 'arm', ia32: '386', ppc64: 'ppc64le', s390x: 's390x' } as Record<string, string>)[arch] ?? arch;
}

function bearerChallenge(header: string | null): { realm: string; service: string | undefined; scope: string | undefined } | null {
  if (!header || !/^bearer\s/i.test(header)) return null;
  const params: Record<string, string> = {};
  for (const m of header.slice(7).matchAll(/(\w+)="([^"]*)"/g)) params[m[1]!] = m[2]!;
  return params['realm'] ? { realm: params['realm'], service: params['service'], scope: params['scope'] } : null;
}

/** Reads image manifests anonymously (with the token dance ghcr.io and Docker Hub want). */
export function registryClient(fetchImpl: Fetch, arch: string = dockerArch()) {
  const tokens = new Map<string, string>();

  async function get(img: ImageRef, reference: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const timeout = () => (signal ? AbortSignal.any([signal, AbortSignal.timeout(REGISTRY_TIMEOUT_MS)]) : AbortSignal.timeout(REGISTRY_TIMEOUT_MS));
    const url = `https://${img.registry}/v2/${img.repository}/manifests/${reference}`;
    const key = `${img.registry}/${img.repository}`;
    const headers = (): Record<string, string> => ({
      Accept: MANIFEST_ACCEPT,
      ...(tokens.has(key) ? { Authorization: `Bearer ${tokens.get(key)}` } : {}),
    });
    let res = await fetchImpl(url, { headers: headers(), signal: timeout() });
    if (res.status === 401) {
      const ch = bearerChallenge(res.headers.get('www-authenticate'));
      if (!ch) throw new Error(`${img.registry} wants a login`);
      const q = new URLSearchParams();
      if (ch.service) q.set('service', ch.service);
      q.set('scope', ch.scope ?? `repository:${img.repository}:pull`);
      const t = await fetchImpl(`${ch.realm}?${q}`, { headers: {}, signal: timeout() });
      if (t.status !== 200) throw new Error(`${img.registry} gave no token (${t.status})`);
      const body = (await t.json()) as { token?: string; access_token?: string };
      const token = body.token ?? body.access_token;
      if (!token) throw new Error(`${img.registry} gave no token`);
      tokens.set(key, token);
      res = await fetchImpl(url, { headers: headers(), signal: timeout() });
    }
    if (res.status !== 200) throw new Error(`${img.registry} answered ${res.status} for ${img.repository}:${reference}`);
    return (await res.json()) as Record<string, unknown>;
  }

  /** The compressed layers of `ref` for this machine's architecture. */
  return async function layers(ref: string, signal?: AbortSignal): Promise<Layer[]> {
    const img = parseImageRef(ref);
    let manifest = await get(img, img.reference, signal);
    if (Array.isArray(manifest['manifests'])) {
      const entries = manifest['manifests'] as Array<{ digest?: string; platform?: { os?: string; architecture?: string } }>;
      const mine = entries.find((m) => m.platform?.os === 'linux' && m.platform.architecture === arch);
      if (!mine?.digest) throw new Error(`${ref} has no image for linux/${arch}`);
      manifest = await get(img, mine.digest, signal);
    }
    const list = manifest['layers'];
    if (!Array.isArray(list)) throw new Error(`${ref}: the manifest lists no layers`);
    return (list as Array<{ digest?: unknown; size?: unknown }>)
      .filter((l) => typeof l.digest === 'string' && typeof l.size === 'number')
      .map((l) => ({ digest: l.digest as string, size: l.size as number }));
  };
}

// -- the measurements ----------------------------------------------------------

/**
 * Run in the app container: the newest dump in its backups folder, and that
 * folder's filesystem. The folder is found as the doctor finds it: BACKUP_DIR
 * (LINER_BACKUP_DIR before 0.9), else CACHE_DIR/backups, else /backups.
 */
export const BACKUPS_PROBE_JS = [
  "const fs=require('fs'),path=require('path');",
  "const e=process.env,dir=e.BACKUP_DIR||e.LINER_BACKUP_DIR||(e.CACHE_DIR?path.join(e.CACHE_DIR,'backups'):'/backups');",
  'let newest=null;',
  "try{for(const n of fs.readdirSync(dir)){if(!n.endsWith('.pgdump'))continue;const s=fs.statSync(path.join(dir,n));",
  'if(s.isFile()&&(!newest||s.mtimeMs>newest.mtime))newest={name:n,bytes:s.size,mtime:s.mtimeMs};}}catch{}',
  'let disk=null;try{const s=fs.statfsSync(dir);disk={free:s.bavail*s.bsize,total:s.blocks*s.bsize};}catch{}',
  'console.log(JSON.stringify({dir,newest,disk}));',
].join('');

export interface StatfsLike {
  bavail: number;
  bsize: number;
  blocks: number;
}

export interface SpaceProbeDeps {
  /** `docker <args>`, without logging each call. */
  docker: Runner;
  statfs: (path: string) => Promise<StatfsLike>;
  /** Layers of an image, from its registry. */
  layers: (ref: string, signal?: AbortSignal) => Promise<Layer[]>;
  /** Time for all registry reads of one check (default 30 s). */
  registryBudgetMs?: number;
  /** Every line goes to the update log. */
  log: (level: 'info' | 'warn', message: string) => void;
}

export interface SpaceInputs {
  docker: FsReading;
  backups: FsReading | null;
  needs: SpaceNeeds;
}

const lines = (s: string) => s.split('\n').map((l) => l.trim()).filter(Boolean);

async function dockerFs(d: SpaceProbeDeps): Promise<FsReading> {
  const info = await d.docker(['info', '--format', '{{.DockerRootDir}}'], { timeoutMs: 30_000 });
  const root = info.code === 0 ? lines(info.stdout)[0] : undefined;
  const s = await d.statfs('/');
  return { where: root ?? "Docker's data root", freeBytes: s.bavail * s.bsize, totalBytes: s.blocks * s.bsize };
}

async function backupsProbe(d: SpaceProbeDeps): Promise<{ fs: FsReading | null; newest: { name: string; bytes: number } | null; dir: string }> {
  const res = await d.docker(['compose', 'exec', '-T', 'app', 'node', '-e', BACKUPS_PROBE_JS], { timeoutMs: 60_000 });
  try {
    const out = JSON.parse(lines(res.stdout).at(-1) ?? '') as {
      dir: string;
      newest: { name: string; bytes: number } | null;
      disk: { free: number; total: number } | null;
    };
    const where = `${out.dir} in the app container`;
    return { dir: out.dir, newest: out.newest, fs: out.disk ? { where, freeBytes: out.disk.free, totalBytes: out.disk.total } : null };
  } catch {
    return { dir: '/backups', newest: null, fs: null };
  }
}

/** The database's size and its indexes' (a dump holds the data, not the indexes). */
export const DATABASE_SIZE_SQL =
  "select pg_database_size(current_database()) || ' ' || coalesce((select sum(pg_indexes_size(c.oid)) from pg_class c where c.relkind in ('r','m','t')), 0)";

async function databaseBytes(d: SpaceProbeDeps): Promise<{ total: number; indexes: number } | null> {
  const res = await d.docker(
    ['compose', 'exec', '-T', 'postgres', 'sh', '-c', `psql -X -q -tA -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "${DATABASE_SIZE_SQL}"`],
    { timeoutMs: 30_000 },
  );
  const [total, indexes] = res.stdout.trim().split(/\s+/).map(Number);
  if (res.code !== 0 || !Number.isFinite(total) || total! <= 0) return null;
  return { total: total!, indexes: Number.isFinite(indexes) && indexes! >= 0 && indexes! < total! ? indexes! : 0 };
}

async function backupBytes(d: SpaceProbeDeps, newest: { name: string; bytes: number } | null, dir: string): Promise<number> {
  if (newest && newest.bytes > 0) {
    d.log('info', `space: a backup is about ${formatBytes(newest.bytes)} (the newest one, ${newest.name})`);
    return newest.bytes;
  }
  const db = await databaseBytes(d);
  if (db !== null) {
    const bytes = db.total - db.indexes;
    d.log('info', `space: no backup in ${dir} yet; counting the database without its indexes, ${formatBytes(bytes)} (${formatBytes(db.total)} in all), per backup`);
    return bytes;
  }
  d.log('warn', `space: neither a backup nor the database could be measured; counting ${formatBytes(SPACE_RULES.defaultBackupBytes)} per backup`);
  return SPACE_RULES.defaultBackupBytes;
}

async function imageRefs(d: SpaceProbeDeps, env?: Record<string, string>): Promise<string[] | null> {
  const res = await d.docker(['compose', 'config', '--images'], { ...(env ? { env } : {}), timeoutMs: 60_000 });
  return res.code === 0 ? [...new Set(lines(res.stdout))] : null;
}

async function present(d: SpaceProbeDeps, ref: string): Promise<boolean> {
  const res = await d.docker(['image', 'inspect', '--format', '{{.Id}}', ref], { timeoutMs: 30_000 });
  return res.code === 0;
}

/** registry/repository, the part of a reference without the tag or digest. */
export function repoOf(ref: string): string {
  const r = parseImageRef(ref);
  return `${r.registry}/${r.repository}`;
}

/** The manifest digest the image on disk was pulled as (`name@sha256:...`), or null (built here, or not here). */
async function localDigestRef(d: SpaceProbeDeps, ref: string): Promise<string | null> {
  const res = await d.docker(['image', 'inspect', '--format', '{{json .RepoDigests}}', ref], { timeoutMs: 30_000 });
  if (res.code !== 0) return null;
  try {
    const digests = JSON.parse(res.stdout.trim()) as unknown;
    if (!Array.isArray(digests)) return null;
    const mine = digests.find((x): x is string => typeof x === 'string' && x.includes('@') && repoOf(x) === repoOf(ref));
    return mine ?? null;
  } catch {
    return null;
  }
}

class RegistryTimeout extends Error {}

/**
 * Compressed bytes the target images still have to download: layers of the
 * images not here yet, minus the layers that images of the same repositories
 * here already have (read by the digest they were pulled as). All registry
 * reads share one time budget; past it, every missing image counts 1 GB.
 * `fallbackCount` is how many images to assume when compose cannot list them.
 */
export async function imageDownloadBytes(
  d: SpaceProbeDeps,
  target: string,
  fallbackCount: number,
  want: { env?: Record<string, string>; refs?: string[] } = {},
): Promise<number> {
  // `refs`: exactly these images (a module's); else what compose runs with
  // TAGAVE_VERSION=<target> and the release's digest pins (`env`).
  const wanted = want.refs ? [...new Set(want.refs)] : await imageRefs(d, { TAGAVE_VERSION: target, ...(want.env ?? {}) });
  if (!wanted) {
    const bytes = fallbackCount * SPACE_RULES.defaultImageBytes;
    d.log('warn', `space: docker compose did not list the ${target} images; counting ${formatBytes(SPACE_RULES.defaultImageBytes)} for each of ${fallbackCount}`);
    return bytes;
  }
  const missing: string[] = [];
  for (const ref of wanted) if (!(await present(d, ref))) missing.push(ref);
  if (missing.length === 0) return 0;

  const budgetMs = d.registryBudgetMs ?? 30_000;
  const budget = new AbortController();
  const timer = setTimeout(() => budget.abort(new RegistryTimeout()), budgetMs);
  const timedOut = new Promise<never>((_, reject) => budget.signal.addEventListener('abort', () => reject(new RegistryTimeout()), { once: true }));
  timedOut.catch(() => undefined);
  const layers = (ref: string) => Promise.race([d.layers(ref, budget.signal), timedOut]);

  try {
    // Layers the images in use already have (the base layers rarely change);
    // only for the repositories being pulled, so nothing else is asked about.
    const repos = new Set(missing.map(repoOf));
    const local = new Set<string>();
    for (const ref of (await imageRefs(d)) ?? []) {
      if (missing.includes(ref) || !repos.has(repoOf(ref))) continue;
      const pinned = await localDigestRef(d, ref);
      if (!pinned) continue;
      try {
        for (const l of await layers(pinned)) local.add(l.digest);
      } catch (err) {
        if (err instanceof RegistryTimeout) throw err;
        /* only makes the estimate larger */
      }
    }

    const counted = new Map<string, number>();
    let guessed = 0;
    for (const ref of missing) {
      try {
        for (const l of await layers(ref)) if (!local.has(l.digest)) counted.set(l.digest, l.size);
      } catch (err) {
        if (err instanceof RegistryTimeout || budget.signal.aborted) throw new RegistryTimeout();
        guessed += 1;
        d.log('warn', `space: could not read the size of ${ref} from its registry (${(err as Error).message}); counting ${formatBytes(SPACE_RULES.defaultImageBytes)}`);
      }
    }
    const total = [...counted.values()].reduce((n, s) => n + s, 0) + guessed * SPACE_RULES.defaultImageBytes;
    d.log('info', `space: ${missing.length} image${missing.length === 1 ? '' : 's'} to download, about ${formatBytes(total)} compressed (${missing.join(', ')})`);
    return total;
  } catch (err) {
    if (!(err instanceof RegistryTimeout)) throw err;
    const total = missing.length * SPACE_RULES.defaultImageBytes;
    d.log('warn', `space: the registry did not describe the images within ${Math.round(budgetMs / 1000)} s; counting ${formatBytes(SPACE_RULES.defaultImageBytes)} for each of the ${missing.length} to download`);
    return total;
  } finally {
    clearTimeout(timer);
  }
}

export interface SpaceResult {
  checks: FsCheck[];
  /** null: there is room. */
  problem: string | null;
}

/**
 * Measures, plans and logs. `target` null: the images are pulled already
 * (the re-check before the backup), so only the backups are counted.
 * `backupsOnHost`: .env puts the backups in a host folder (TAGAVE_BACKUP_DIR).
 */
export async function checkSpace(
  d: SpaceProbeDeps,
  opts: {
    target: string | null;
    imageCount: number;
    dockerHeadroom: number;
    backupsOnHost?: boolean;
    /** The release's digest pins, for compose to list the target images by. */
    targetEnv?: Record<string, string>;
    /** Exactly these images instead (a module's), and no backups: turning a module on dumps nothing. */
    images?: string[];
    /** Who needs the room, for the refusal: "the update" by default. */
    what?: string;
    /** Dumps the update writes (default SPACE_RULES.backupCopies). */
    backupCopies?: number;
    /** Extra room a heavy migration of the target needs in the database (heavy-migrations.ts). */
    migration?: { bytes: number; what: string };
  },
): Promise<SpaceResult> {
  const docker = await dockerFs(d);
  const moduleOnly = opts.images !== undefined;
  const b = moduleOnly ? { fs: null, newest: null, dir: '' } : await backupsProbe(d);
  if (!b.fs && !moduleOnly) d.log('warn', `space: could not measure the backups folder from the app container; counting the backups on Docker's filesystem`);
  const backup = moduleOnly ? 0 : await backupBytes(d, b.newest, b.dir);
  const want = opts.images ? { refs: opts.images } : { ...(opts.targetEnv ? { env: opts.targetEnv } : {}) };
  const images = opts.target === null ? 0 : await imageDownloadBytes(d, opts.target, opts.imageCount, want);
  const backupsOnHost = opts.backupsOnHost ?? false;
  if (b.fs && filesystemRelation(docker, b.fs, backupsOnHost) === 'unsure') {
    d.log('info', `space: cannot tell whether ${b.fs.where} is on Docker's filesystem; counting the backups on both`);
  }
  const needs: SpaceNeeds = {
    imageBytes: images,
    backupBytes: backup,
    ...(opts.backupCopies !== undefined ? { backupCopies: opts.backupCopies } : {}),
    ...(opts.migration && !moduleOnly ? { migrationBytes: opts.migration.bytes, migrationWhat: opts.migration.what } : {}),
  };
  const checks = planSpace(docker, b.fs, needs, opts.dockerHeadroom, backupsOnHost);
  for (const c of checks) d.log(c.ok ? 'info' : 'warn', `space: ${describeCheck(c)}`);
  return { checks, problem: spaceShortMessage(checks, opts.what) };
}

/** A TAGAVE_BACKUP_DIR (LINER_BACKUP_DIR before 0.9) with a slash is a host folder; without, a volume name. */
export function backupsOnHostFolder(value: string | undefined | null): boolean {
  return !!value && value.includes('/');
}
