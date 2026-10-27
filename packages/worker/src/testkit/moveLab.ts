/**
 * Acceptance harness for move-safe scanning: a library with temp roots of
 * real FLAC files, scans run through the real jobs, and the jobs they send
 * (scan.parse, cluster.dir) drained inline by drainJobs. snapshot() records
 * every id the spec says a move must keep; expectKept() compares two of them.
 */
import { mkdtemp, mkdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { expect } from 'vitest';
import pino from 'pino';
import { makeDb } from '@tagave/db';
import type { WorkerContext } from '../lib/context.js';
import { sqlDirname } from '../lib/helpers.js';
import { writeFlac } from './flac.js';
import { scanRootJob, type ScanRootJobData } from '../jobs/scanRoot.js';
import { scanParseJob } from '../jobs/scanParse.js';
import { clusterDirJob } from '../jobs/clusterDir.js';

export interface Sent { name: string; data: any; opts?: any }
export interface Snapshot {
  counts: { files: number; albums: number; tracks: number };
  /** each file row and where it sits (root index into lab.roots, rel_path) */
  files: Array<{ id: string; root: number; relPath: string; status: string }>;
  tracks: Array<{ id: string; fileId: string; albumId: string | null; canonical: string | null }>;
  albums: Array<{ id: string; state: string; releaseId: string | null }>;
  owner: Record<string, unknown>;
}

const PUMPED = new Set(['scan.parse', 'cluster.dir']);

/**
 * The job pump: runs the scan.parse and cluster.dir jobs a stubbed boss
 * queued, in rounds, until none are left (follow-up re-clusters included).
 * Each round runs its scan.parse jobs in order, then its cluster.dir jobs once
 * per folder (the real queue's singleton key). Every other job, and with
 * `only` any pumped job not named there, stays queued in its order. Throws if
 * the jobs keep queueing more after 20 rounds.
 */
export async function drainJobs(ctx: WorkerContext, queue: Sent[], opts: { only?: string[] } = {}): Promise<void> {
  const runs = (name: string) => PUMPED.has(name) && (!opts.only || opts.only.includes(name));
  const kept: Sent[] = [];
  for (let round = 0; round < 20 && queue.some((j) => runs(j.name)); round++) {
    const batch = queue.splice(0);
    for (const j of batch) if (!runs(j.name)) kept.push(j);
    for (const j of batch) if (j.name === 'scan.parse' && runs(j.name)) await scanParseJob(ctx, j.data);
    const once = new Map<string, any>();
    for (const j of batch) if (j.name === 'cluster.dir' && runs(j.name)) once.set(`${j.data.scanRootId}\n${j.data.dirPath}`, j.data);
    for (const d of once.values()) await clusterDirJob(ctx, d);
  }
  const left = queue.filter((j) => runs(j.name)).length;
  const rest = queue.splice(0);
  for (const j of kept) queue.push(j);
  for (const j of rest) queue.push(j);
  if (left > 0) throw new Error(`drainJobs: ${left} scan.parse/cluster.dir job(s) still queued after 20 rounds`);
}

/** SQL: the parent folder of a folder expression ('' for a top-level folder). */
function parentOf(dirExpr: string): string {
  return `(case when strpos(${dirExpr}, '/') = 0 then '' else regexp_replace(${dirExpr}, '/[^/]*$', '') end)`;
}

/** A file or folder move: every file at or under `from` (root index, rel path) sits under `to` after it. */
export interface PathMove { from: [number, string]; to: [number, string] }

/** Where `before`'s files must sit after the moves (files no move covers stay put). */
export function expectedFiles(before: Snapshot, moves: PathMove[]): Snapshot['files'] {
  return before.files.map((f) => {
    for (const m of moves) {
      const [root, prefix] = m.from;
      if (f.root !== root) continue;
      if (f.relPath === prefix) return { ...f, root: m.to[0], relPath: m.to[1] };
      if (f.relPath.startsWith(`${prefix}/`)) return { ...f, root: m.to[0], relPath: `${m.to[1]}${f.relPath.slice(prefix.length)}` };
    }
    return f;
  });
}

let clock = Math.floor(Date.now() / 1000) + 10;
/** Directory mtimes have one-second resolution; quick scans need them to move. */
export async function bumpDir(abs: string): Promise<void> {
  clock += 5;
  await utimes(abs, clock, clock);
}

export async function makeLab(rootCount = 1) {
  const made = await makeDb(process.env.TEST_DATABASE_URL!);
  const sql: any = made.client; // untyped rows, as in the db tests
  const sent: Sent[] = [];
  const ctx: WorkerContext = {
    db: made.db, sql,
    boss: { send: async (name: string, data: unknown, opts: unknown) => { sent.push({ name, data, opts }); return randomUUID(); } } as any,
    logger: pino({ level: 'silent' }),
  };
  const userId = randomUUID(); const libraryId = randomUUID();
  const roots: Array<{ id: string; path: string }> = [];
  let base: string | null = null;
  try {
    await sql`insert into users (id, email, password_hash) values (${userId}, ${`lab-${userId}@test.com`}, 'x')`;
    await sql`insert into libraries (id, name, owner_user_id, settings) values (${libraryId}, 'Lab', ${userId}, '{}')`;
    base = await mkdtemp(path.join(tmpdir(), 'tagave-lab-'));
    for (let i = 0; i < rootCount; i++) {
      const p = path.join(base, `root${i}`);
      await mkdir(p, { recursive: true });
      const id = randomUUID();
      await sql`insert into scan_roots (id, library_id, path, display_name, validation_status) values (${id}, ${libraryId}, ${p}, ${`root${i}`}, 'ok')`;
      roots.push({ id, path: p });
    }
  } catch (error) {
    // setup failed half way: remove what it made (the roots cascade from the library)
    try {
      await sql`delete from libraries where id = ${libraryId}`;
      await sql`delete from users where id = ${userId}`;
    } finally {
      await sql.end({ timeout: 5 });
      if (base) await rm(base, { recursive: true, force: true });
    }
    throw error;
  }
  const baseDir = base;
  const rootIndex = new Map(roots.map((r, i) => [r.id, i]));
  const globals: string[] = []; // release groups this lab created (global tables)

  const drain = (opts: { only?: string[] } = {}) => drainJobs(ctx, sent, opts);

  const lab = {
    ctx, sql, libraryId, userId, roots, sent, drain,
    async album(root: number, dir: string, n: number, o: { album?: string; artist?: string; cover?: boolean; firstTrack?: number } = {}) {
      const abs = path.join(roots[root]!.path, dir);
      await mkdir(abs, { recursive: true });
      for (let i = 0; i < n; i++) {
        const t = (o.firstTrack ?? 1) + i;
        await writeFlac(path.join(abs, `${String(t).padStart(2, '0')} - Song ${t}.flac`), {
          title: `Song ${t}`, artist: o.artist ?? 'Artist', albumartist: o.artist ?? 'Artist', album: o.album ?? path.basename(dir),
          track: t, seconds: 60 + t, padding: 16 + t + (o.album ?? dir).length,
        });
      }
      if (o.cover) await writeFile(path.join(abs, 'folder.jpg'), `jpg:${dir}`);
    },
    async scan(root: number, mode: 'full' | 'quick' = 'full', extra: Partial<ScanRootJobData> = {}) {
      await scanRootJob(ctx, { scanRootId: roots[root]!.id, mode, ...extra });
      await drain();
    },
    async albumIdOf(root: number, relPath: string) {
      const r = await sql`select lt.local_album_id from local_tracks lt join files af on af.id = lt.audio_file_id
                          where af.scan_root_id = ${roots[root]!.id} and af.rel_path = ${relPath}`;
      return (r[0]?.local_album_id as string | undefined) ?? null;
    },
    /**
     * Everything owner-set or history-carrying the spec lists, on one album.
     * The sidecar cover is the album folder's image sidecar (or its parent's,
     * the multi-disc layout); it throws when there is none, unless cover: false.
     */
    async ownerData(albumId: string, o: { cover?: boolean } = {}) {
      const [rg] = await sql`insert into release_groups (mbid, title) values (${randomUUID()}, 'RG') returning id`;
      globals.push(rg.id);
      const [rel] = await sql`insert into releases (release_group_id, mbid, title) values (${rg.id}, ${randomUUID()}, 'R') returning id`;
      const tracks = await sql`select lt.id, lt.audio_file_id, lt.track_no from local_tracks lt where lt.local_album_id = ${albumId} order by lt.track_no`;
      for (const [i, t] of tracks.entries()) {
        const [ct] = await sql`insert into canonical_tracks (release_id, position, title) values (${rel.id}, ${i + 1}, ${`Song ${i + 1}`}) returning id`;
        await sql`update local_tracks set canonical_track_id = ${ct.id}, state = 'matched' where id = ${t.id}`;
        await sql`insert into player_track_map (local_track_id, server_key, song_id, matched_by) values (${t.id}, 'bundled', ${`song-${t.id}`}, 'path')`;
      }
      await sql`update local_albums set state = 'matched', release_id = ${rel.id}, release_group_id = ${rg.id}, tracks_linked_at = now(), identified_at = now() where id = ${albumId}`;
      await sql`insert into album_matches (library_id, local_album_id, release_id, distance, status, decided_by) values (${libraryId}, ${albumId}, ${rel.id}, 0.05, 'confirmed', 'user')`;
      await sql`insert into field_locks (library_id, scope, scope_id, field, value, created_by) values
                (${libraryId}, 'album', ${albumId}, 'title', '"Locked title"'::jsonb, ${userId}),
                (${libraryId}, 'track', ${tracks[0]!.audio_file_id}, 'title', '"Locked track"'::jsonb, ${userId})`;
      await sql`insert into images (library_id, entity_type, entity_id, local_album_id, kind, origin, audio_file_id, license_note)
                values (${libraryId}, 'local_album', ${albumId}, ${albumId}, 'front', 'embedded', ${tracks[0]!.audio_file_id}, 't')`;
      const [sc] = await sql`select s.id from sidecar_files s join local_albums la on la.id = ${albumId}
                              cross join lateral unnest(la.dir_paths) d
                             where s.library_id = ${libraryId} and s.kind = 'image'
                               and (${sql.unsafe(sqlDirname('s'))}) in (d, ${sql.unsafe(parentOf('d'))})
                             order by (${sql.unsafe(sqlDirname('s'))}) = d desc limit 1`;
      if (!sc && o.cover !== false) throw new Error(`ownerData: no image sidecar beside album ${albumId}`);
      if (sc) {
        await sql`insert into images (library_id, entity_type, entity_id, local_album_id, kind, origin, sidecar_file_id, license_note)
                  values (${libraryId}, 'local_album', ${albumId}, ${albumId}, 'back', 'sidecar', ${sc.id}, 't')`;
      }
      const [src] = await sql`insert into collection_sources (library_id, provider) values (${libraryId}, 'discogs') returning id`;
      await sql`insert into collection_items (library_id, collection_source_id, local_album_id) values (${libraryId}, ${src.id}, ${albumId})`;
      await sql`insert into player_listens (user_id, library_id, local_album_id, started_at, ended_at, tracks_heard, tracks_total)
                values (${userId}, ${libraryId}, ${albumId}, now(), now(), 3, 3)`;
      const [plan] = await sql`insert into tag_plans (library_id, name, scope, policy, status, created_by)
                               values (${libraryId}, 'p', ${JSON.stringify({})}::jsonb, ${JSON.stringify({})}::jsonb, 'applied', ${userId}) returning id`;
      await sql`insert into tag_plan_items (tag_plan_id, audio_file_id, before, after, diff, status)
                values (${plan.id}, ${tracks[0]!.audio_file_id}, ${JSON.stringify({ title: 'x' })}::jsonb, ${JSON.stringify({ title: 'Song 1' })}::jsonb, ${JSON.stringify([])}::jsonb, 'pending')`;
    },
    async snapshot(): Promise<Snapshot> {
      const files = (await sql`select id, scan_root_id, rel_path, status from files where library_id = ${libraryId} order by id`)
        .map((r: any) => ({ id: r.id as string, root: rootIndex.get(r.scan_root_id) ?? -1, relPath: r.rel_path as string, status: r.status as string }));
      const tracks = (await sql`select lt.id, lt.audio_file_id, lt.local_album_id, lt.canonical_track_id from local_tracks lt
                                join files af on af.id = lt.audio_file_id where af.library_id = ${libraryId} order by lt.id`)
        .map((r: any) => ({ id: r.id as string, fileId: r.audio_file_id as string, albumId: r.local_album_id as string | null, canonical: r.canonical_track_id as string | null }));
      const albums = (await sql`select id, state, release_id from local_albums where library_id = ${libraryId} order by id`)
        .map((r: any) => ({ id: r.id as string, state: r.state as string, releaseId: r.release_id as string | null }));
      const owner: Record<string, unknown> = {
        matches: await sql`select local_album_id, release_id, status, decided_by from album_matches where library_id = ${libraryId} order by 1, 2`,
        locks: await sql`select scope, scope_id, field from field_locks where library_id = ${libraryId} order by 1, 2, 3`,
        // the sidecar cover counts. Its sidecar row is re-pointed to the new folder's, so the
        // id may change; what must hold is where it sits: 'present' when it is in the folder (or the parent
        // folder, for disc sets) of a present file of the image's album, else 'missing' when only missing
        // files of the album are there (a kept ghost), else null (a lost or misplaced cover).
        images: await sql`select i.id, i.local_album_id, i.kind, i.origin, i.audio_file_id,
                                 (select case when bool_or(af.status = 'present') then 'present' else 'missing' end
                                    from sidecar_files s
                                    join files af on af.scan_root_id = s.scan_root_id
                                                       and ${sql.unsafe(sqlDirname('s'))} in (${sql.unsafe(sqlDirname('af'))}, ${sql.unsafe(parentOf(sqlDirname('af')))})
                                    join local_tracks lt on lt.audio_file_id = af.id and lt.local_album_id = i.local_album_id
                                   where s.id = i.sidecar_file_id) as sidecar_beside
                            from images i where i.library_id = ${libraryId} order by i.id`,
        collection: await sql`select id, local_album_id from collection_items where library_id = ${libraryId} order by id`,
        listens: await sql`select id, local_album_id from player_listens where library_id = ${libraryId} order by id`,
        planItems: await sql`select tpi.id, tpi.audio_file_id from tag_plan_items tpi join tag_plans tp on tp.id = tpi.tag_plan_id where tp.library_id = ${libraryId} order by 1`,
        playerMap: await sql`select p.local_track_id from player_track_map p join local_tracks lt on lt.id = p.local_track_id
                             join files af on af.id = lt.audio_file_id where af.library_id = ${libraryId} order by 1`,
      };
      return { counts: { files: files.length, albums: albums.length, tracks: tracks.length }, files, tracks, albums, owner };
    },
    async close() {
      await sql`delete from tag_plans where library_id = ${libraryId}`;
      await sql`delete from local_albums where library_id = ${libraryId}`;
      await sql`delete from scan_roots where library_id = ${libraryId}`;
      await sql`delete from libraries where id = ${libraryId}`;
      await sql`delete from users where id = ${userId}`;
      if (globals.length) {
        await sql`delete from canonical_tracks where release_id in (select id from releases where release_group_id = any(${globals}::uuid[]))`;
        await sql`delete from releases where release_group_id = any(${globals}::uuid[])`;
        await sql`delete from release_groups where id = any(${globals}::uuid[])`;
      }
      await sql.end({ timeout: 5 });
      await rm(baseDir, { recursive: true, force: true });
    },
  };
  return lab;
}

export type Lab = Awaited<ReturnType<typeof makeLab>>;

/**
 * The spec's invariant: same ids everywhere, each file where `moves` puts
 * it, no row count grows. With
 * mapRebuilt the moved tracks' player map rows were dropped (stale;
 * the app rebuilds them on the next play): what is left is a strict subset.
 */
export function expectKept(before: Snapshot, after: Snapshot, opts: { mapRebuilt?: boolean; moves?: PathMove[] } = {}): void {
  expect(after.counts.files).toBeLessThanOrEqual(before.counts.files);
  expect(after.counts.albums).toBeLessThanOrEqual(before.counts.albums);
  expect(after.counts.tracks).toBeLessThanOrEqual(before.counts.tracks);
  // same ids, each at the path its move says (a swapped pairing fails here)
  expect(after.files).toEqual(expectedFiles(before, opts.moves ?? []));
  expect(after.tracks).toEqual(before.tracks);
  expect(after.albums).toEqual(before.albums);
  const { playerMap: mapBefore, ...ownerBefore } = before.owner;
  const { playerMap: mapAfter, ...ownerAfter } = after.owner;
  expect(ownerAfter).toEqual(ownerBefore);
  const ids = (rows: unknown) => (rows as Array<{ local_track_id: string }>).map((r) => r.local_track_id);
  if (opts.mapRebuilt) {
    expect(ids(mapBefore).length).toBeGreaterThan(ids(mapAfter).length);
    for (const id of ids(mapAfter)) expect(ids(mapBefore)).toContain(id);
  } else {
    expect(mapAfter).toEqual(mapBefore);
  }
}
