/**
 * Naming rules, Library care › Organize, the drop pool and its Inbox (0081,
 * vault "tagave - Naming Rules and Drop Pool"). Owner only (system.manage):
 * each of them moves files in the music folder. The API never touches a
 * music file; the file worker (files.move) and the pool's watcher
 * (pool.scan) do.
 *
 *   GET  /libraries/:id/naming             NamingView
 *   PUT  /libraries/:id/naming             { rules }
 *   POST /libraries/:id/naming/examples    { rules } → { examples, problems }
 *   GET  /libraries/:id/drop-pool          DropPoolView
 *   PUT  /libraries/:id/drop-pool          { enabled, scanRootId?, dirPath? }
 *   GET  /libraries/:id/organize           OrganizeView
 *   POST /libraries/:id/organize           { albumIds } → { queued }
 *   GET  /libraries/:id/inbox              { items: InboxItem[] }
 *   POST /libraries/:id/inbox/:itemId      InboxAction → InboxItem
 *   POST /libraries/:id/tag-plans/:planId/organize   { on } (a draft or previewed plan, previewed again)
 */
import path from 'node:path';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { ruleDir, rulesProblems, samePath, type NamingRules } from '@tagave/core';
import {
  DROP_POOL_DEFAULT_DIR, DROP_POOL_STATES, TRASH_DIR, inboxActionSchema, organizeRequestSchema, putDropPoolSchema, putNamingSchema, namingRulesSchema,
  type DropPoolState, type DropPoolStatus, type DropPoolView, type InboxItem, type InboxReason, type NamingView, type OrganizeAlbum, type OrganizeView,
  type PoolCandidate, type PoolFile, type PoolPairing, type PoolState,
} from '@tagave/shared';
import { getSql } from '../db.js';
import { getBoss } from '../boss.js';
import { ApiError } from '../middleware/errorHandler.js';
import {
  albumRulePaths, albumsWithFiles, detectLibraryNaming, dropPoolSetting, namingExamples, namingSettings, saveSetting, settingsOf,
} from '../lib/naming.js';

const OWNER = { config: { permission: 'system.manage' as const } };

function parse<T extends z.ZodType>(schema: T, body: unknown): z.infer<T> {
  const parsed = schema.safeParse(body ?? {});
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new ApiError(400, 'Bad Request', issue ? `${issue.path.join('.') || 'body'}: ${issue.message}` : 'Invalid body');
  }
  return parsed.data;
}

const paramsOf = (request: FastifyRequest) => request.params as { libraryId: string; itemId?: string; planId?: string };

async function send(queue: string, data: object, singletonKey: string): Promise<void> {
  const boss = await getBoss();
  await boss.createQueue(queue);
  await boss.send(queue, data, { singletonKey });
}

async function namingView(libraryId: string): Promise<NamingView> {
  const sql = getSql();
  const { rules, saved } = await namingSettings(sql, libraryId);
  let shown = rules;
  let detected: NamingView['detected'] = null;
  if (!saved) {
    const d = await detectLibraryNaming(sql, libraryId);
    shown = d.rules;
    detected = { matched: d.matched, sampled: d.sampled, found: d.detected };
  }
  return { rules: shown, saved, detected, examples: await namingExamples(sql, libraryId, shown), problems: rulesProblems(shown) };
}

/** A pool folder: relative, inside the music folder, not hidden, not the trash. */
function poolDirProblem(dir: string): string | null {
  const d = dir.normalize('NFC').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  if (!d) return 'Pick a folder inside the music folder';
  if (d.split('/').some((p) => p === '..' || p === '.' || p === '')) return 'The folder must be inside the music folder';
  if (d.split('/').some((p) => p.startsWith('.'))) return 'Not a hidden folder';
  if (d === TRASH_DIR || d.startsWith(`${TRASH_DIR}/`)) return 'Not the trash';
  return null;
}

