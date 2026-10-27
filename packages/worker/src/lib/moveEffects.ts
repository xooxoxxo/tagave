/**
 * What a merge drags along (move-safe scanning §1): sidecar covers and the
 * player's song map.
 */
import type { WorkerContext } from './context.js';
import type { MergeDone } from './fileMerge.js';
import { normKey, relDirname } from './helpers.js';
import { requestPlayerRescan, type WrittenFile } from './playerScan.js';
import type { MoveRecord } from './reconcile.js';

/** A folder that moved as a whole: everything under fromBase now lies under toBase. */
export interface BasePair { fromRootId: string; fromBase: string; toRootId: string; toBase: string }

const parts = (dir: string) => (dir === '' ? [] : dir.split('/'));
const join = (base: string, rest: string) => (base === '' ? rest : `${base}/${rest}`);
const dirKey = (rootId: string, dir: string) => `${rootId}\n${dir}`;
const pairKey = (p: BasePair) => `${p.fromRootId}\n${p.fromBase}\n${p.toRootId}\n${p.toBase}`;
/** True when relPath lies under dir (any depth); '' holds everything. */
const isUnder = (relPath: string, dir: string) => dir === '' || relPath.startsWith(dir + '/');

/**
 * The base levels of one move, deepest first: level 0 is the two folders
 * themselves, and each further level strips one equal (normKey) trailing
 * component from both sides (Album/CD1 -> Album (2001)/CD1 gives
 * Album -> Album (2001)). A move within one folder has no levels.
 */
export function moveBaseLevels(m: MoveRecord): BasePair[] {
  if (m.fromRootId === m.toRootId && m.fromDir === m.toDir) return [];
  const from = parts(m.fromDir); const to = parts(m.toDir);
  const out: BasePair[] = [{ fromRootId: m.fromRootId, fromBase: m.fromDir, toRootId: m.toRootId, toBase: m.toDir }];
  while (from.length > 0 && to.length > 0 && normKey(from[from.length - 1]!) === normKey(to[to.length - 1]!)) {
    from.pop(); to.pop();
    const fromBase = from.join('/'); const toBase = to.join('/');
    if (m.fromRootId === m.toRootId && fromBase === toBase) break;
    out.push({ fromRootId: m.fromRootId, fromBase, toRootId: m.toRootId, toBase });
  }
  return out;
}

/** Every equal trailing component stripped, one pair per distinct result. */
export function moveBasePairs(moves: MoveRecord[]): BasePair[] {
  const out = new Map<string, BasePair>();
  for (const m of moves) {
    const levels = moveBaseLevels(m);
    const top = levels[levels.length - 1];
    if (top) out.set(pairKey(top), top);
  }
  return [...out.values()];
}

const BATCH = 500;

/**
 * Old-side folders that still hold audio: a present or errored row under them
 * that is not one of this run's old rows (those are known gone from there:
 * Tier 1's unseen rows, or missing rows). The gone ids go over once per run,
 * into a temp table with a primary key (dropped at commit) that each probe
 * anti-joins by index: `<> all(array)` is not hashed and compared every row
 * with every id (11 s against 28 ms for 20k gone rows under 50 folders), and a
 * CTE got a nested-loop anti join on the root-top probe. Each nested folder is
 * one range scan of idx_files_relpath_prefix stopping at the first row;
 * the root's top ('') is probed per root. All in one transaction (one session).
 */
async function occupiedDirs(ctx: Pick<WorkerContext, 'sql'>, dirs: Array<{ rootId: string; dir: string }>, goneIds: string[]): Promise<Set<string>> {
  const out = new Set<string>();
  if (dirs.length === 0) return out;
  const rows = await ctx.sql.begin(async (tx) => {
    await tx`create temp table move_gone (id uuid primary key) on commit drop`;
    if (goneIds.length > 0) {
      await tx`insert into move_gone select distinct g.id from unnest(${goneIds}::uuid[]) as g(id)`;
      await tx`analyze move_gone`;
    }
    return (await tx`
      with d as (select * from unnest(${dirs.map((d) => d.rootId)}::uuid[], ${dirs.map((d) => d.dir)}::text[]) as d(root_id, dir))
      select d.root_id, d.dir from d
      cross join lateral (
        select 1 from files a
         where a.scan_root_id = d.root_id
           and a.rel_path ~>=~ (d.dir || '/') and a.rel_path ~<~ (d.dir || '0')
           and a.status in ('present', 'error')
           and not exists (select 1 from move_gone g where g.id = a.id)
         limit 1) x
       where d.dir <> ''
      union all
      select d.root_id, d.dir from d
      cross join lateral (
        select 1 from files a
         where a.scan_root_id = d.root_id and a.status in ('present', 'error')
           and not exists (select 1 from move_gone g where g.id = a.id)
         limit 1) x
       where d.dir = ''`) as unknown as Array<{ root_id: string; dir: string }>;
  }) as unknown as Array<{ root_id: string; dir: string }>;
  for (const r of rows) out.add(dirKey(r.root_id, r.dir));
  return out;
}

