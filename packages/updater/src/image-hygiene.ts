/**
 * Old images, removed after a successful update.
 *
 * Every update pulls a new app, worker and updater image (about 3 GB
 * together) and nothing removed the old ones, so a few updates filled the
 * disk. After an update succeeds this keeps the images of the version that
 * runs now and of the version it came from (a roll back needs them) and
 * removes the older ones.
 *
 * Only these repositories are looked at, matched exactly: <registry>/tagave-app,
 * <registry>/tagave-worker and <registry>/tagave-updater (the registry from
 * TAGAVE_REGISTRY in .env, as in compose.yml). Only tags that are plain
 * release numbers (X.Y.Z) older than the oldest kept one go; pre-releases,
 * `latest`, `edge`, untagged images and anything newer are left. Of the
 * player (Navidrome) only the exact image it ran before this update goes,
 * and only when the update moved it to another image: other tags of that
 * repository may not be tagave's. An image any container uses,
 * running or stopped, is never removed, and `docker image rm` runs without
 * -f, so Docker refuses one that turns out to be in use. Volumes and the build
 * cache are not touched.
 */
import type { Runner } from './runner.js';

export interface LocalImage {
  repository: string;
  tag: string;
  id: string;
}

export interface ImageGroup {
  repository: string;
  /** Tags to keep; plain release tags older than the oldest of these are removed. */
  keep: string[];
  /** Remove exactly this tag instead (when it is not in `keep`), nothing older. */
  only?: string;
}

export interface ImageSelection {
  remove: LocalImage[];
  /** Old enough to go, but a container uses them. */
  inUse: LocalImage[];
}

const RELEASE_RE = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;
const PLAIN_RELEASE_RE = /^\d+\.\d+\.\d+$/;

/** A release number, pre-releases included (0.9.0-rc.1): kept tags may be one. */
export function isReleaseTag(tag: string): boolean {
  return RELEASE_RE.test(tag);
}

/** X.Y.Z and nothing else, as is_release in install-tagave.sh: only these are ever removed. */
export function isPlainRelease(tag: string): boolean {
  return PLAIN_RELEASE_RE.test(tag);
}

