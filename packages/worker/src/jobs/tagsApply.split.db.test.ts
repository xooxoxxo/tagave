/**
 * Tagging splits a whole album in one file first (0089), on real audio: a
 * 75 s FLAC made by ffmpeg with the tracks meeting in two silences, the flac
 * and metaflac steps done by ffmpeg and ffprobe (this Mac has no flac), the
 * tags written by the real mutagen sidecar. Apply splits, then the new tracks
 * carry the plan's values (fill blanks only keeps the source's album name);
 * Revert puts the source back and the tracks into the trash.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import pino from 'pino';
import { parseFile } from 'music-metadata';
import { makeDb } from '@tagave/db';
import type { WorkerContext } from '../lib/context.js';
import { FlacTools, type BinaryRunner, type RunResult } from '../lib/flacTools.js';
import { MutagenTagWriter } from '../lib/tagWriter.js';
import { filesSplitJob } from './filesSplit.js';
import { tagsApplyJob } from './tagsApply.js';
import { tagsRevertJob } from './tagsRevert.js';
import { tagsPreviewJob } from './tagsPreview.js';

const RATE = 44_100;
const LENGTHS = [20_000, 30_000, 25_000];
const TITLES = ['Dirt Pride', 'Rape Song / Live', 'Aftermath'];

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0 && spawnSync('ffprobe', ['-version']).status === 0;
const hasMutagen = !!process.env.TAGAVE_TAGWRITER_PYTHON;

function run(bin: string, args: string[]): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    let err = '';
    child.stdout.on('data', (d: Buffer) => out.push(d));
    child.stderr.on('data', (d: Buffer) => { err += d.toString(); });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout: Buffer.concat(out), stderr: err }));
  });
}

/** flac and metaflac, as files.split calls them, done by ffmpeg and ffprobe. */
const ffmpegRunner: BinaryRunner = async (bin, args) => {
  const file = args[args.length - 1]!;
  const num = (name: string) => Number(args.find((a) => a.startsWith(`--${name}=`))!.split('=')[1]);
  if (bin === 'metaflac') {
    if (args[0] === '--list') return { code: 0, stdout: Buffer.alloc(0), stderr: '' };
    const r = await run('ffprobe', ['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=sample_rate,channels,bits_per_raw_sample,duration_ts', '-of', 'json', file]);
    if (r.code !== 0) return r;
    const s = JSON.parse(r.stdout.toString()).streams[0];
    const v = { '--show-sample-rate': s.sample_rate, '--show-channels': s.channels, '--show-bps': s.bits_per_raw_sample, '--show-total-samples': s.duration_ts }[args[0]!];
    return { code: 0, stdout: Buffer.from(`${v}\n`), stderr: '' };
  }
  if (args[0] === '-d') {
    return run('ffmpeg', ['-v', 'error', '-i', file, '-af', `atrim=start_sample=${num('skip')}:end_sample=${num('until')}`, '-f', 's16le', '-acodec', 'pcm_s16le', '-']);
  }
  if (args[0] === '-t') return run('ffmpeg', ['-v', 'error', '-i', file, '-f', 'null', '-']);
  const out = args[args.indexOf('-o') + 1]!;
  return run('ffmpeg', ['-v', 'error', '-n', '-i', file, '-af', `atrim=start_sample=${num('skip')}:end_sample=${num('until')},asetpts=N/SR/TB`,
    '-map_metadata', '0', '-c:a', 'flac', '-sample_fmt', 's16', out]);
};