/**
 * The base pair each move re-points through: the highest level whose old
 * folders, from level 0 up, hold no audio any more. A folder that still holds
 * audio did not move as a whole (one file moved out of an album, or two roots
 * that mirror each other's tree), so its sidecars stay. One old base claimed
 * by two different new bases (an album split in two) steps those moves down a
 * level; below level 0 the move re-points nothing.
 */
async function chooseBases(ctx: Pick<WorkerContext, 'sql'>, moves: MoveRecord[], goneIds: string[]): Promise<BasePair[]> {
  const levels = moves.map(moveBaseLevels).filter((l) => l.length > 0);
  if (levels.length === 0) return [];
  const probe = new Map<string, { rootId: string; dir: string }>();
  for (const ls of levels) for (const p of ls) probe.set(dirKey(p.fromRootId, p.fromBase), { rootId: p.fromRootId, dir: p.fromBase });
  const occupied = await occupiedDirs(ctx, [...probe.values()], goneIds);
  const chosen = levels.map((ls) => {
    let k = -1;
    while (k + 1 < ls.length && !occupied.has(dirKey(ls[k + 1]!.fromRootId, ls[k + 1]!.fromBase))) k += 1;
    return k;
  });
  const fromOf = (i: number) => { const p = levels[i]![chosen[i]!]!; return dirKey(p.fromRootId, p.fromBase); };
  const toOf = (i: number) => { const p = levels[i]![chosen[i]!]!; return dirKey(p.toRootId, p.toBase); };
  for (let changed = true; changed;) {
    changed = false;
    const targets = new Map<string, Set<string>>();
    for (let i = 0; i < levels.length; i++) {
      if (chosen[i]! < 0) continue;
      const set = targets.get(fromOf(i)) ?? new Set<string>();
      set.add(toOf(i)); targets.set(fromOf(i), set);
    }
    for (let i = 0; i < levels.length; i++) {
      if (chosen[i]! >= 0 && targets.get(fromOf(i))!.size > 1) { chosen[i] = chosen[i]! - 1; changed = true; }
    }
  }
  const out = new Map<string, BasePair>();
  for (let i = 0; i < levels.length; i++) if (chosen[i]! >= 0) { const p = levels[i]![chosen[i]!]!; out.set(pairKey(p), p); }
  return [...out.values()];
}

interface SidecarRow { id: string; scan_root_id: string; rel_path: string }

/**
 * Images of sidecars under each moved folder (any depth, so Album/Scans/ and
 * Album/folder.jpg over CD1/CD2 come along) move to the sidecar at the same
 * relative path under the new folder, so the stale old sidecar can later drop
 * without its cover (the 0052 cascade). Relative paths compare by normKey;
 * two candidates on either side for one name re-point nothing (the image
 * stays on the old sidecar, which is kept while missing rows lie near it).
 * `goneIds` are the run's old rows (runMerges passes them): rows known gone
 * from the old folders, so they do not count as audio still there. Runs inside
 * runMerges, so Tier 1 (finishWalk, before stale sidecars drop) and Tier 2
 * (hold release) both re-point. Returns the number of images re-pointed; a
 * second run with the same moves returns 0. Queries per run, not per move:
 * one folder-occupancy probe, the image-bearing sidecars of the old roots,
 * the candidate sidecars of the new roots, the update.
 */
