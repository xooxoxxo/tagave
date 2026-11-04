/**
 * Naming rules and the drop pool (0081) on the file worker, end to end on
 * real FLAC files (ffmpeg makes them, the mutagen sidecar writes their
 * tags):
 *
 * - a tag plan that renames and moves: the preview's paths, the tags
 *   applied, then one organize move per album (the cover with it, the old
 *   artist folder into the trash), the album keeping its id and match; the
 *   plan's Revert undoes the move first;
 * - Organize on a misfiled album, and a Leave alone folder never touched;
 * - the scan never walks the pool;
 * - a drop that waits until still, then imports on its own (tags written,
 *   moved to its rule path, scanned), and its Undo;
 * - a drop identify is unsure of, and one already in the library: Inbox.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { access, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import pino from 'pino';
import { parseFile } from 'music-metadata';
import { makeDb } from '@tagave/db';
import { DEFAULT_NAMING_RULES, type CanonicalRelease } from '@tagave/core';
import type { WorkerContext } from '../lib/context.js';
import { SafeFileWriter } from '../lib/safeFileWriter.js';
import { MutagenTagWriter, resolvePythonInterpreter } from '../lib/tagWriter.js';
import { linkAlbumTracks } from '../lib/trackLinks.js';
import { filesMoveJob, undoMovesOfPlan, type MoveDeps } from './filesMove.js';
import { organizePlanFor } from './organize.js';
import { poolScanJob, type PoolDeps } from './poolScan.js';
import { scanDirJob } from './scanDir.js';
import { scanParseJob } from './scanParse.js';
import { clusterDirJob } from './clusterDir.js';
import { tagsPreviewJob } from './tagsPreview.js';
import { tagsApplyJob } from './tagsApply.js';

const there = (p: string) => access(p).then(() => true, () => false);
function can(bin: string, args: string[]): boolean {
  try { execFileSync(bin, args, { stdio: 'pipe' }); return true; } catch { return false; }
}
const tools = !!process.env.TEST_DATABASE_URL && can('ffmpeg', ['-version']) && can(resolvePythonInterpreter(), ['-c', 'import mutagen']);

interface Song { title: string; album: string; artist: string; track: number; seconds: number; date?: string }

function makeFlac(file: string, s: Song): void {
  execFileSync('ffmpeg', [
    '-v', 'error', '-f', 'lavfi', '-i', `sine=frequency=${300 + s.track * 40}:duration=${s.seconds}`, '-ac', '1', '-ar', '22050',
    '-metadata', `title=${s.title}`, '-metadata', `album=${s.album}`, '-metadata', `artist=${s.artist}`, '-metadata', `album_artist=${s.artist}`,
    '-metadata', `track=${s.track}`, ...(s.date ? ['-metadata', `date=${s.date}`] : []), '-c:a', 'flac', '-y', file,
  ], { stdio: 'pipe' });
}

/** A MusicBrainz release as the provider returns it. */
function mbRelease(artist: string, title: string, year: number, tracks: Array<[string, number]>): CanonicalRelease {
  return {
    id: randomUUID(), releaseGroupId: randomUUID(), title, artists: [artist], year, date: `${year}-01-01`, country: 'XW',
    status: 'Official', media: 'Digital Media', source: 'musicbrainz', primaryType: 'Album',
    artistCredits: [{ name: artist, mbid: randomUUID(), joinPhrase: '' }] as unknown as CanonicalRelease['artistCredits'],
    tracks: tracks.map(([t, s], i) => ({ title: t, artists: [artist], duration: s * 1000, position: i + 1, mediumNumber: 1, recordingId: randomUUID(), trackId: randomUUID() })),
  };
}