/** Semver's pre-release order: numeric identifiers by number, below alphanumeric ones; a shorter list first. */
function comparePrerelease(a: string, b: string): number {
  const pa = a.split('.');
  const pb = b.split('.');
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const x = pa[i];
    const y = pb[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const nx = /^\d+$/.test(x);
    const ny = /^\d+$/.test(y);
    if (nx && ny) {
      const d = Number(x) - Number(y);
      if (d !== 0) return d;
    } else if (nx !== ny) {
      return nx ? -1 : 1;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

/** Orders release numbers; a pre-release (0.9.0-rc.1) comes before its release. Null when either is not one. */
export function compareReleases(a: string, b: string): number | null {
  const ma = RELEASE_RE.exec(a);
  const mb = RELEASE_RE.exec(b);
  if (!ma || !mb) return null;
  for (let i = 1; i <= 3; i += 1) {
    const d = Number(ma[i]) - Number(mb[i]);
    if (d !== 0) return d;
  }
  if (ma[4] === mb[4]) return 0;
  if (ma[4] === undefined) return 1;
  if (mb[4] === undefined) return -1;
  return comparePrerelease(ma[4], mb[4]);
}

/** The repository as `docker image ls` names it: Docker Hub's implicit prefixes dropped. */
export function normalizeRepository(repo: string): string {
  return repo.replace(/^docker\.io\/library\//, '').replace(/^docker\.io\//, '').replace(/^index\.docker\.io\//, '');
}

/** Splits an image reference into repository and tag; null for a digest reference or one without a tag. */
export function splitImageRef(ref: string): { repository: string; tag: string } | null {
  const r = ref.trim();
  if (r === '' || r.includes('@')) return null;
  const slash = r.lastIndexOf('/');
  const colon = r.lastIndexOf(':');
  if (colon <= slash) return null;
  return { repository: normalizeRepository(r.slice(0, colon)), tag: r.slice(colon + 1) };
}

export const TAGAVE_IMAGE_NAMES = ['tagave-app', 'tagave-worker', 'tagave-updater'];

/**
 * The tagave images to keep: the version that runs now, and the one it came
 * from. When `from` is not a release number (an old .env said `latest`), the
 * newest local release older than the target stands in for it.
 */
export function tagaveGroups(registry: string, from: string, target: string, images: LocalImage[]): ImageGroup[] {
  const repos = TAGAVE_IMAGE_NAMES.map((n) => normalizeRepository(`${registry.replace(/\/$/, '')}/${n}`));
  let previous: string | null = isReleaseTag(from) ? from : null;
  if (previous === null) {
    const older = images
      .filter((i) => repos.includes(normalizeRepository(i.repository)) && (compareReleases(i.tag, target) ?? 0) < 0)
      .map((i) => i.tag)
      .sort((a, b) => compareReleases(b, a) ?? 0);
    previous = older[0] ?? null;
  }
  const keep = previous ? [target, previous] : [target];
  return repos.map((repository) => ({ repository, keep }));
}

/**
 * The player's image to remove when this update moved it from `before` to
 * `after`: exactly `before`, never another tag of its repository. None when
 * it stayed on the same image.
 */
export function playerGroups(before: string | null, after: string | null): ImageGroup[] {
  if (!before || !after) return [];
  const b = splitImageRef(before);
  const a = splitImageRef(after);
  if (!a || !b || (a.repository === b.repository && a.tag === b.tag)) return [];
  return [{ repository: b.repository, keep: b.repository === a.repository ? [a.tag] : [], only: b.tag }];
}

/** Which local images go. Pure: the lists come from docker image ls and docker ps -a. */
export function selectOldImages(images: LocalImage[], groups: ImageGroup[], usedIds: Set<string>, usedRefs: Set<string> = new Set()): ImageSelection {
  const remove: LocalImage[] = [];
  const inUse: LocalImage[] = [];
  const seen = new Set<string>();
  const take = (image: LocalImage, repo: string) => {
    const ref = `${repo}:${image.tag}`;
    if (seen.has(ref)) return;
    seen.add(ref);
    if (usedIds.has(image.id) || usedRefs.has(ref) || usedRefs.has(`${image.repository}:${image.tag}`)) inUse.push(image);
    else remove.push(image);
  };
  for (const group of groups) {
    const repo = normalizeRepository(group.repository);
    const mine = images.filter((i) => normalizeRepository(i.repository) === repo);
    if (group.only !== undefined) {
      if (group.keep.includes(group.only)) continue;
      for (const image of mine) if (image.tag === group.only) take(image, repo);
      continue;
    }
    const releases = group.keep.filter(isReleaseTag);
    if (releases.length === 0) continue; // no release to measure "older" by: remove nothing
    const floor = releases.reduce((lo, t) => ((compareReleases(t, lo) ?? 0) < 0 ? t : lo));
    for (const image of mine) {
      if (!isPlainRelease(image.tag) || group.keep.includes(image.tag)) continue;
      if ((compareReleases(image.tag, floor) ?? 0) >= 0) continue;
      take(image, repo);
    }
  }
  return { remove, inUse };
}

export function formatBytes(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GB`;
  return `${Math.round(n / 1024 ** 2)} MB`;
}

export interface CleanupResult {
  removed: string[];
  /** Sum of Docker's sizes of the removed images (layers shared with kept images free less). */
  bytes: number;
  inUse: string[];
  failed: Array<{ ref: string; error: string }>;
}

function lines(text: string): string[] {
  return text.split('\n').map((l) => l.trim()).filter(Boolean);
}

/** Parses `docker image ls --no-trunc --format '{{.Repository}}\t{{.Tag}}\t{{.ID}}'`. */
export function parseImageList(text: string): LocalImage[] {
  return lines(text).flatMap((l) => {
    const [repository, tag, id] = l.split('\t');
    return repository && tag && id && repository !== '<none>' && tag !== '<none>' ? [{ repository, tag, id }] : [];
  });
}

/**
 * Lists the local images and what containers use, removes the old ones.
 * Throws when Docker cannot list them; one image that will not go is a
 * failure in the result, not an exception.
 */
export async function removeOldImages(docker: Runner, groupsFor: (images: LocalImage[]) => ImageGroup[]): Promise<CleanupResult> {
  const result: CleanupResult = { removed: [], bytes: 0, inUse: [], failed: [] };
  const ls = await docker(['image', 'ls', '--no-trunc', '--format', '{{.Repository}}\t{{.Tag}}\t{{.ID}}'], { timeoutMs: 60_000 });
  if (ls.code !== 0) throw new Error(`docker image ls failed: ${ls.stderr.trim() || `exit ${ls.code}`}`);
  const images = parseImageList(ls.stdout);
  const groups = groupsFor(images);
  if (selectOldImages(images, groups, new Set()).remove.length === 0) return result;

  // Every container, stopped ones too: the image it was made from, by name and by id.
  const ps = await docker(['ps', '-a', '--no-trunc', '--format', '{{.ID}}\t{{.Image}}'], { timeoutMs: 60_000 });
  if (ps.code !== 0) throw new Error(`docker ps -a failed: ${ps.stderr.trim() || `exit ${ps.code}`}`);
  const containers = lines(ps.stdout).map((l) => l.split('\t'));
  const usedRefs = new Set(containers.map((c) => c[1] ?? '').filter(Boolean).map((r) => {
    const s = splitImageRef(r);
    return s ? `${s.repository}:${s.tag}` : r;
  }));
  const usedIds = new Set<string>();
  const ids = containers.map((c) => c[0]!).filter(Boolean);
  if (ids.length > 0) {
    const inspect = await docker(['inspect', '--format', '{{.Image}}', ...ids], { timeoutMs: 60_000 });
    if (inspect.code !== 0) throw new Error(`docker inspect of the containers failed: ${inspect.stderr.trim() || `exit ${inspect.code}`}`);
    for (const id of lines(inspect.stdout)) usedIds.add(id);
  }

  const selection = selectOldImages(images, groups, usedIds, usedRefs);
  result.inUse = selection.inUse.map((i) => `${i.repository}:${i.tag}`);
  for (const image of selection.remove) {
    const ref = `${image.repository}:${image.tag}`;
    const size = await docker(['image', 'inspect', '--format', '{{.Size}}', ref], { timeoutMs: 30_000 });
    // Never -f: Docker refuses an image a container still uses.
    const rm = await docker(['image', 'rm', ref], { timeoutMs: 5 * 60_000 });
    if (rm.code !== 0) {
      result.failed.push({ ref, error: (rm.stderr || rm.stdout).trim().split('\n').at(-1) ?? `exit ${rm.code}` });
      continue;
    }
    result.removed.push(ref);
    const bytes = Number(size.stdout.trim());
    if (size.code === 0 && Number.isFinite(bytes)) result.bytes += bytes;
  }
  return result;
}