/** What pool.scan last found for this pool (dropPoolStatus), when it was about this very folder. */
function poolStateOf(settings: Record<string, unknown>, pool: { scanRootId: string | null; dirPath: string | null }): DropPoolState | null {
  const s = settings['dropPoolStatus'] as Partial<DropPoolStatus> | undefined;
  if (!s || !pool.scanRootId || s.scanRootId !== pool.scanRootId || s.dirPath !== pool.dirPath) return null;
  return DROP_POOL_STATES.includes(s.state as DropPoolState) ? (s.state as DropPoolState) : null;
}

async function dropPoolView(libraryId: string): Promise<DropPoolView> {
  const sql = getSql();
  const settings = await settingsOf(sql, libraryId);
  const pool = dropPoolSetting(settings);
  const roots = await sql<Array<{ id: string; path: string; hostPath: string | null }>>`
    select id::text as id, path, host_path as "hostPath" from scan_roots
     where library_id = ${libraryId} and enabled and writable order by created_at, id`;
  const root = roots.find((r) => r.id === pool.scanRootId) ?? null;
  const [counts] = await sql<Array<{ waiting: number; inbox: number; imported: number; skipped: number }>>`
    select count(*) filter (where state in ('waiting', 'identifying', 'importing'))::int as waiting,
           count(*) filter (where state = 'inbox')::int as inbox,
           count(*) filter (where state = 'imported')::int as imported,
           count(*) filter (where state = 'skipped')::int as skipped
      from pool_items where library_id = ${libraryId}`;
  const join = (base: string | null, dir: string | null) => (base && dir ? path.posix.join(base, dir) : null);
  return {
    enabled: pool.enabled && !!root,
    scanRootId: pool.scanRootId,
    dirPath: pool.dirPath,
    path: join(root?.path ?? null, pool.dirPath),
    hostPath: join(root?.hostPath ?? null, pool.dirPath),
    roots: roots.map((r) => ({ id: r.id, path: r.path })),
    counts: counts ?? { waiting: 0, inbox: 0, imported: 0, skipped: 0 },
    problem: roots.length === 0 ? 'No writable music folder' : null,
    state: pool.enabled && root ? poolStateOf(settings, pool) : null,
  };
}

/** Library care › Organize: the albums whose files the rules put elsewhere. */
async function organizeView(libraryId: string): Promise<OrganizeView> {
  const sql = getSql();
  const { rules, saved } = await namingSettings(sql, libraryId);
  const pool = dropPoolSetting(await settingsOf(sql, libraryId));
  const albums = await albumsWithFiles(sql, libraryId);
  const wrongFolder: OrganizeAlbum[] = [];
  const wrongNames: OrganizeAlbum[] = [];
  let inPlace = 0;
  let leftAlone = 0;
  const MAX = 500;
  for (const a of albums) {
    if (a.files.length === 0) continue;
    if (pool.dirPath && a.files.some((f) => f.relPath === pool.dirPath || f.relPath.startsWith(`${pool.dirPath}/`))) continue;
    const planned = albumRulePaths(rules, a);
    if (planned.leftAlone) { leftAlone++; continue; }
    const moved = planned.files.filter((f) => !samePath(f.relPath, f.toPath));
    if (moved.length === 0) { inPlace++; continue; }
    const dirOf = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
    const dirCount = new Map<string, number>();
    for (const f of planned.files) dirCount.set(dirOf(f.relPath), (dirCount.get(dirOf(f.relPath)) ?? 0) + 1);
    const fromDir = [...dirCount.entries()].sort((x, y) => y[1] - x[1])[0]![0];
    const folderMoves = planned.files.some((f) => !samePath(dirOf(f.relPath), dirOf(f.toPath)));
    const row: OrganizeAlbum = {
      albumId: a.albumId, title: a.title ?? 'Untitled', artist: a.artist, fromDir, toDir: planned.dir,
      files: planned.files.length,
      renamed: planned.files.filter((f) => !samePath(path.posix.basename(f.relPath), path.posix.basename(f.toPath))).length,
      sample: { from: moved[0]!.relPath, to: moved[0]!.toPath },
    };
    (folderMoves ? wrongFolder : wrongNames).push(row);
  }
  const byPath = (x: OrganizeAlbum, y: OrganizeAlbum) => x.fromDir.localeCompare(y.fromDir);
  return {
    saved,
    wrongFolder: wrongFolder.sort(byPath).slice(0, MAX),
    wrongNames: wrongNames.sort(byPath).slice(0, MAX),
    inPlace,
    leftAlone,
    truncated: wrongFolder.length > MAX || wrongNames.length > MAX,
  };
}

