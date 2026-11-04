/**
 * Move to album (0080) on the file worker, end to end on real FLAC files
 * (ffmpeg makes them, the mutagen sidecar writes their tags): a Vertebrae
 * folder that also holds songs of Isa and Ruun, scanned, grouped and
 * matched as the app would; the plan (pairs, confidence, paths in the target
 * folder's names, the tag changes); the move (tags, then names, file rows
 * kept, both folders regrouped, an emptied folder into the trash); Undo from
 * the journal; a release with no folder; and every way it stops with
 * nothing changed.
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
import type { MovePlan, TagSet } from '@tagave/shared';
import type { WorkerContext } from '../lib/context.js';
import { SafeFileWriter } from '../lib/safeFileWriter.js';
import { MutagenTagWriter, resolvePythonInterpreter } from '../lib/tagWriter.js';
import { linkAlbumTracks } from '../lib/trackLinks.js';
import { filesMoveJob, type MoveDeps } from './filesMove.js';
import { scanDirJob } from './scanDir.js';
import { scanParseJob } from './scanParse.js';
import { clusterDirJob } from './clusterDir.js';

const there = (p: string) => access(p).then(() => true, () => false);
function can(bin: string, args: string[]): boolean {
  try { execFileSync(bin, args, { stdio: 'pipe' }); return true; } catch { return false; }
}
const tools = !!process.env.TEST_DATABASE_URL && can('ffmpeg', ['-version']) && can(resolvePythonInterpreter(), ['-c', 'import mutagen']);

interface Song { title: string; album: string; track: number; seconds: number }

/** A real FLAC of a tone, `seconds` long, with the tags a rip would have. */
function makeFlac(file: string, s: Song): void {
  execFileSync('ffmpeg', [
    '-v', 'error', '-f', 'lavfi', '-i', `sine=frequency=${300 + s.track * 40}:duration=${s.seconds}`, '-ac', '1', '-ar', '22050',
    '-metadata', `title=${s.title}`, '-metadata', `album=${s.album}`, '-metadata', 'artist=Enslaved', '-metadata', 'album_artist=Enslaved',
    '-metadata', `track=${s.track}`, '-c:a', 'flac', '-y', file,
  ], { stdio: 'pipe' });
}