describe.skipIf(!process.env.TEST_DATABASE_URL || !hasFfmpeg || !hasMutagen)('a tag plan splits first, then tags; Revert undoes it (db, real audio)', () => {
  let ctx: WorkerContext;
  let sql: any;
  let rootPath: string;
  const userId = randomUUID();
  const libraryId = randomUUID();
  const rootId = randomUUID();
  const rgId = randomUUID();
  const releaseId = randomUUID();
  const albumId = randomUUID();
  const planId = randomUUID();
  const sent: Array<{ name: string; data: unknown }> = [];
  const dir = 'Strapping Young Lad/2003';
  const rel = `${dir}/whole.flac`;
  let fileId = '';
  let splitId = '';
  let writer: MutagenTagWriter;
  const abs = (r: string) => path.join(rootPath, r);
  const deps = () => ({ tools: new FlacTools(ffmpegRunner, { flac: 'flac', metaflac: 'metaflac' }), tags: writer, now: () => new Date('2026-11-05T10:00:00Z') });

  beforeAll(async () => {
    const made = await makeDb(process.env.TEST_DATABASE_URL!);
    sql = made.client;
    const boss = { send: async (name: string, data: unknown) => { sent.push({ name, data }); return 'job'; } };
    ctx = { db: made.db, sql: made.client, boss: boss as any, logger: pino({ level: 'silent' }) };
    writer = new MutagenTagWriter();
    rootPath = await mkdtemp(path.join(tmpdir(), 'tagave-tagsplit-'));
    await mkdir(abs(dir), { recursive: true });
    // 75 s of tone, silent for 300 ms where the tracks really meet (20.5 s and 49.3 s)
    const made75 = await run('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i',
      `aevalsrc='if(lt(abs(t-20.5),0.15)+lt(abs(t-49.3),0.15),0,0.3*sin(2*PI*440*t))|if(lt(abs(t-20.5),0.15)+lt(abs(t-49.3),0.15),0,0.3*sin(2*PI*440*t))':s=${RATE}:d=75`,
      '-c:a', 'flac', '-sample_fmt', 's16', '-metadata', 'album=My own album name', '-metadata', 'title=Whole album', '-metadata', 'genre=Metal', abs(rel)]);
    expect(made75.code, made75.stderr).toBe(0);

    await sql`insert into users (id, email, password_hash) values (${userId}, ${`tagsplit-${userId}@test.com`}, 'x')`;
    await sql`insert into libraries (id, name, owner_user_id, settings) values (${libraryId}, 'TagSplit', ${userId}, '{"tagWritesEnabled": true}')`;
    await sql`insert into scan_roots (id, library_id, path, display_name, validation_status, writable, probe_writable)
              values (${rootId}, ${libraryId}, ${rootPath}, 'tagsplit', 'ok', true, true)`;
    await sql`insert into release_groups (id, mbid, title, artist_credit, primary_type)
              values (${rgId}, ${randomUUID()}, 'Strapping Young Lad', ${JSON.stringify([{ name: 'Strapping Young Lad', mbid: randomUUID() }])}::jsonb, 'Album')`;
    await sql`insert into releases (id, release_group_id, mbid, title, date, track_count, media)
              values (${releaseId}, ${rgId}, ${randomUUID()}, 'Strapping Young Lad', '2003-02-03', 3, ${JSON.stringify([{ format: 'CD' }])}::jsonb)`;
    for (const [i, len] of LENGTHS.entries()) {
      await sql`insert into canonical_tracks (release_id, medium_no, position, number, title, length_ms, recording_mbid, track_mbid)
                values (${releaseId}, 1, ${i + 1}, ${String(i + 1)}, ${TITLES[i]!}, ${len}, ${randomUUID()}, ${randomUUID()})`;
    }
    await sql`insert into local_albums (id, library_id, cluster_key, title_guess, artist_guess, state, dir_paths, track_count, release_id, release_group_id)
              values (${albumId}, ${libraryId}, ${`ck-${albumId}`}, 'Whole', 'SYL', 'matched', ${[dir]}, 1, ${releaseId}, ${rgId})`;
    const tagsRaw = { common: { album: 'My own album name', title: 'Whole album', genre: ['Metal'] }, native: {} };
    const [f] = await sql`insert into files (library_id, scan_root_id, rel_path, size_bytes, mtime, status, handler, duration_ms, container, tags_raw)
                          values (${libraryId}, ${rootId}, ${rel}, 10, 1, 'present', 'audio', 75000, 'FLAC', ${JSON.stringify(tagsRaw)}::jsonb) returning id::text as id`;
    fileId = f.id;
    await sql`insert into local_tracks (local_album_id, audio_file_id, track_no, title_guess, origin) values (${albumId}, ${fileId}, 1, 'Whole', 'file')`;
    // the plan as POST /tag-plans makes it, with the split it linked (0089)
    await sql`insert into tag_plans (id, library_id, name, scope, policy, status, stats, created_by)
              values (${planId}, ${libraryId}, 'SYL tags', ${JSON.stringify({ type: 'albumIds', albumIds: [albumId] })}::jsonb,
                      ${JSON.stringify({ preset: 'fill_blanks_only', id3Version: '2.4', multiValueSeparator: '; ' })}::jsonb, 'draft', '{}', ${userId})`;
    const [s] = await sql`insert into album_splits (library_id, local_album_id, file_id, release_id, state, created_by, tag_plan_id)
                          values (${libraryId}, ${albumId}, ${fileId}, ${releaseId}, 'analyzing', ${userId}, ${planId}) returning id::text as id`;
    splitId = s.id;
  }, 60_000);

  afterAll(async () => {
    await writer?.close();
    await sql`delete from tag_plans where id = ${planId}`;
    await sql`delete from scan_roots where id = ${rootId}`;
    await sql`delete from libraries where id = ${libraryId}`;
    await sql`delete from releases where id = ${releaseId}`;
    await sql`delete from release_groups where id = ${rgId}`;
    await sql`delete from users where id = ${userId}`;
    await sql.end({ timeout: 5 });
    await rm(rootPath, { recursive: true, force: true });
  });

  it('finds the cuts in the real silences, and the preview leaves the source to the split', async () => {
    expect(await filesSplitJob(ctx, { splitId, action: 'analyze' }, deps())).toMatchObject({ state: 'ready', tracks: 3, low: 0 });
    await tagsPreviewJob(ctx, planId);
    const [plan] = await sql`select status, stats from tag_plans where id = ${planId}`;
    expect(plan.status).toBe('previewed');
    expect(plan.stats.filesSkipped).toEqual([{ audioFileId: fileId, reason: 'split_first', localAlbumId: albumId }]);
    expect((await sql`select count(*)::int as n from tag_plan_items where tag_plan_id = ${planId}`)[0].n).toBe(0);
  }, 60_000);

  it('Apply splits first, then the new tracks carry the plan\'s values', async () => {
    // what POST /apply does once the cuts are found
    await sql`update album_splits set state = 'splitting' where id = ${splitId}`;
    await tagsApplyJob(ctx, { planId }, { split: deps() });
    const [plan] = await sql`select status, stats from tag_plans where id = ${planId}`;
    expect(plan.status).toBe('applied');
    expect(plan.stats).toMatchObject({ splitsDone: 1, splitsFailed: 0, splitTracks: 3 });
    const [split] = await sql`select state, outputs from album_splits where id = ${splitId}`;
    expect(split.state).toBe('done');
    const names = ['01 - Dirt Pride.flac', '02 - Rape Song Live.flac', '03 - Aftermath.flac'];
    expect((await readdir(abs(dir))).sort()).toEqual(names);
    // cut in the real silences (20.5 s and 49.3 s), not at the release's lengths
    const trueMs = [20_500, 28_800, 25_700];
    for (const [i, name] of names.entries()) {
      const meta = await parseFile(abs(`${dir}/${name}`));
      expect(meta.common.title).toBe(TITLES[i]);
      expect(meta.common.track.no).toBe(i + 1);
      expect(meta.common.track.of).toBe(3);
      // fill blanks only: the source's album name stays, blanks take the release's
      expect(meta.common.album).toBe('My own album name');
      expect(meta.common.albumartist).toBe('Strapping Young Lad');
      expect(meta.common.date).toBe('2003-02-03');
      expect(meta.common.genre).toEqual(['Metal']);
      expect(Math.abs((meta.format.duration ?? 0) * 1000 - trueMs[i]!)).toBeLessThan(20);
    }
    // the source in the trash
    expect((await sql`select state from file_deletions where file_id = ${fileId}`)[0].state).toBe('trashed');
    expect(sent.some((s) => s.name === 'scan.dir')).toBe(true);
  }, 120_000);

  it('Revert puts the source back and the new tracks into the trash', async () => {
    sent.length = 0;
    await tagsRevertJob(ctx, { planId });
    expect(await readdir(abs(dir))).toEqual(['whole.flac']);
    const back = await parseFile(abs(rel));
    expect(back.common.title).toBe('Whole album');
    expect(Math.round(back.format.duration ?? 0)).toBe(75);
    expect((await sql`select count(*)::int as n from file_deletions where file_id = ${fileId}`)[0].n).toBe(0);
    const trashed = await readdir(abs(`.tagave-trash/2026-11-05/${dir}`));
    expect(trashed.sort()).toEqual(['01 - Dirt Pride.flac', '02 - Rape Song Live.flac', '03 - Aftermath.flac']);
    expect((await sql`select state from album_splits where id = ${splitId}`)[0].state).toBe('undone');
    expect((await sql`select status from tag_plans where id = ${planId}`)[0].status).toBe('reverted');
    expect(sent).toContainEqual({ name: 'scan.dir', data: { scanRootId: rootId, dirPath: dir, reason: 'split-undone' } });
    const [a] = await sql`select payload from audit_log where library_id = ${libraryId} and action = 'album.split.undone'`;
    expect(a.payload).toMatchObject({ splitId, planId, source: rel });
  }, 60_000);
});