interface PoolRow {
  id: string; state: PoolState; reason: InboxReason | null; dirPath: string; files: PoolFile[] | null; candidates: PoolCandidate[] | null;
  bestReleaseId: string | null; pairing: PoolPairing[] | null; existingAlbumId: string | null; moveId: string | null; error: string | null;
  updatedAt: Date | string; exTitle: string | null; exArtist: string | null; exDirs: string[] | null;
}

async function inboxItems(libraryId: string, itemId?: string): Promise<InboxItem[]> {
  const sql = getSql();
  const pool = dropPoolSetting(await settingsOf(sql, libraryId));
  const { rules } = await namingSettings(sql, libraryId);
  const rows = await sql<PoolRow[]>`
    select p.id::text as id, p.state, p.reason, p.dir_path as "dirPath", p.files, p.candidates, p.best_release_id::text as "bestReleaseId",
           p.pairing, p.existing_album_id::text as "existingAlbumId", p.move_id::text as "moveId", p.error, p.updated_at as "updatedAt",
           la.title_guess as "exTitle", la.artist_guess as "exArtist", la.dir_paths as "exDirs"
      from pool_items p left join local_albums la on la.id = p.existing_album_id
     where p.library_id = ${libraryId}
       and (${itemId ?? null}::uuid is null or p.id = ${itemId ?? null}::uuid)
       and (${itemId ?? null}::uuid is not null or p.state <> 'imported' or p.updated_at > now() - interval '1 day')
     order by (p.state = 'inbox') desc, p.updated_at desc
     limit 300`;
  return rows.map((r) => {
    const candidates = r.candidates ?? [];
    const best = candidates.find((c) => c.releaseId === r.bestReleaseId) ?? candidates[0] ?? null;
    const folder = pool.dirPath && r.dirPath.startsWith(`${pool.dirPath}/`) ? r.dirPath.slice(pool.dirPath.length + 1) : r.dirPath;
    const toDir = best ? ruleDir(rules as NamingRules, {
      albumartist: best.artist, artist: best.artist, album: best.title, title: null, year: best.year, disc: null, discs: 1, track: null, ext: '',
      compilation: /^various artists$/i.test(best.artist), soundtrack: false,
    }).dir : null;
    return {
      id: r.id, state: r.state, reason: r.reason, folder,
      files: (r.files ?? []).length, best, candidates, pairing: r.pairing ?? [],
      existing: r.existingAlbumId ? { albumId: r.existingAlbumId, title: r.exTitle ?? 'Untitled', artist: r.exArtist, folder: r.exDirs?.[0] ?? null } : null,
      toDir, moveId: r.moveId, error: r.error, updatedAt: new Date(r.updatedAt).toISOString(),
    };
  });
}

/** An import of a pool item as a release (Accept, Pick, Replace, Keep both): the file worker plans and moves it. */
async function queueImport(libraryId: string, itemId: string, release: { releaseId?: string; releaseMbid?: string }, existing: 'replace' | 'keepBoth' | null, userId: string): Promise<void> {
  const sql = getSql();
  const [row] = await sql<Array<{ id: string }>>`
    insert into album_moves (library_id, kind, source_track_ids, release_id, state, query, created_by)
    values (${libraryId}, 'import', '{}'::uuid[], ${release.releaseId ?? null}::uuid, 'planning',
            ${JSON.stringify({ poolItemId: itemId, ...release, ...(existing ? { existing } : {}) })}::jsonb, ${userId})
    returning id::text as id`;
  const claimed = await sql`
    update pool_items set state = 'importing', move_id = ${row!.id}, error = null, decided_at = now(), updated_at = now()
     where id = ${itemId} and library_id = ${libraryId} and state in ('inbox', 'skipped') returning id`;
  if (claimed.length === 0) {
    await sql`delete from album_moves where id = ${row!.id}`;
    throw new ApiError(409, 'Conflict', 'This album is not waiting for you now');
  }
  await send('files.move', { moveId: row!.id, action: 'plan' }, `files.move:${row!.id}:plan`);
}