describe.skipIf(!tools)('files.move on the file worker (db, real FLAC)', () => {
  let ctx: WorkerContext;
  let sql: any;
  let rootPath: string;
  let tags: MutagenTagWriter;
  const userId = randomUUID();
  const libraryId = randomUUID();
  const rootId = randomUUID();
  const sent: Array<{ name: string; data: any }> = [];
  const day = new Date('2026-11-04T10:00:00Z');
  const rel: Record<string, { rg: string; id: string; mbid: string }> = {};
  const VERT = 'Enslaved/2008 - Vertebrae';
  const ISA = 'Enslaved/2004 - Isa';
  const abs = (r: string) => path.join(rootPath, r);
  let deps: MoveDeps;

  /** The folder walked, read and grouped, as a scan would. */
  async function scan(dir: string): Promise<void> {
    sent.length = 0;
    await scanDirJob(ctx, { scanRootId: rootId, dirPath: dir });
    for (const s of sent.filter((x) => x.name === 'scan.parse')) await scanParseJob(ctx, s.data);
    await clusterDirJob(ctx, { libraryId, scanRootId: rootId, dirPath: dir });
  }
  async function release(key: string, title: string, year: number, tracks: Array<[string, number]>): Promise<void> {
    const rg = randomUUID(); const id = randomUUID(); const mbid = randomUUID();
    await sql`insert into release_groups (id, mbid, title, artist_credit, primary_type, first_release_date)
              values (${rg}, ${randomUUID()}, ${title}, ${JSON.stringify([{ name: 'Enslaved', mbid: randomUUID() }])}::jsonb, 'Album', ${`${year}-01-01`})`;
    await sql`insert into releases (id, release_group_id, mbid, title, date, track_count, media)
              values (${id}, ${rg}, ${mbid}, ${title}, ${`${year}-01-01`}, ${tracks.length}, ${JSON.stringify([{ format: 'CD' }])}::jsonb)`;
    for (const [i, [t, s]] of tracks.entries()) {
      await sql`insert into canonical_tracks (release_id, medium_no, position, number, title, length_ms, recording_mbid, track_mbid)
                values (${id}, 1, ${i + 1}, ${String(i + 1)}, ${t}, ${s * 1000}, ${randomUUID()}, ${randomUUID()})`;
    }
    rel[key] = { rg, id, mbid };
  }
  const albumIn = async (dir: string): Promise<string | null> => {
    const [r] = await sql`select la.id::text as id from local_albums la where la.library_id = ${libraryId} and ${dir} = any(la.dir_paths)`;
    return r?.id ?? null;
  };
  const match = async (albumId: string, key: string) => {
    await sql`update local_albums set state = 'matched', release_id = ${rel[key]!.id}, release_group_id = ${rel[key]!.rg} where id = ${albumId}`;
    await linkAlbumTracks(ctx, albumId);
  };
  const tracksOf = async (albumId: string) => (await sql`
    select lt.id::text as id, lt.title_guess as title, f.rel_path as "relPath", f.id::text as "fileId"
      from local_tracks lt join files f on f.id = lt.audio_file_id where lt.local_album_id = ${albumId} order by f.rel_path`) as Array<{ id: string; title: string; relPath: string; fileId: string }>;
  const moveRow = async (id: string) => (await sql`select * from album_moves where id = ${id}`)[0];
  async function newMove(source: string, trackIds: string[], target: { albumId?: string; releaseMbid?: string }): Promise<string> {
    const [r] = await sql`insert into album_moves (library_id, source_album_id, target_album_id, release_mbid, source_track_ids, state, created_by)
                          values (${libraryId}, ${source}, ${target.albumId ?? null}, ${target.releaseMbid ?? null}, ${trackIds}::uuid[], 'planning', ${userId})
                          returning id::text as id`;
    return r.id;
  }
  const plan = async (id: string): Promise<MovePlan> => {
    await filesMoveJob(ctx, { moveId: id, action: 'plan' }, deps);
    const r = await moveRow(id);
    expect(r.error).toBeNull();
    expect(r.state).toBe('ready');
    return r.plan as MovePlan;
  };
  const run = async (id: string, action: 'move' | 'undo') => {
    await sql`update album_moves set state = ${action === 'move' ? 'moving' : 'undoing'} where id = ${id}`;
    return filesMoveJob(ctx, { moveId: id, action }, deps);
  };
  const albumTag = async (r: string) => (await parseFile(abs(r))).common.album;

  let vertId: string;
  let isaId: string;

  beforeAll(async () => {
    const made = await makeDb(process.env.TEST_DATABASE_URL!);
    sql = made.client;
    const boss = { send: async (name: string, data: unknown) => { sent.push({ name, data }); return randomUUID(); } };
    ctx = { db: made.db, sql: made.client, boss: boss as any, logger: pino({ level: 'silent' }) };
    tags = new MutagenTagWriter();
    deps = { writer: new SafeFileWriter(tags), now: () => day };
    await sql`insert into users (id, email, password_hash) values (${userId}, ${`move-${userId}@test.com`}, 'x')`;
    await sql`insert into libraries (id, name, owner_user_id, settings) values (${libraryId}, 'Move', ${userId}, ${JSON.stringify({ tagWritesEnabled: true })}::jsonb)`;
    rootPath = await mkdtemp(path.join(tmpdir(), 'rr73test-move-'));
    await sql`insert into scan_roots (id, library_id, path, display_name, validation_status, writable, probe_writable)
              values (${rootId}, ${libraryId}, ${rootPath}, 'move', 'ok', true, true)`;
    await release('vert', 'Vertebrae', 2008, [['Clouds', 3], ['To the Coast', 4]]);
    await release('isa', 'Isa', 2004, [['Intro', 3.5], ['Isa', 5], ['Return to Yggdrasill', 6]]);
    await release('ruun', 'Ruun', 2006, [['Path to Vanir', 2.5], ['Fusion of Sense and Earth', 4.5]]);
    // Vertebrae's folder holds its own two songs and three of other albums, all tagged Vertebrae
    await mkdir(abs(VERT), { recursive: true });
    await mkdir(abs(ISA), { recursive: true });
    const vert: Array<[string, Song]> = [
      ['01 - Clouds.flac', { title: 'Clouds', album: 'Vertebrae', track: 1, seconds: 3 }],
      ['02 - To the Coast.flac', { title: 'To the Coast', album: 'Vertebrae', track: 2, seconds: 4 }],
      ['03 - Isa.flac', { title: 'Isa', album: 'Vertebrae', track: 3, seconds: 5 }],
      ['04 - Return to Yggdrasill.flac', { title: 'Return to Yggdrasill', album: 'Vertebrae', track: 4, seconds: 6 }],
      ['05 - Path to Vanir.flac', { title: 'Path to Vanir', album: 'Vertebrae', track: 5, seconds: 2.5 }],
    ];
    for (const [n, s] of vert) makeFlac(abs(`${VERT}/${n}`), s);
    makeFlac(abs(`${ISA}/01 - Intro.flac`), { title: 'Intro', album: 'Isa', track: 1, seconds: 3.5 });
    await scan(VERT);
    await scan(ISA);
    vertId = (await albumIn(VERT))!;
    isaId = (await albumIn(ISA))!;
    expect(vertId).toBeTruthy();
    expect(isaId).toBeTruthy();
    await match(vertId, 'vert');
    await match(isaId, 'isa');
  }, 60_000);

  beforeEach(() => { sent.length = 0; });

  afterAll(async () => {
    await tags?.close();
    await sql`delete from scan_roots where id = ${rootId}`;
    await sql`delete from libraries where id = ${libraryId}`;
    for (const r of Object.values(rel)) {
      await sql`delete from releases where id = ${r.id}`;
      await sql`delete from release_groups where id = ${r.rg}`;
    }
    await sql`delete from users where id = ${userId}`;
    await sql.end({ timeout: 5 });
    await rm(rootPath, { recursive: true, force: true });
  });

  it('plans: pairs, confidence, the target folder\'s names and the tag changes', async () => {
    const tracks = await tracksOf(vertId);
    expect(tracks).toHaveLength(5);
    const isaSongs = tracks.filter((t) => t.title === 'Isa' || t.title === 'Return to Yggdrasill');
    const id = await newMove(vertId, isaSongs.map((t) => t.id), { albumId: isaId });
    const p = await plan(id);
    expect(p.toDir).toBe(ISA);
    expect(p.newFolder).toBe(false);
    expect(p.naming).toBe('01 - Title');
    expect(p.files.map((f) => [f.toPath, f.target?.position, f.clash])).toEqual([
      [`${ISA}/02 - Isa.flac`, 2, false],
      [`${ISA}/03 - Return to Yggdrasill.flac`, 3, false],
    ]);
    for (const f of p.files) expect(f.confidence).toBeGreaterThanOrEqual(90);
    const fields = p.files[0]!.diff.map((d) => d.field);
    expect(fields).toEqual(expect.arrayContaining(['album', 'tracknumber', 'musicbrainz_albumid', 'date']));
    expect(p.files[0]!.diff.find((d) => d.field === 'album')).toMatchObject({ before: 'Vertebrae', after: 'Isa' });
    // the title stays: it is filled, never overwritten
    expect(fields).not.toContain('title');
  });

  it('a song not on the target release stays; a taken name is flagged', async () => {
    const tracks = await tracksOf(vertId);
    const clouds = tracks.find((t) => t.title === 'Clouds')!;
    const isa = tracks.find((t) => t.title === 'Isa')!;
    await writeFile(abs(`${ISA}/02 - Isa.flac`), 'someone else');
    const id = await newMove(vertId, [clouds.id, isa.id], { albumId: isaId });
    const p = await plan(id);
    expect(p.files.find((f) => f.localTrackId === clouds.id)).toMatchObject({ toPath: null, stays: 'Not on this release' });
    expect(p.files.find((f) => f.localTrackId === isa.id)).toMatchObject({ clash: true });
    // a taken name stops the move before anything changes
    const out = await run(id, 'move');
    expect(out).toMatchObject({ state: 'failed' });
    expect((await moveRow(id)).error).toMatch(/already in the folder/);
    expect(await there(abs(`${VERT}/03 - Isa.flac`))).toBe(true);
    expect(await albumTag(`${VERT}/03 - Isa.flac`)).toBe('Vertebrae');
    await rm(abs(`${ISA}/02 - Isa.flac`));
  });

  it('moves the files and their tags, then Undo puts both back', async () => {
    const before = await tracksOf(vertId);
    const isaSongs = before.filter((t) => t.title === 'Isa' || t.title === 'Return to Yggdrasill');
    const id = await newMove(vertId, isaSongs.map((t) => t.id), { albumId: isaId });
    await plan(id);
    const out = await run(id, 'move');
    expect(out).toMatchObject({ state: 'done', files: 2 });
    // on disk: new names, the Isa tags, the audio untouched (SafeFileWriter checked it)
    expect(await there(abs(`${VERT}/03 - Isa.flac`))).toBe(false);
    expect(await albumTag(`${ISA}/02 - Isa.flac`)).toBe('Isa');
    expect((await parseFile(abs(`${ISA}/03 - Return to Yggdrasill.flac`))).common.track.no).toBe(3);
    // the rows kept their ids; the albums regrouped
    const files = await sql`select id::text as id, rel_path as "relPath" from files where id = any(${isaSongs.map((t) => t.fileId)}::uuid[]) order by rel_path`;
    expect(files.map((f: any) => f.relPath)).toEqual([`${ISA}/02 - Isa.flac`, `${ISA}/03 - Return to Yggdrasill.flac`]);
    expect((await tracksOf(isaId)).map((t) => t.title)).toEqual(['Intro', 'Isa', 'Return to Yggdrasill']);
    expect((await tracksOf(vertId)).map((t) => t.title)).toEqual(['Clouds', 'To the Coast', 'Path to Vanir']);
    const linked = await sql`select count(*)::int as n from local_tracks where local_album_id = ${isaId} and canonical_track_id is not null`;
    expect(linked[0].n).toBe(3);
    const [audit] = await sql`select action, payload from audit_log where library_id = ${libraryId} and action = 'album.move' order by at desc limit 1`;
    expect(audit.payload.moveId).toBe(id);
    expect((await moveRow(id)).journal.files).toHaveLength(2);

    // Undo: the paths and the tags as they were
    expect(await run(id, 'undo')).toMatchObject({ state: 'undone', problems: 0 });
    expect(await albumTag(`${VERT}/03 - Isa.flac`)).toBe('Vertebrae');
    expect(await there(abs(`${ISA}/02 - Isa.flac`))).toBe(false);
    expect((await tracksOf(vertId)).map((t) => t.title).sort()).toEqual(['Clouds', 'Isa', 'Path to Vanir', 'Return to Yggdrasill', 'To the Coast']);
    expect((await tracksOf(isaId)).map((t) => t.title)).toEqual(['Intro']);
    expect((await moveRow(id)).state).toBe('undone');
  }, 60_000);

  it('a release with no folder gets "<Album artist>/<Year> - <Album>", and the new album its release', async () => {
    const vanir = (await tracksOf(vertId)).find((t) => t.title === 'Path to Vanir')!;
    const id = await newMove(vertId, [vanir.id], { releaseMbid: rel['ruun']!.mbid });
    const p = await plan(id);
    expect(p).toMatchObject({ toDir: 'Enslaved/2006 - Ruun', newFolder: true });
    expect(p.files[0]!.toPath).toBe('Enslaved/2006 - Ruun/01 - Path to Vanir.flac');
    expect(await run(id, 'move')).toMatchObject({ state: 'done' });
    expect(await albumTag('Enslaved/2006 - Ruun/01 - Path to Vanir.flac')).toBe('Ruun');
    const ruunAlbum = await albumIn('Enslaved/2006 - Ruun');
    expect(ruunAlbum).toBeTruthy();
    expect(sent.find((s) => s.name === 'identify.album')?.data).toMatchObject({ localAlbumId: ruunAlbum, pinnedMbid: rel['ruun']!.mbid });
    // Undo takes the made folder into the trash, never rmdir
    expect(await run(id, 'undo')).toMatchObject({ state: 'undone' });
    expect(await there(abs('Enslaved/2006 - Ruun'))).toBe(false);
    expect(await there(abs(`.tagave-trash/2026-11-04/Enslaved/2006 - Ruun`))).toBe(true);
    expect(await there(abs(`${VERT}/05 - Path to Vanir.flac`))).toBe(true);
  }, 60_000);

  it('an emptied source folder goes into the trash; Undo brings it back', async () => {
    const LONE = 'Enslaved/Stray';
    await mkdir(abs(LONE), { recursive: true });
    makeFlac(abs(`${LONE}/Isa.flac`), { title: 'Isa', album: 'Stray', track: 1, seconds: 5 });
    await scan(LONE);
    const loneId = (await albumIn(LONE))!;
    const [t] = await tracksOf(loneId);
    const id = await newMove(loneId, [t!.id], { albumId: isaId });
    await plan(id);
    expect(await run(id, 'move')).toMatchObject({ state: 'done' });
    expect(await there(abs(LONE))).toBe(false);
    expect(await there(abs(`.tagave-trash/2026-11-04/${LONE}`))).toBe(true);
    expect((await moveRow(id)).journal.trashedDir).toMatchObject({ dir: LONE });
    expect(await run(id, 'undo')).toMatchObject({ state: 'undone' });
    expect(await there(abs(`${LONE}/Isa.flac`))).toBe(true);
    expect(await albumTag(`${LONE}/Isa.flac`)).toBe('Stray');
  }, 60_000);

  it('a failed tag write puts back the tags already written and moves nothing', async () => {
    const isaSongs = (await tracksOf(vertId)).filter((t) => t.title === 'Isa' || t.title === 'Return to Yggdrasill');
    const id = await newMove(vertId, isaSongs.map((t) => t.id), { albumId: isaId });
    await plan(id);
    const real = deps.writer;
    let n = 0;
    const writes: TagSet[] = [];
    deps = { ...deps, writer: { write: async (p, t, o) => { writes.push(t); n++; return n === 2 ? { error: 'audio changed', code: 'hash_mismatch' } : real.write(p, t, o); } } };
    try {
      expect(await run(id, 'move')).toMatchObject({ state: 'failed' });
    } finally {
      deps = { ...deps, writer: real };
    }
    expect((await moveRow(id)).error).toMatch(/the audio would change/);
    // the first file's tags went back (the third write is the revert)
    expect(writes).toHaveLength(3);
    expect(await albumTag(`${VERT}/03 - Isa.flac`)).toBe('Vertebrae');
    expect(await albumTag(`${VERT}/04 - Return to Yggdrasill.flac`)).toBe('Vertebrae');
    expect((await readdir(abs(ISA))).sort()).toEqual(['01 - Intro.flac']);
  }, 60_000);

  it('a read-only music folder stops the move', async () => {
    const isa = (await tracksOf(vertId)).find((t) => t.title === 'Isa')!;
    const id = await newMove(vertId, [isa.id], { albumId: isaId });
    await plan(id);
    await sql`update scan_roots set probe_writable = false where id = ${rootId}`;
    try {
      expect(await run(id, 'move')).toMatchObject({ state: 'failed', error: 'The music folder is read-only' });
    } finally {
      await sql`update scan_roots set probe_writable = true where id = ${rootId}`;
    }
    expect(await there(abs(`${VERT}/03 - Isa.flac`))).toBe(true);
  });

  it('looks a release up on MusicBrainz and says which one the library already holds', async () => {
    const isa = (await tracksOf(vertId)).find((t) => t.title === 'Isa')!;
    const [r] = await sql`insert into album_moves (library_id, source_album_id, source_track_ids, state, query, created_by)
                          values (${libraryId}, ${vertId}, ${[isa.id]}::uuid[], 'searching', ${JSON.stringify({ artist: 'Enslaved', title: 'Isa' })}::jsonb, ${userId})
                          returning id::text as id`;
    const asked: unknown[] = [];
    const release = (id: string, title: string) => ({
      source: 'mb_search' as const,
      release: { id, releaseGroupId: randomUUID(), title, artists: ['Enslaved'], date: '2004-11-01', country: 'NO', media: 'CD', source: 'musicbrainz' as const,
        tracks: [{ title: 'Intro', artists: [], duration: 3500, position: 1, mediumNumber: 1 }] },
    });
    const out = await filesMoveJob(ctx, { moveId: r.id, action: 'search' }, {
      ...deps, search: async (q) => { asked.push(q); return [release(rel['isa']!.mbid, 'Isa'), release(rel['isa']!.mbid, 'Isa'), release(randomUUID(), 'Isa (Bonus)')]; },
    });
    expect(out).toEqual({ state: 'choosing', candidates: 2 });
    expect(asked).toEqual([{ albumTitle: 'Isa', artistName: 'Enslaved' }]);
    const row = await moveRow(r.id);
    expect(row.candidates[0]).toMatchObject({ mbid: rel['isa']!.mbid, year: 2004, tracks: 1, localAlbumId: isaId });
    expect(row.candidates[1].localAlbumId).toBeNull();
  });
});
