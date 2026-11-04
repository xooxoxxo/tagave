/**
 * Naming rules and the drop pool as a library keeps them (libraries.settings
 * naming, dropPool; vault "tagave - Naming Rules and Drop Pool"), and the
 * file-system helpers organize and import share: an album folder's other
 * files, the folders a move empties.
 */
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { DEFAULT_NAMING_RULES, rulesProblems, type NamingRules } from '@tagave/core';
import { handlerForName } from '@tagave/core/files';
import { TRASH_DIR, namingRulesSchema } from '@tagave/shared';
import type { WorkerContext } from './context.js';
import { skipDir } from './helpers.js';

export interface DropPool {
  enabled: boolean;
  scanRootId: string | null;
  dirPath: string | null;
}

async function settingsOf(ctx: Pick<WorkerContext, 'sql'>, libraryId: string): Promise<Record<string, unknown>> {
  const [r] = (await ctx.sql`select settings from libraries where id = ${libraryId}`) as unknown as Array<{ settings: unknown }>;
  const s = typeof r?.settings === 'string' ? JSON.parse(r.settings) : r?.settings;
  return s && typeof s === 'object' ? (s as Record<string, unknown>) : {};
}

/** The library's saved rules (saved: true), or the default ones. Rules that no longer validate are the default. */
export async function namingRulesFor(ctx: Pick<WorkerContext, 'sql'>, libraryId: string): Promise<{ rules: NamingRules; saved: boolean }> {
  const parsed = namingRulesSchema.safeParse((await settingsOf(ctx, libraryId))['naming']);
  if (parsed.success && Object.keys(rulesProblems(parsed.data)).length === 0) return { rules: parsed.data, saved: true };
  return { rules: DEFAULT_NAMING_RULES, saved: false };
}

export function dropPoolFrom(settings: Record<string, unknown>): DropPool {
  const p = (settings['dropPool'] ?? {}) as Partial<DropPool>;
  return {
    enabled: p.enabled === true,
    scanRootId: typeof p.scanRootId === 'string' ? p.scanRootId : null,
    dirPath: typeof p.dirPath === 'string' && p.dirPath ? p.dirPath : null,
  };
}

export async function dropPoolOf(ctx: Pick<WorkerContext, 'sql'>, libraryId: string): Promise<DropPool> {
  return dropPoolFrom(await settingsOf(ctx, libraryId));
}

/**
 * The pool folders inside one music folder (relative to it), on or off: the
 * scan never walks them, so their files never reach the library until
 * imported.
 */
export async function poolDirsOfRoot(ctx: Pick<WorkerContext, 'sql'>, scanRootId: string): Promise<string[]> {
  const rows = (await ctx.sql`
    select l.settings->'dropPool'->>'dirPath' as dir
      from libraries l join scan_roots sr on sr.library_id = l.id
     where sr.id = ${scanRootId}
       and jsonb_typeof(l.settings) = 'object'
       and l.settings->'dropPool'->>'scanRootId' = ${scanRootId}`) as unknown as Array<{ dir: string | null }>;
  return rows.map((r) => (r.dir ?? '').normalize('NFC').replace(/^\/+|\/+$/g, '')).filter(Boolean);
}

/** A rel path inside (or equal to) one of the folders. */
export const insideAny = (rel: string, dirs: readonly string[]): boolean =>
  dirs.some((d) => rel === d || rel.startsWith(`${d}/`));

export const isAudioName = (name: string): boolean => handlerForName(name)?.id === 'audio';

/** Every file under a folder (relative to the root), skipping what the scan skips. */
export async function filesUnder(root: string, dir: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (rel: string) => {
    let entries;
    try {
      entries = await readdir(path.join(root, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (!skipDir(e.name)) await walk(r);
      } else if (e.isFile()) {
        out.push(r.normalize('NFC'));
      }
    }
  };
  await walk(dir);
  return out;
}

/**
 * The companion files of an album folder that go with its songs: every file
 * under `albumDir` that is not audio, kept at its place relative to the
 * folder. A subfolder that holds songs not in the move (another album) keeps
 * its files. Nothing goes when songs stay behind in the folder itself.
 */
export async function companionFiles(root: string, albumDir: string, moving: ReadonlySet<string>, toDir: string): Promise<Array<{ fromPath: string; toPath: string }>> {
  if (albumDir === '') return [];
  const all = await filesUnder(root, albumDir);
  const staysDirs = new Set<string>();
  for (const f of all) {
    if (isAudioName(path.posix.basename(f)) && !moving.has(f)) staysDirs.add(path.posix.dirname(f));
  }
  if (staysDirs.has(albumDir)) return [];
  const blocked = (f: string) => [...staysDirs].some((d) => f === d || f.startsWith(`${d}/`));
  return all
    .filter((f) => !isAudioName(path.posix.basename(f)) && !blocked(path.posix.dirname(f)))
    .map((f) => ({ fromPath: f, toPath: `${toDir}/${f.slice(albumDir.length + 1)}`.normalize('NFC') }));
}

/** The folder the songs of an album share: their deepest common folder, a disc folder ("CD1") counting as its album's. */
export function albumDirOf(relPaths: readonly string[], discDir: (base: string) => boolean): string {
  const dirs = relPaths.map((p) => path.posix.dirname(p)).map((d) => (d === '.' ? '' : d));
  if (dirs.length === 0) return '';
  let common = dirs[0]!.split('/');
  for (const d of dirs.slice(1)) {
    const parts = d.split('/');
    let i = 0;
    while (i < common.length && i < parts.length && common[i] === parts[i]) i++;
    common = common.slice(0, i);
  }
  let dir = common.join('/');
  if (dir && discDir(path.posix.basename(dir))) dir = path.posix.dirname(dir) === '.' ? '' : path.posix.dirname(dir);
  return dir;
}

/** Holds no file at any depth (only empty folders). */
export async function emptyTree(abs: string): Promise<boolean> {
  let entries;
  try {
    entries = await readdir(abs, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const e of entries) {
    if (!e.isDirectory()) return false;
    if (!(await emptyTree(path.join(abs, e.name)))) return false;
  }
  return true;
}

/**
 * The highest folder from `dir` up that a move left empty: its parents go
 * too while they hold nothing else ("Fiona Apple/when the pawn" and then
 * "Fiona Apple"). Never the root, the trash, a kept folder (the pool) or one
 * of its parents. Null when `dir` itself holds a file.
 */
export async function highestEmpty(root: string, dir: string, keep: readonly string[]): Promise<string | null> {
  const kept = (d: string) => d === '' || d === TRASH_DIR || d.startsWith(`${TRASH_DIR}/`) || keep.some((k) => k === d || k.startsWith(`${d}/`));
  if (kept(dir) || !(await emptyTree(path.join(root, dir)))) return null;
  let top = dir;
  for (let up = path.posix.dirname(top); up !== '.' && !kept(up); up = path.posix.dirname(up)) {
    if (!(await emptyTree(path.join(root, up)))) break;
    top = up;
  }
  return top;
}