export async function createNamingRoutes(fastify: FastifyInstance) {
  fastify.get('/libraries/:libraryId/naming', OWNER, async (request) => namingView(paramsOf(request).libraryId));

  fastify.put('/libraries/:libraryId/naming', OWNER, async (request) => {
    const { libraryId } = paramsOf(request);
    const { rules } = parse(putNamingSchema, request.body);
    const problems = rulesProblems(rules);
    if (Object.keys(problems).length) throw new ApiError(400, 'Bad Request', Object.entries(problems).map(([k, v]) => `${k}: ${v}`).join('; '));
    await saveSetting(getSql(), libraryId, 'naming', rules);
    return namingView(libraryId);
  });

  fastify.post('/libraries/:libraryId/naming/examples', OWNER, async (request) => {
    const { libraryId } = paramsOf(request);
    const { rules } = parse(z.object({ rules: namingRulesSchema }).strict(), request.body);
    const problems = rulesProblems(rules);
    return { problems, examples: Object.keys(problems).length ? [] : await namingExamples(getSql(), libraryId, rules) };
  });

  fastify.get('/libraries/:libraryId/drop-pool', OWNER, async (request) => dropPoolView(paramsOf(request).libraryId));

  fastify.put('/libraries/:libraryId/drop-pool', OWNER, async (request) => {
    const { libraryId } = paramsOf(request);
    const body = parse(putDropPoolSchema, request.body);
    const sql = getSql();
    const current = dropPoolSetting(await settingsOf(sql, libraryId));
    if (!body.enabled) {
      await saveSetting(sql, libraryId, 'dropPool', { ...current, enabled: false });
      return dropPoolView(libraryId);
    }
    const roots = await sql<Array<{ id: string }>>`
      select id::text as id from scan_roots where library_id = ${libraryId} and enabled and writable order by created_at, id`;
    const rootId = body.scanRootId ?? current.scanRootId ?? roots[0]?.id ?? null;
    if (!rootId || !roots.some((r) => r.id === rootId)) throw new ApiError(409, 'Conflict', 'The pool needs a writable music folder');
    const dirPath = (body.dirPath ?? current.dirPath ?? DROP_POOL_DEFAULT_DIR).normalize('NFC').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
    const problem = poolDirProblem(dirPath);
    if (problem) throw new ApiError(400, 'Bad Request', problem);
    // a folder that holds library albums cannot become the pool (they would leave the library)
    const like = `${dirPath.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')}/%`;
    const [held] = await sql<Array<{ n: number }>>`
      select count(*)::int as n from files where scan_root_id = ${rootId} and status = 'present' and rel_path like ${like}`;
    if ((held?.n ?? 0) > 0) throw new ApiError(409, 'Conflict', 'That folder holds songs of the library');
    await saveSetting(sql, libraryId, 'dropPool', { enabled: true, scanRootId: rootId, dirPath });
    // the worker makes the folder and takes a first look
    await send('pool.scan', { libraryId, create: true }, `pool.scan:${libraryId}`);
    return dropPoolView(libraryId);
  });

  fastify.get('/libraries/:libraryId/organize', OWNER, async (request) => organizeView(paramsOf(request).libraryId));

  fastify.post('/libraries/:libraryId/organize', OWNER, async (request, reply) => {
    const { libraryId } = paramsOf(request);
    const { albumIds } = parse(organizeRequestSchema, request.body);
    const sql = getSql();
    const { rules } = await namingSettings(sql, libraryId);
    const albums = await albumsWithFiles(sql, libraryId, { albumIds: [...new Set(albumIds)] });
    let queued = 0;
    for (const a of albums) {
      const planned = albumRulePaths(rules, a);
      if (planned.leftAlone || planned.files.every((f) => samePath(f.relPath, f.toPath))) continue;
      // one at a time per album: a move already waiting for this album's files is left to finish
      const busy = await sql`
        select 1 from album_moves where library_id = ${libraryId} and kind = 'organize' and state in ('planning', 'moving')
           and query->'fileIds' ?| ${a.files.map((f) => f.fileId)}::text[] limit 1`;
      if (busy.length) continue;
      const [row] = await sql<Array<{ id: string }>>`
        insert into album_moves (library_id, kind, source_album_id, source_track_ids, state, query, created_by)
        values (${libraryId}, 'organize', ${a.albumId}, '{}'::uuid[], 'planning', ${JSON.stringify({ fileIds: a.files.map((f) => f.fileId) })}::jsonb, ${request.user!.id})
        returning id::text as id`;
      await send('files.move', { moveId: row!.id, action: 'plan' }, `files.move:${row!.id}:plan`);
      queued++;
    }
    reply.status(202);
    return { queued };
  });

  fastify.get('/libraries/:libraryId/inbox', OWNER, async (request) => ({ items: await inboxItems(paramsOf(request).libraryId) }));

  fastify.post('/libraries/:libraryId/inbox/:itemId', OWNER, async (request, reply) => {
    const { libraryId, itemId } = paramsOf(request);
    const body = parse(inboxActionSchema, request.body);
    const sql = getSql();
    const [item] = await sql<Array<{ state: PoolState; reason: InboxReason | null; bestReleaseId: string | null; existingAlbumId: string | null }>>`
      select state, reason, best_release_id::text as "bestReleaseId", existing_album_id::text as "existingAlbumId"
        from pool_items where id = ${itemId!} and library_id = ${libraryId}`;
    if (!item) throw new ApiError(404, 'Not Found', 'No such album in the pool');
    if (body.action === 'skip') {
      const done = await sql`update pool_items set state = 'skipped', decided_at = now(), updated_at = now()
                              where id = ${itemId!} and state in ('inbox', 'waiting') returning id`;
      if (done.length === 0) throw new ApiError(409, 'Conflict', 'This album is not waiting for you now');
    } else if (body.action === 'pick') {
      await queueImport(libraryId, itemId!, { releaseMbid: body.releaseMbid }, null, request.user!.id);
    } else {
      if (!item.bestReleaseId) throw new ApiError(409, 'Conflict', 'No release found: pick one');
      const existing = body.action === 'replace' ? 'replace' : body.action === 'keepBoth' ? 'keepBoth' : null;
      if (body.action === 'accept' && item.reason === 'in_library') throw new ApiError(409, 'Conflict', 'Already in the library: Replace or Keep both');
      if (existing && !item.existingAlbumId) throw new ApiError(409, 'Conflict', 'Not in the library');
      await queueImport(libraryId, itemId!, { releaseId: item.bestReleaseId }, existing, request.user!.id);
    }
    reply.status(202);
    const [view] = await inboxItems(libraryId, itemId!);
    return view;
  });

  /** A plan's "Organize files" switch: the plan is previewed again with it. */
  fastify.post('/libraries/:libraryId/tag-plans/:planId/organize', OWNER, async (request, reply) => {
    const { libraryId, planId } = paramsOf(request);
    const { on } = parse(z.object({ on: z.boolean() }).strict(), request.body);
    const updated = await getSql()`
      update tag_plans set policy = policy || jsonb_build_object('organize', ${on}::boolean), status = 'draft'
       where id = ${planId!} and library_id = ${libraryId} and status in ('draft', 'previewed')
         and coalesce(policy->>'preset', '') <> 'revert'
      returning id`;
    if (updated.length === 0) throw new ApiError(409, 'Conflict', 'Only a plan not applied yet can change');
    await send('tags.preview', { planId }, `tag_plan:${planId}`);
    reply.status(202);
    return { organize: on };
  });
}