export async function repointSidecarImages(ctx: Pick<WorkerContext, 'sql'>, moves: MoveRecord[], goneIds: string[] = []): Promise<number> {
  const sql = ctx.sql;
  const bases = await chooseBases(ctx, moves, goneIds);
  if (bases.length === 0) return 0;
  const byFrom = new Map(bases.map((p) => [dirKey(p.fromRootId, p.fromBase), p]));
  const fromRoots = [...new Set(bases.map((p) => p.fromRootId))];
  const olds = (await sql`
    select s.id, s.scan_root_id, s.rel_path from sidecar_files s
     where s.scan_root_id = any(${fromRoots}::uuid[])
       and exists (select 1 from images i where i.sidecar_file_id = s.id)`) as unknown as SidecarRow[];
  // each old sidecar goes through the deepest moved folder holding it
  const groups = new Map<string, { pair: BasePair; target: string; olds: SidecarRow[] }>();
  for (const o of olds) {
    let pair: BasePair | undefined;
    for (let d = relDirname(o.rel_path); ; d = relDirname(d)) {
      pair = byFrom.get(dirKey(o.scan_root_id, d));
      if (pair || d === '') break;
    }
    if (!pair) continue;
    // moved into its own subfolder (Album -> Album/Disc): what is under the new folder is new-side
    const intoSelf = pair.fromRootId === pair.toRootId && pair.toBase !== pair.fromBase && isUnder(pair.toBase, pair.fromBase);
    if (intoSelf && isUnder(o.rel_path, pair.toBase)) continue;
    const rest = pair.fromBase === '' ? o.rel_path : o.rel_path.slice(pair.fromBase.length + 1);
    const k = `${pairKey(pair)}\n${normKey(rest)}`;
    const g = groups.get(k) ?? { pair, target: join(pair.toBase, rest), olds: [] };
    g.olds.push(o); groups.set(k, g);
  }
  if (groups.size === 0) return 0;
  const toRoots = [...new Set([...groups.values()].map((g) => g.pair.toRootId))];
  const folded = [...new Set([...groups.values()].map((g) => normKey(g.target)))];
  // the database's fold narrows the rows; normKey below decides
  const news = (await sql`
    select s.id, s.scan_root_id, s.rel_path from sidecar_files s
     where s.scan_root_id = any(${toRoots}::uuid[]) and lower(normalize(s.rel_path, NFC)) = any(${folded}::text[])`) as unknown as SidecarRow[];
  const newByName = new Map<string, SidecarRow[]>();
  for (const n of news) {
    const k = dirKey(n.scan_root_id, normKey(n.rel_path));
    const list = newByName.get(k);
    if (list) list.push(n); else newByName.set(k, [n]);
  }
  const fromIds: string[] = []; const toIds: string[] = [];
  for (const g of groups.values()) {
    const cands = newByName.get(dirKey(g.pair.toRootId, normKey(g.target)));
    if (g.olds.length !== 1 || !cands || cands.length !== 1 || cands[0]!.id === g.olds[0]!.id) continue;
    fromIds.push(g.olds[0]!.id); toIds.push(cands[0]!.id);
  }
  let moved = 0;
  for (let i = 0; i < fromIds.length; i += BATCH) {
    const r = await sql`
      update images i set sidecar_file_id = u.to_id
        from unnest(${fromIds.slice(i, i + BATCH)}::uuid[], ${toIds.slice(i, i + BATCH)}::uuid[]) as u(from_id, to_id)
       where i.sidecar_file_id = u.from_id
      returning i.id`;
    moved += r.length;
  }
  return moved;
}

const baseName = (relPath: string) => relPath.slice(relPath.lastIndexOf('/') + 1);

/**
 * The folder pair the player re-reads for each merge: the file's own two
 * folders, except that sibling folders moving together under one parent
 * (Album/CD1 and Album/CD2 -> Album (2001)/CD1 and /CD2) are asked for once,
 * as the parent pair, since the player scans a folder with its subfolders.
 * A parent that is a root's top stays split: '' would be a full scan.
 */
function playerFolderPairs(merges: MergeDone[]): BasePair[] {
  const own = merges.map((m): MoveRecord => ({
    fromRootId: m.from.scanRootId, fromDir: relDirname(m.from.relPath), toRootId: m.to.scanRootId, toDir: relDirname(m.to.relPath), files: 1,
  }));
  const ownKey = (r: MoveRecord) => `${r.fromRootId}\n${r.fromDir}\n${r.toRootId}\n${r.toDir}`;
  const parentOf = (r: MoveRecord) => {
    const up = moveBaseLevels(r)[1];
    return up && up.fromBase !== '' && up.toBase !== '' ? up : undefined;
  };
  const siblings = new Map<string, Set<string>>();
  for (const r of own) {
    const up = parentOf(r);
    if (!up) continue;
    const set = siblings.get(pairKey(up)) ?? new Set<string>();
    set.add(ownKey(r)); siblings.set(pairKey(up), set);
  }
  return own.map((r) => {
    const up = parentOf(r);
    if (up && siblings.get(pairKey(up))!.size > 1) return up;
    return { fromRootId: r.fromRootId, fromBase: r.fromDir, toRootId: r.toRootId, toBase: r.toDir };
  });
}

