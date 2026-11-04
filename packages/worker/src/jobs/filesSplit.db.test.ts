/**
 * Whole album in one file (0078) on the file worker, with the flac and
 * metaflac binaries stood in for by a runner that keeps sample counts and
 * makes PCM with silences where the tracks really meet: the detection rule,
 * Attention's gap, the plan (cuts moved into the silences, only ±6 s
 * decoded), the split (names, tags, the source into the trash with Restore,
 * the scan, the audit entry), and every way it stops with nothing kept.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import pino from 'pino';
import { makeDb, oneFileAlbums } from '@tagave/db';
import type { TagSet } from '@tagave/shared';
import type { WorkerContext } from '../lib/context.js';
import { FlacTools, type BinaryRunner, type RunResult } from '../lib/flacTools.js';
import { restoreWaiting } from '../lib/deletions.js';
import { filesSplitJob, type SplitDeps } from './filesSplit.js';
import { gapsRecomputeJob } from './gapsRecompute.js';

const there = (p: string) => access(p).then(() => true, () => false);
const RATE = 44_100;
/** the release: three tracks */
const LENGTHS = [20_000, 30_000, 25_000];
/** where the tracks really meet in the file: 0.5 s and -0.7 s off the release's lengths */
const TRUE_CUTS = [20.5 * RATE, 49.3 * RATE];
const TOTAL = 75 * RATE + 17;

interface Fake {
  runner: BinaryRunner;
  calls: string[][];
  /** samples of each file the fake flac wrote, by path */
  written: Map<string, number>;
  /** a written track one sample long (a boundary bug) */
  offByOne: Set<number>;
  /** a written track flac -t refuses */
  corrupt: Set<number>;
  failEncodeAt: number | null;
}

/** 16-bit stereo PCM of [skip, until): a tone, silent for 300 ms around each true cut. */
function windowPcm(skip: number, until: number): Buffer {
  const n = until - skip;
  const out = Buffer.alloc(n * 4);
  for (let i = 0; i < n; i++) {
    const s = skip + i;
    const silent = TRUE_CUTS.some((c) => Math.abs(s - c) < 0.15 * RATE);
    const v = silent ? 0 : Math.round(12_000 * Math.sin((2 * Math.PI * 440 * s) / RATE));
    out.writeInt16LE(v, i * 4);
    out.writeInt16LE(v, i * 4 + 2);
  }
  return out;
}

function fake(source: () => string): Fake {
  const f: Fake = { runner: null as never, calls: [], written: new Map(), offByOne: new Set(), corrupt: new Set(), failEncodeAt: null };
  let encodes = 0;
  const ok = (stdout = ''): RunResult => ({ code: 0, stdout: Buffer.from(stdout), stderr: '' });
  const arg = (args: readonly string[], name: string) => Number(args.find((a) => a.startsWith(`--${name}=`))!.split('=')[1]);
  f.runner = async (bin, args) => {
    f.calls.push([bin, ...args]);
    const file = args[args.length - 1]!;
    if (bin === 'metaflac') {
      if (args[0] === '--list') return ok('');
      const samples = file === source() ? TOTAL : f.written.get(file);
      if (samples === undefined) return { code: 1, stdout: Buffer.alloc(0), stderr: `${file}: ERROR: not a FLAC file` };
      const v = { '--show-sample-rate': RATE, '--show-channels': 2, '--show-bps': 16, '--show-total-samples': samples }[args[0]!];
      return ok(`${v}\n`);
    }
    if (args[0] === '-d') return { code: 0, stdout: windowPcm(arg(args, 'skip'), arg(args, 'until')), stderr: '' };
    if (args[0] === '-t') {
      const n = [...f.written.keys()].indexOf(file) + 1;
      return f.corrupt.has(n) ? { code: 1, stdout: Buffer.alloc(0), stderr: 'FRAME_CRC_MISMATCH' } : ok();
    }
    // encode: flac -s -8 --skip --until -o out src
    encodes++;
    const out = args[args.indexOf('-o') + 1]!;
    if (await there(out)) return { code: 1, stdout: Buffer.alloc(0), stderr: `ERROR: output file ${out} already exists, use -f to override` };
    await writeFile(out, `track ${encodes}`);
    if (f.failEncodeAt === encodes) return { code: 1, stdout: Buffer.alloc(0), stderr: 'ERROR: disk full' };
    f.written.set(out, arg(args, 'until') - arg(args, 'skip') + (f.offByOne.has(encodes) ? 1 : 0));
    return ok();
  };
  return f;
}