describe.skipIf(!tools)('naming rules and the drop pool (db, real FLAC)', () => {
  let ctx: WorkerContext;
  let sql: any;
  let rootPath: string;
  let tags: MutagenTagWriter;
  let deps: MoveDeps;
  const userId = randomUUID();
  const libraryId = randomUUID();
  const rootId = randomUUID();
  const sent: Array<{ name: string; data: any }> = [];
  const day = new Date('2026-11-04T10:00:00Z');
  const abs = (r: string) => path.join(rootPath, r);
  const releases: CanonicalRelease[] = [];
  const POOL = '_Inbox';

  async function scan(dir: string): Promise<void> {
    sent.length = 0;
    await scanDirJob(ctx, { scanRootId: rootId, dirPath: dir });
    for (const s of sent.filter((x) => x.name === 'scan.parse')) await scanParseJob(ctx, s.data);
    await clusterDirJob(ctx, { libraryId, scanRootId: rootId, dirPath: dir });
  }
  const albumIn = async (dir: string): Promise<string | null> => {
    const [r] = await sql`select la.id::text as id from local_albums la where la.library_id = ${libraryId} and ${dir} = any(la.dir_paths)`;
    return r?.id ?? null;
  };
  /** A release stored as identify stores one, and the album matched to it. */
  async function matchTo(albumId: string, r: CanonicalRelease): Promise<void> {
    const { persistFetched } = await import('./identifyAlbum.js');
    const ids = await persistFetched(ctx, r);
    await sql`update local_albums set state = 'matched', release_id = ${ids.releaseId}, release_group_id = ${ids.releaseGroupId} where id = ${albumId}`;
    await linkAlbumTracks(ctx, albumId);
  }
  const moveRow = async (id: string) => (await sql`select * from album_moves where id = ${id}`)[0];
  const runSent = async (name: string) => {
    const jobs = sent.filter((s) => s.name === name);
    const out = [];
    for (const j of jobs) out.push(await filesMoveJob(ctx, j.data, deps));
    return out;
  };
  const albumTag = async (r: string) => (await parseFile(abs(r))).common.album;
  const ls = async (d: string) => (await readdir(abs(d))).sort();

  beforeAll(async () => {
    const made = await makeDb(process.env.TEST_DATABASE_URL!);
    sql = made.client;
    const boss = { send: async (name: string, data: unknown) => { sent.push({ name, data }); return randomUUID(); } };
    ctx = { db: made.db, sql: made.client, boss: boss as any, logger: pino({ level: 'silent' }) };
    tags = new MutagenTagWriter();
    deps = { writer: new SafeFileWriter(tags), now: () => day };
    rootPath = await mkdtemp(path.join(tmpdir(), 'rr75test-naming-'));
    await sql`insert into users (id, email, password_hash) values (${userId}, ${`naming-${userId}@test.com`}, 'x')`;
    await sql`insert into libraries (id, name, owner_user_id, settings) values (${libraryId}, 'Naming', ${userId}, ${JSON.stringify({
      tagWritesEnabled: true, contactString: 'tagave-test (example.com)', naming: DEFAULT_NAMING_RULES,
      dropPool: { enabled: true, scanRootId: rootId, dirPath: POOL },
    })}::jsonb)`;
    await sql`insert into scan_roots (id, library_id, path, display_name, validation_status, writable, probe_writable)
              values (${rootId}, ${libraryId}, ${rootPath}, 'naming', 'ok', true, true)`;
  }, 60_000);

  beforeEach(() => { sent.length = 0; });

  afterAll(async () => {
    await tags?.close();
    await sql`delete from album_moves where library_id = ${libraryId}`;
    await sql`delete from tag_plans where library_id = ${libraryId}`;
    await sql`delete from scan_roots where id = ${rootId}`;
    await sql`delete from libraries where id = ${libraryId}`;
    for (const r of releases) {
      await sql`delete from releases where mbid = ${r.id}`;
      await sql`delete from release_groups where mbid = ${r.releaseGroupId}`;
    }
    await sql`delete from users where id = ${userId}`;
    await sql.end({ timeout: 5 });
    await rm(rootPath, { recursive: true, force: true });
  });

  it('a tag plan renames and moves: the preview shows each path, Apply tags then moves, Revert moves back first', async () => {
    const OLD = 'Fiona Apple/when the pawn';
    await mkdir(abs(OLD), { recursive: true });
    makeFlac(abs(`${OLD}/1 bound.flac`), { title: 'On the Bound', album: 'When the Pawn', artist: 'Fiona Apple', track: 1, seconds: 3 });
    makeFlac(abs(`${OLD}/2 love.flac`), { title: 'To Your Love', album: 'When the Pawn', artist: 'Fiona Apple', track: 2, seconds: 4 });
    await writeFile(abs(`${OLD}/folder.jpg`), 'cover');
    await scan(OLD);
    const albumId = (await albumIn(OLD))!;
    const rel = mbRelease('Fiona Apple', 'when the pawn', 1999, [['On the Bound', 3], ['To Your Love', 4]]);
    releases.push(rel);
    await matchTo(albumId, rel);

    const planId = randomUUID();
    await sql`insert into tag_plans (id, library_id, name, scope, policy, status, created_by)
              values (${planId}, ${libraryId}, 'Pawn', ${JSON.stringify({ type: 'albumIds', albumIds: [albumId] })}::jsonb,
                      ${JSON.stringify({ preset: 'canonical_ids_and_fill', id3Version: '2.4', multiValueSeparator: '; ', organize: true })}::jsonb, 'draft', ${userId})`;
    await tagsPreviewJob(ctx, planId);
    const items = await sql`select f.rel_path as "relPath", i.path_after as "pathAfter", i.path_state as "pathState", i.diff
                              from tag_plan_items i join files f on f.id = i.audio_file_id where i.tag_plan_id = ${planId} order by f.rel_path`;
    expect(items.map((i: any) => [i.relPath, i.pathAfter, i.pathState])).toEqual([
      [`${OLD}/1 bound.flac`, 'F/Fiona Apple/1999 - when the pawn/01 - On the Bound.flac', null],
      [`${OLD}/2 love.flac`, 'F/Fiona Apple/1999 - when the pawn/02 - To Your Love.flac', null],
    ]);
    const [{ stats }] = await sql`select stats from tag_plans where id = ${planId}`;
    expect(stats).toMatchObject({ filesToMove: 2, filesMoveBlocked: 0 });

    sent.length = 0;
    await tagsApplyJob(ctx, { planId });
    const moves = sent.filter((s) => s.name === 'files.move');
    expect(moves).toHaveLength(1);
    const [done] = await runSent('files.move');
    expect(done).toMatchObject({ state: 'done', files: 2 });
    const NEW = 'F/Fiona Apple/1999 - when the pawn';
    expect(await ls(NEW)).toEqual(['01 - On the Bound.flac', '02 - To Your Love.flac', 'folder.jpg']);
    // the tags the plan wrote (album from the release, the case kept)
    expect(await albumTag(`${NEW}/01 - On the Bound.flac`)).toBe('when the pawn');
    // the old artist folder emptied: into the trash, whole
    expect(await there(abs('Fiona Apple'))).toBe(false);
    expect(await there(abs('.tagave-trash/2026-11-04/Fiona Apple/when the pawn'))).toBe(true);
    // the album kept its id and its match
    const [a] = await sql`select id::text as id, state, dir_paths from local_albums where id = ${albumId}`;
    expect(a).toMatchObject({ state: 'matched', dir_paths: [NEW] });
    const move = await moveRow(moves[0]!.data.moveId);
    expect(move).toMatchObject({ kind: 'organize', tag_plan_id: planId, state: 'done' });
    const [audit] = await sql`select payload from audit_log where library_id = ${libraryId} and action = 'album.organize' order by at desc limit 1`;
    expect(audit.payload.extras).toEqual([{ from: `${OLD}/folder.jpg`, to: `${NEW}/folder.jpg` }]);

    // Revert: the move undone first (back where they were, the folder out of the trash)
    expect(await undoMovesOfPlan(ctx, planId)).toEqual({ tried: 1, undone: 1 });
    expect(await ls(OLD)).toEqual(['1 bound.flac', '2 love.flac', 'folder.jpg']);
    expect(await there(abs(NEW))).toBe(false);
    const [back] = await sql`select dir_paths from local_albums where id = ${albumId}`;
    expect(back.dir_paths).toEqual([OLD]);
  }, 120_000);

  it('Organize moves a misfiled album; a name taken stops it with nothing changed; Leave alone is never touched', async () => {
    const MIS = 'misc/sakamoto stuff';
    await mkdir(abs(MIS), { recursive: true });
    makeFlac(abs(`${MIS}/firewater.flac`), { title: 'Firewater', album: 'Out Of Noise', artist: 'Ryuichi Sakamoto', track: 7, seconds: 3, date: '2009' });
    await writeFile(abs(`${MIS}/out of noise.cue`), 'FILE "x" WAVE');
    await scan(MIS);
    const albumId = (await albumIn(MIS))!;
    const fileIds = (await sql`select f.id::text as id from local_tracks lt join files f on f.id = lt.audio_file_id where lt.local_album_id = ${albumId}`).map((r: any) => r.id);
    const { plan } = await organizePlanFor(ctx, libraryId, fileIds);
    expect(plan.toDir).toBe('R/Ryuichi Sakamoto/2009 - Out Of Noise');
    expect(plan.files.map((f) => f.toPath)).toEqual(['R/Ryuichi Sakamoto/2009 - Out Of Noise/07 - Firewater.flac']);
    expect(plan.extras).toEqual([{ fromPath: `${MIS}/out of noise.cue`, toPath: 'R/Ryuichi Sakamoto/2009 - Out Of Noise/out of noise.cue' }]);

    // the name taken: the move stops, everything stays
    await mkdir(abs('R/Ryuichi Sakamoto/2009 - Out Of Noise'), { recursive: true });
    await writeFile(abs('R/Ryuichi Sakamoto/2009 - Out Of Noise/07 - Firewater.flac'), 'another');
    const [blocked] = await sql`insert into album_moves (library_id, kind, source_track_ids, state, query) values (${libraryId}, 'organize', '{}'::uuid[], 'planning', ${JSON.stringify({ fileIds })}::jsonb) returning id::text as id`;
    expect(await filesMoveJob(ctx, { moveId: blocked.id, action: 'plan' }, deps)).toMatchObject({ state: 'failed' });
    expect((await moveRow(blocked.id)).error).toMatch(/already in the folder/);
    expect(await there(abs(`${MIS}/firewater.flac`))).toBe(true);
    await rm(abs('R'), { recursive: true });

    const [row] = await sql`insert into album_moves (library_id, kind, source_track_ids, state, query) values (${libraryId}, 'organize', '{}'::uuid[], 'planning', ${JSON.stringify({ fileIds })}::jsonb) returning id::text as id`;
    expect(await filesMoveJob(ctx, { moveId: row.id, action: 'plan' }, deps)).toMatchObject({ state: 'done' });
    expect(await ls('R/Ryuichi Sakamoto/2009 - Out Of Noise')).toEqual(['07 - Firewater.flac', 'out of noise.cue']);
    expect(await there(abs('misc'))).toBe(false);

    // Leave alone: "## HQ ##" is never organized
    const HQ = '## HQ ##/Low/Things We Lost';
    await mkdir(abs(HQ), { recursive: true });
    makeFlac(abs(`${HQ}/a.flac`), { title: 'Sunflower', album: 'Things We Lost in the Fire', artist: 'Low', track: 1, seconds: 3 });
    await scan(HQ);
    const hq = (await sql`select f.id::text as id from files f where f.rel_path like '## HQ ##/%' and f.library_id = ${libraryId}`).map((r: any) => r.id);
    await expect(organizePlanFor(ctx, libraryId, hq)).rejects.toThrow('In a Leave alone folder');
  }, 120_000);

  it('the scan never walks the pool', async () => {
    await mkdir(abs(`${POOL}/Some Artist - Loose`), { recursive: true });
    makeFlac(abs(`${POOL}/Some Artist - Loose/x.flac`), { title: 'X', album: 'Loose', artist: 'Some Artist', track: 1, seconds: 2 });
    await scanDirJob(ctx, { scanRootId: rootId, dirPath: '' });
    await scanDirJob(ctx, { scanRootId: rootId, dirPath: `${POOL}/Some Artist - Loose` });
    const [n] = await sql`select count(*)::int as n from files where library_id = ${libraryId} and rel_path like ${`${POOL}/%`}`;
    expect(n.n).toBe(0);
    await rm(abs(`${POOL}/Some Artist - Loose`), { recursive: true });
  }, 60_000);

  describe('the drop pool', () => {
    const DROP = `${POOL}/Machine District [FLAC]`;
    const rel = mbRelease('The Peoples Republic Of Europe', 'Machine District', 2012, [['Machine District', 3], ['Centurion', 4]]);
    const now = () => new Date(Date.now() + 3 * 60_000);
    const poolDeps: PoolDeps = {
      search: async (q) => (/machine district/i.test(q.albumTitle) ? [{ release: { id: rel.id, tracks: rel.tracks } }] : []),
      release: async (mbid) => { const r = [rel].find((x) => x.id === mbid); if (!r) throw Object.assign(new Error('nf'), { status: 404 }); return r; },
    };
    const item = async (dir: string) => (await sql`select * from pool_items where dir_path = ${dir}`)[0];

    beforeAll(async () => {
      releases.push(rel);
      await mkdir(abs(`${DROP}/CD1`), { recursive: true });
      makeFlac(abs(`${DROP}/CD1/01 machine district.flac`), { title: 'Machine District', album: 'Machine District', artist: 'The Peoples Republic Of Europe', track: 1, seconds: 3 });
      makeFlac(abs(`${DROP}/CD1/02 centurion.flac`), { title: 'Centurion', album: 'Machine District', artist: 'The Peoples Republic Of Europe', track: 2, seconds: 4 });
      await writeFile(abs(`${DROP}/cover.jpg`), 'cover');
      await writeFile(abs(`${DROP}/rip.log`), 'log');
    }, 60_000);

    it('waits until the files are still, then imports a confident match on its own; Undo puts it back', async () => {
      // first look: waiting (nothing still for two minutes yet)
      await poolScanJob(ctx, { libraryId }, poolDeps);
      expect(await item(DROP)).toMatchObject({ state: 'waiting' });
      expect(sent.filter((s) => s.name === 'files.move')).toHaveLength(0);
      // a part file still downloading keeps it waiting, whatever the clock
      await writeFile(abs(`${DROP}/03 bonus.flac.part`), 'half');
      await poolScanJob(ctx, { libraryId }, { ...poolDeps, now });
      expect(await item(DROP)).toMatchObject({ state: 'waiting' });
      await rm(abs(`${DROP}/03 bonus.flac.part`));
      await poolScanJob(ctx, { libraryId }, { ...poolDeps, now });
      await sql`update pool_items set stable_since = now() - interval '5 minutes' where dir_path = ${DROP}`;
      // still: identified, confident, imported
      await poolScanJob(ctx, { libraryId }, { ...poolDeps, now });
      const it1 = await item(DROP);
      expect(it1).toMatchObject({ state: 'importing', best_percent: expect.any(Number) });
      const [out] = await runSent('files.move');
      expect(out).toMatchObject({ state: 'done' });
      const TO = 'P/The Peoples Republic Of Europe/2012 - Machine District';
      expect(await ls(TO)).toEqual(['01 - Machine District.flac', '02 - Centurion.flac', 'cover.jpg', 'rip.log']);
      expect(await albumTag(`${TO}/02 - Centurion.flac`)).toBe('Machine District');
      expect((await parseFile(abs(`${TO}/02 - Centurion.flac`))).common.musicbrainz_albumid).toBe(rel.id);
      // the drop folder went into the trash; the pool stays
      expect(await there(abs(DROP))).toBe(false);
      expect(await there(abs(POOL))).toBe(true);
      expect(await item(DROP)).toMatchObject({ state: 'imported' });
      // in the library now, and matched to its release by the scan after
      const [n] = await sql`select count(*)::int as n from files where library_id = ${libraryId} and rel_path like ${`${TO}/%`} and status = 'present'`;
      expect(n.n).toBe(2);
      const albumId = await albumIn(TO);
      expect(sent.find((s) => s.name === 'identify.album')?.data).toMatchObject({ localAlbumId: albumId, pinnedMbid: rel.id });
      const [audit] = await sql`select action from audit_log where library_id = ${libraryId} and action = 'pool.import'`;
      expect(audit).toBeTruthy();

      // Undo: back into the pool, out of the library, skipped
      await sql`update album_moves set state = 'undoing' where id = ${it1.move_id}`;
      expect(await filesMoveJob(ctx, { moveId: it1.move_id, action: 'undo' }, deps)).toMatchObject({ state: 'undone' });
      expect(await ls(`${DROP}/CD1`)).toEqual(['01 machine district.flac', '02 centurion.flac']);
      expect(await ls(DROP)).toEqual(['CD1', 'cover.jpg', 'rip.log']);
      const [gone] = await sql`select count(*)::int as n from files where library_id = ${libraryId} and rel_path like ${`${TO}/%`}`;
      expect(gone.n).toBe(0);
      expect(await item(DROP)).toMatchObject({ state: 'skipped', reason: 'undone' });
    }, 120_000);

    it('already in the library: Inbox, never merged', async () => {
      // import it for real, then drop it again
      await sql`update pool_items set state = 'inbox', reason = null where dir_path = ${DROP}`;
      await poolScanJob(ctx, { libraryId, itemId: (await item(DROP)).id }, { ...poolDeps, now });
      await runSent('files.move');
      expect(await item(DROP)).toMatchObject({ state: 'imported' });
      // the identify the import asked for (pinned to the release), as the identify worker would run it
      const [r] = await sql`select r.id::text as id, r.release_group_id::text as rg from releases r where r.mbid = ${rel.id}`;
      await sql`update local_albums set state = 'matched', release_id = ${r.id}, release_group_id = ${r.rg}
                 where id = ${await albumIn('P/The Peoples Republic Of Europe/2012 - Machine District')}`;
      const AGAIN = `${POOL}/Machine District again`;
      await mkdir(abs(AGAIN), { recursive: true });
      makeFlac(abs(`${AGAIN}/1.flac`), { title: 'Machine District', album: 'Machine District', artist: 'The Peoples Republic Of Europe', track: 1, seconds: 3 });
      makeFlac(abs(`${AGAIN}/2.flac`), { title: 'Centurion', album: 'Machine District', artist: 'The Peoples Republic Of Europe', track: 2, seconds: 4 });
      await poolScanJob(ctx, { libraryId }, poolDeps);
      await sql`update pool_items set stable_since = now() - interval '5 minutes' where dir_path = ${AGAIN}`;
      sent.length = 0;
      await poolScanJob(ctx, { libraryId }, { ...poolDeps, now });
      const again = await item(AGAIN);
      expect(again).toMatchObject({ state: 'inbox', reason: 'in_library' });
      expect(again.existing_album_id).toBe(await albumIn('P/The Peoples Republic Of Europe/2012 - Machine District'));
      expect(sent.filter((s) => s.name === 'files.move')).toHaveLength(0);
      // Keep both: a folder of its own beside it
      const { queueImport } = await import('./poolImport.js');
      await queueImport(ctx, libraryId, again.id, again.best_release_id, { existing: 'keepBoth' });
      await runSent('files.move');
      expect(await ls('P/The Peoples Republic Of Europe/2012 - Machine District (2)')).toEqual(['01 - Machine District.flac', '02 - Centurion.flac']);
    }, 120_000);

    it('a drop identify is unsure of waits in Inbox', async () => {
      const ODD = `${POOL}/odd`;
      await mkdir(abs(ODD), { recursive: true });
      makeFlac(abs(`${ODD}/a.flac`), { title: 'Something Else Entirely', album: 'Machine District', artist: 'Nobody', track: 1, seconds: 9 });
      await poolScanJob(ctx, { libraryId }, poolDeps);
      await sql`update pool_items set stable_since = now() - interval '5 minutes' where dir_path = ${ODD}`;
      sent.length = 0;
      await poolScanJob(ctx, { libraryId }, { ...poolDeps, now });
      const odd = await item(ODD);
      expect(odd.state).toBe('inbox');
      expect(['unsure', 'in_library']).toContain(odd.reason);
      expect(odd.candidates.length).toBeGreaterThan(0);
      expect(sent.filter((s) => s.name === 'files.move')).toHaveLength(0);
      // nothing found at all: unidentified
      const NONE = `${POOL}/none`;
      await mkdir(abs(NONE), { recursive: true });
      makeFlac(abs(`${NONE}/a.flac`), { title: 'Zz', album: 'Zzz', artist: 'Zz', track: 1, seconds: 2 });
      await poolScanJob(ctx, { libraryId }, poolDeps);
      await sql`update pool_items set stable_since = now() - interval '5 minutes' where dir_path = ${NONE}`;
      await poolScanJob(ctx, { libraryId }, { ...poolDeps, now });
      expect(await item(NONE)).toMatchObject({ state: 'inbox', reason: 'unidentified' });
    }, 120_000);
  });
});