/**
 * The player after a move. The worker never holds the player's address, so "the module is
 * on" is read from the module's own table: tracks the player mapped. Those
 * map rows name songs at the old path; they are dropped (the app re-matches
 * on the next play, so play never hits a dead song id) and the player is
 * asked to re-read the old and the new folder. No map rows: nothing happens.
 * Returns true when the player was asked.
 */
export async function refreshPlayerAfterMoves(ctx: Pick<WorkerContext, 'db' | 'sql' | 'boss' | 'logger'>, merges: MergeDone[]): Promise<boolean> {
  if (merges.length === 0) return false;
  const fileIds = [...new Set(merges.map((m) => m.oldId))];
  let roots: Map<string, string>;
  try {
    const mapped = await ctx.sql`
      select 1 from player_track_map p join local_tracks lt on lt.id = p.local_track_id
       where lt.audio_file_id = any(${fileIds}::uuid[]) limit 1`;
    if (mapped.length === 0) return false;
    const rootIds = [...new Set(merges.flatMap((m) => [m.from.scanRootId, m.to.scanRootId]))];
    roots = new Map((await ctx.sql`select id, path from scan_roots where id = any(${rootIds}::uuid[])`).map((r) => [r['id'] as string, r['path'] as string]));
  } catch (error) {
    // The merges are committed, so a failed probe must not fail the reconcile. The
    // stale map rows stay: the app's albumQueue only re-matches tracks without a
    // row, so until a later refresh of these files drops them (their next move or
    // tag write) play may hit the old song id.
    ctx.logger.warn({ error: String(error) }, 'files.reconcile: could not check the player map after moves');
    return false;
  }
  const pairs = playerFolderPairs(merges);
  // requestPlayerRescan scans the folder each file is in: each file is placed in its chosen folder
  const files: WrittenFile[] = [];
  merges.forEach((m, i) => {
    const p = pairs[i]!;
    files.push(
      { libraryId: m.libraryId, fileId: m.oldId, scanRootPath: roots.get(p.fromRootId) ?? '', relPath: join(p.fromBase, baseName(m.from.relPath)) },
      { libraryId: m.libraryId, fileId: m.oldId, scanRootPath: roots.get(p.toRootId) ?? '', relPath: join(p.toBase, baseName(m.to.relPath)) },
    );
  });
  await requestPlayerRescan(ctx, files);
  return true;
}

/**
 * After a failed cover re-point: queue art.fetch for the albums of the moved
 * files, so each cover comes back from the new folder's sidecar on its own.
 * An album whose front cover still points at an old folder's sidecar (the
 * failed re-point left it there, and that stale sidecar will drop later) gets
 * a refresh, which rebuilds that same row from the album's current folders;
 * a plain art.fetch would see a front cover and stop. An album with no front
 * cover gets the album page's "Fetch art" job as it is. A crash between the
 * merges and the re-point queues nothing: those covers stay a manual
 * "Fetch art" (rare). Job keys match artFetch.ts (art:<id>, artRefreshKey).
 */
export async function queueArtAfterRepointFailure(
  ctx: Pick<WorkerContext, 'sql' | 'boss'>, movedFileIds: string[],
): Promise<string[]> {
  if (movedFileIds.length === 0) return [];
  const rows = (await ctx.sql`
    select a.id, f.origin as "frontOrigin"
      from (select distinct lt.local_album_id as id from local_tracks lt
             where lt.audio_file_id = any(${movedFileIds}::uuid[]) and lt.local_album_id is not null) a
      left join images f on f.local_album_id = a.id and f.kind = 'front'`) as unknown as Array<{ id: string; frontOrigin: string | null }>;
  const queued: string[] = [];
  for (const r of rows) {
    if (r.frontOrigin === null) {
      await ctx.boss.send('art.fetch', { localAlbumId: r.id }, { singletonKey: `art:${r.id}` });
    } else if (r.frontOrigin === 'sidecar') {
      await ctx.boss.send('art.fetch', { localAlbumId: r.id, refresh: true }, { singletonKey: `artRefresh:${r.id}` });
    } else continue; // embedded, provider or the owner's: no sidecar to lose
    queued.push(r.id);
  }
  return queued;
}