describe.skipIf(!process.env.TEST_DATABASE_URL)('files.split on the file worker (db)', () => {
  let ctx: WorkerContext;
  let sql: any;
  let rootPath: string;
  const userId = randomUUID();
  const libraryId = randomUUID();
  const rootId = randomUUID();
  const rgId = randomUUID();
  const releaseId = randomUUID();
  const sent: Array<{ name: string; data: unknown }> = [];
  const day = new Date('2026-11-04T10:00:00Z');
  let albumId: string;
  let fileId: string;
  let rel: string;
  let tagWrites: Array<{ path: string; tags: TagSet }>;
  let f: Fake;

  const deps = (): SplitDeps => ({
    tools: new FlacTools(f.runner, { flac: 'flac', metaflac: 'metaflac' }),
    tags: { write: async (p, tags) => { tagWrites.push({ path: p, tags }); } },
    now: () => day,
  });
  const abs = (r: string) => path.join(rootPath, r);
  const splitRow = async (id: string) => (await sql`select * from album_splits where id = ${id}`)[0];
  const newSplit = async (): Promise<string> => {
    const [r] = await sql`insert into album_splits (library_id, local_album_id, state, created_by)
                          values (${libraryId}, ${albumId}, 'analyzing', ${userId}) returning id::text as id`;
    return r.id;
  };
  const planned = async (): Promise<string> => {
    const id = await newSplit();
    await filesSplitJob(ctx, { splitId: id, action: 'analyze' }, deps());
    await sql`update album_splits set state = 'splitting' where id = ${id} and state = 'ready'`;
    return id;
  };

  /** A matched album: one file, or several, with a track row each. */
  async function album(dir: string, names: string[], fileMs: number, opts: { cue?: boolean } = {}): Promise<{ albumId: string; fileIds: string[] }> {
    await mkdir(abs(dir), { recursive: true });
    const id = randomUUID();
    await sql`insert into local_albums (id, library_id, cluster_key, title_guess, artist_guess, state, dir_paths, track_count, release_id, release_group_id)
              values (${id}, ${libraryId}, ${`ck-${id}`}, ${dir}, 'Artist', 'matched', ${[dir]}, ${names.length}, ${releaseId}, ${rgId})`;
    const fileIds: string[] = [];
    let n = 1;
    for (const name of names) {
      const r = `${dir}/${name}`;
      await writeFile(abs(r), `source ${r}`);
      const [file] = await sql`insert into files (library_id, scan_root_id, rel_path, size_bytes, mtime, status, handler, duration_ms, container)
                               values (${libraryId}, ${rootId}, ${r}, 10, 1, 'present', 'audio', ${fileMs}, 'FLAC') returning id::text as id`;
      await sql`insert into local_tracks (local_album_id, audio_file_id, track_no, title_guess, origin) values (${id}, ${file.id}, ${n++}, ${name}, 'file')`;
      fileIds.push(file.id);
    }
    if (opts.cue) await sql`insert into sidecar_files (library_id, scan_root_id, rel_path, kind) values (${libraryId}, ${rootId}, ${`${dir}/image.cue`}, 'cue')`;
    return { albumId: id, fileIds };
  }

  beforeAll(async () => {
    const made = await makeDb(process.env.TEST_DATABASE_URL!);
    sql = made.client;
    const boss = { send: async (name: string, data: unknown) => { sent.push({ name, data }); return 'job'; } };
    ctx = { db: made.db, sql: made.client, boss: boss as any, logger: pino({ level: 'silent' }) };
    await sql`insert into users (id, email, password_hash) values (${userId}, ${`split-${userId}@test.com`}, 'x')`;
    await sql`insert into libraries (id, name, owner_user_id, settings) values (${libraryId}, 'Split', ${userId}, '{}')`;
    rootPath = await mkdtemp(path.join(tmpdir(), 'tagave-split-'));
    await sql`insert into scan_roots (id, library_id, path, display_name, validation_status, writable, probe_writable)
              values (${rootId}, ${libraryId}, ${rootPath}, 'split', 'ok', true, true)`;
    await sql`insert into release_groups (id, mbid, title, artist_credit, primary_type)
              values (${rgId}, ${randomUUID()}, 'Strapping Young Lad', ${JSON.stringify([{ name: 'Strapping Young Lad', mbid: randomUUID() }])}::jsonb, 'Album')`;
    await sql`insert into releases (id, release_group_id, mbid, title, date, track_count, media)
              values (${releaseId}, ${rgId}, ${randomUUID()}, 'Strapping Young Lad', '2003-02-03', 3, ${JSON.stringify([{ format: 'CD' }])}::jsonb)`;
    for (const [i, len] of LENGTHS.entries()) {
      await sql`insert into canonical_tracks (release_id, medium_no, position, number, title, length_ms, recording_mbid, track_mbid)
                values (${releaseId}, 1, ${i + 1}, ${String(i + 1)}, ${['Dirt Pride', 'Rape Song / Live', 'Aftermath'][i]!}, ${len}, ${randomUUID()}, ${randomUUID()})`;
    }
    const a = await album('Strapping Young Lad/2003', ['10 - Bring on the Young.flac'], 75_000);
    albumId = a.albumId;
    fileId = a.fileIds[0]!;
    rel = 'Strapping Young Lad/2003/10 - Bring on the Young.flac';
  });

  beforeEach(() => {
    tagWrites = [];
    sent.length = 0;
    f = fake(() => abs(rel));
  });

  afterAll(async () => {
    await sql`delete from scan_roots where id = ${rootId}`;
    await sql`delete from libraries where id = ${libraryId}`;
    await sql`delete from releases where id = ${releaseId}`;
    await sql`delete from release_groups where id = ${rgId}`;
    await sql`delete from users where id = ${userId}`;
    await sql.end({ timeout: 5 });
    await rm(rootPath, { recursive: true, force: true });
  });

  it('finds albums that are one FLAC within max(20 s, 1 %) of the release, and nothing else', async () => {
    const twoFiles = await album('Other/Two files', ['01.flac', '02.flac'], 37_500);
    const tooLong = await album('Other/Too long', ['all.flac'], 96_000);
    const withCue = await album('Other/With cue', ['image.flac'], 75_000, { cue: true });
    const close = await album('Other/Close', ['all.flac'], 75_000 + 19_000);
    const found = (await oneFileAlbums(sql, libraryId)).map((a) => a.albumId);
    expect(found).toContain(albumId);
    expect(found).toContain(close.albumId);
    for (const no of [twoFiles, tooLong, withCue]) expect(found).not.toContain(no.albumId);
    // a length unknown on the release: nothing fits
    await sql`update canonical_tracks set length_ms = null where release_id = ${releaseId} and position = 3`;
    expect(await oneFileAlbums(sql, libraryId)).toEqual([]);
    await sql`update canonical_tracks set length_ms = ${LENGTHS[2]!} where release_id = ${releaseId} and position = 3`;
    await sql`delete from local_albums where id = any(${[twoFiles.albumId, tooLong.albumId, withCue.albumId, close.albumId]}::uuid[])`;
  });

  it('lists the album in Attention as "one_file_album"', async () => {
    await gapsRecomputeJob(ctx, { libraryId });
    const gaps = await sql`select subject_id::text as id, state, details from gaps where library_id = ${libraryId} and kind = 'one_file_album'`;
    expect(gaps).toEqual([{ id: albumId, state: 'open', details: { fileId, fileMs: 75_000, releaseMs: 75_000, tracks: 3 } }]);
  });

  it('plans: each inner cut moves into the silence, decoding only ±6 s around it', async () => {
    const id = await newSplit();
    const out = await filesSplitJob(ctx, { splitId: id, action: 'analyze' }, deps());
    expect(out).toMatchObject({ state: 'ready', tracks: 3, low: 0 });
    const r = await splitRow(id);
    expect(r.state).toBe('ready');
    const plan = r.plan;
    expect(plan.totalSamples).toBe(TOTAL);
    expect(plan.tracks.map((t: any) => t.fileName)).toEqual(['01 - Dirt Pride.flac', '02 - Rape Song Live.flac', '03 - Aftermath.flac']);
    expect(plan.tracks.map((t: any) => t.confidence)).toEqual([null, 'high', 'high']);
    // within a frame (10 ms) of the true cut
    expect(Math.abs(plan.tracks[1].startSample - TRUE_CUTS[0]!)).toBeLessThan(0.01 * RATE);
    expect(Math.abs(plan.tracks[2].startSample - TRUE_CUTS[1]!)).toBeLessThan(0.01 * RATE);
    expect(plan.tracks[1].shiftMs).toBeGreaterThan(490);
    expect(plan.tracks[2].shiftMs).toBeLessThan(-690);
    expect(plan.tracks.at(-1).endSample).toBe(TOTAL);
    const decodes = f.calls.filter((c) => c[1] === '-d');
    expect(decodes.map((c) => [c.find((a) => a.startsWith('--skip=')), c.find((a) => a.startsWith('--until='))])).toEqual([
      [`--skip=${14 * RATE}`, `--until=${26 * RATE}`],
      [`--skip=${44 * RATE}`, `--until=${56 * RATE}`],
    ]);
    // a plan writes nothing
    expect(await readdir(abs('Strapping Young Lad/2003'))).toEqual(['10 - Bring on the Young.flac']);
    await sql`update album_splits set state = 'failed' where id = ${id}`;
  });

  it('never overwrites: a track name already taken stops the split before anything is written', async () => {
    const taken = abs('Strapping Young Lad/2003/02 - Rape Song Live.flac');
    await writeFile(taken, 'the owner’s own file');
    const id = await planned();
    const out = await filesSplitJob(ctx, { splitId: id, action: 'split' }, deps());
    expect(out).toEqual({ state: 'failed', error: '02 - Rape Song Live.flac is already in the folder' });
    expect(await readFile(taken, 'utf8')).toBe('the owner’s own file');
    expect(f.calls.filter((c) => c.includes('-o'))).toEqual([]);
    expect(await readFile(abs(rel), 'utf8')).toBe(`source ${rel}`);
    await rm(taken);
  });

  it('stops with nothing kept when a written track is one sample off, and leaves the source alone', async () => {
    const id = await planned();
    f.offByOne.add(2);
    const out = await filesSplitJob(ctx, { splitId: id, action: 'split' }, deps());
    expect(out.state).toBe('failed');
    expect(String(out['error'])).toContain('Track 2 holds');
    expect(String(out['error'])).toContain(`the source ${TOTAL}`);
    expect(await readdir(abs('Strapping Young Lad/2003'))).toEqual(['10 - Bring on the Young.flac']);
    expect(await readFile(abs(rel), 'utf8')).toBe(`source ${rel}`);
    expect((await sql`select count(*)::int as n from file_deletions where file_id = ${fileId}`)[0].n).toBe(0);
    const [a] = await sql`select action, payload from audit_log where library_id = ${libraryId} and action = 'album.split.failed' order by at desc limit 1`;
    expect(a.payload.splitId).toBe(id);
  });

  it('stops with nothing kept when a track does not decode, or flac fails half-way', async () => {
    let id = await planned();
    f.corrupt.add(3);
    expect((await filesSplitJob(ctx, { splitId: id, action: 'split' }, deps())).error).toBe('Track 3 does not decode');
    expect(await readdir(abs('Strapping Young Lad/2003'))).toEqual(['10 - Bring on the Young.flac']);
    f = fake(() => abs(rel));
    f.failEncodeAt = 2;
    id = await planned();
    expect((await filesSplitJob(ctx, { splitId: id, action: 'split' }, deps())).error).toBe('flac could not write a track: ERROR: disk full');
    expect(await readdir(abs('Strapping Young Lad/2003'))).toEqual(['10 - Bring on the Young.flac']);
  });

  it('refuses a read-only music folder', async () => {
    const id = await planned();
    await sql`update scan_roots set probe_writable = false where id = ${rootId}`;
    expect((await filesSplitJob(ctx, { splitId: id, action: 'split' }, deps())).error).toBe('The music folder is read-only');
    await sql`update scan_roots set probe_writable = true where id = ${rootId}`;
    expect(f.calls.filter((c) => c.includes('-o'))).toEqual([]);
  });

  it('splits: the tracks, tagged from the release; the source into the trash; a scan; an audit entry', async () => {
    const id = await planned();
    const out = await filesSplitJob(ctx, { splitId: id, action: 'split' }, deps());
    expect(out).toEqual({ state: 'done', tracks: 3 });
    const dir = 'Strapping Young Lad/2003';
    expect((await readdir(abs(dir))).sort()).toEqual(['01 - Dirt Pride.flac', '02 - Rape Song Live.flac', '03 - Aftermath.flac']);
    // losslessly re-encoded at -8 from exactly the planned samples
    const plan = (await splitRow(id)).plan;
    const encodes = f.calls.filter((c) => c.includes('-o'));
    expect(encodes.map((c) => c.slice(1, 5))).toEqual(plan.tracks.map((t: any) => ['-s', '-8', `--skip=${t.startSample}`, `--until=${t.endSample}`]));
    // tags from the release, written before the tracks took their names
    expect(tagWrites).toHaveLength(3);
    expect(tagWrites.every((w) => path.basename(w.path).startsWith('.tagave-split-'))).toBe(true);
    expect(tagWrites[1]!.tags).toMatchObject({
      title: 'Rape Song / Live', album: 'Strapping Young Lad', artist: 'Strapping Young Lad', albumartist: 'Strapping Young Lad',
      tracknumber: '2', totaltracks: '3', discnumber: '1', totaldiscs: '1', date: '2003-02-03',
    });
    expect(tagWrites[1]!.tags['musicbrainz_albumid']).toMatch(/^[0-9a-f-]{36}$/);
    expect(tagWrites[1]!.tags['musicbrainz_releasetrackid']).toMatch(/^[0-9a-f-]{36}$/);
    // the source in the trash, as Deleting's Trash leaves it
    const trashRel = `.tagave-trash/2026-11-04/${rel}`;
    expect(await there(abs(rel))).toBe(false);
    expect(await readFile(abs(trashRel), 'utf8')).toBe(`source ${rel}`);
    expect(await there(abs('.tagave-trash/.ndignore'))).toBe(true);
    expect((await sql`select kind, state, trash_rel_path from file_deletions where file_id = ${fileId}`)[0])
      .toEqual({ kind: 'trash', state: 'trashed', trash_rel_path: trashRel });
    const r = await splitRow(id);
    expect(r.state).toBe('done');
    expect(r.outputs).toEqual([`${dir}/01 - Dirt Pride.flac`, `${dir}/02 - Rape Song Live.flac`, `${dir}/03 - Aftermath.flac`]);
    expect(sent.find((s) => s.name === 'scan.dir')).toEqual({ name: 'scan.dir', data: { scanRootId: rootId, dirPath: dir, reason: 'split' } });
    const [a] = await sql`select actor_user_id::text as actor, payload from audit_log where library_id = ${libraryId} and action = 'album.split'`;
    expect(a).toMatchObject({ actor: userId, payload: { splitId: id, source: rel, trash: trashRel } });
    expect((await sql`select state from gaps where kind = 'one_file_album' and subject_id = ${albumId}`)[0].state).toBe('resolved');
    // no longer one file that fits: a second split is refused
    expect(await oneFileAlbums(sql, libraryId, albumId)).toEqual([]);
  });

  it('Restore puts the source back where it was', async () => {
    await sql`update file_deletions set state = 'restoring' where file_id = ${fileId}`;
    expect(await restoreWaiting(ctx, libraryId)).toMatchObject({ restored: 1 });
    expect(await readFile(abs(rel), 'utf8')).toBe(`source ${rel}`);
  });
});
