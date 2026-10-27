/**
 * The scan snapshot gate: the fixture corpus (testkit/scanCorpus.ts) scanned
 * by the real jobs (scan.root, scan.parse, cluster.dir, art.fetch), changed
 * (a rename, a move to another root, a copy with the originals deleted, a
 * deleted file, a re-tag, a new album) and scanned again. Every row those jobs
 * write, and every job they send, must equal the golden file. The golden was
 * taken on the code before the files-core refactor (0058); a change that is
 * meant to alter scan output rewrites it with UPDATE_SCAN_GOLDEN=1, and the
 * diff of the golden file is then part of the review.
 *
 * Ids, inodes, timestamps and the temp folders differ between runs, so each
 * id is replaced by a label taken where it was first seen (a file's first
 * path, an album's first cluster key) and timestamps by '<time>'.
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import pino from 'pino';
import { describe, expect, it } from 'vitest';
import { makeDb } from '@tagave/db';
import type { WorkerContext } from '../lib/context.js';
import { drainJobs, type Sent } from '../testkit/moveLab.js';
import { changeCorpus, writeCorpus } from '../testkit/scanCorpus.js';
import { scanRootJob } from './scanRoot.js';

const url = process.env.TEST_DATABASE_URL;
const GOLDEN = path.join(path.dirname(fileURLToPath(import.meta.url)), '../testkit/scanCorpus.golden.json');

const LIB = '5ca1ab1e-0058-4000-8000-000000000001';
const USER = '5ca1ab1e-0058-4000-8000-000000000002';
const ROOTS = ['5ca1ab1e-0058-4000-8000-000000000003', '5ca1ab1e-0058-4000-8000-000000000004'] as const;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Keys whose values depend on the clock or on how long a step took. */
const CLOCK_KEYS = new Set(['elapsedS']);

type Row = Record<string, unknown>;

class Labels {
  private byId = new Map<string, string>([[LIB, '<library>'], [USER, '<user>'], [ROOTS[0], '<root0>'], [ROOTS[1], '<root1>']]);
  private used = new Set(this.byId.values());
  learn(id: string, base: string): void {
    if (this.byId.has(id)) return;
    let label = base;
    for (let n = 2; this.used.has(label); n++) label = `${base}#${n}`;
    this.byId.set(id, label);
    this.used.add(label);
  }
  of(id: string): string | undefined { return this.byId.get(id); }
  /** Replaces every known id inside a string (a cache path names the album). */
  inText(s: string): string {
    return s.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, (m) => this.byId.get(m) ?? '<uuid>');
  }
}

function normalize(labels: Labels, cacheDir: string, key: string, v: unknown): unknown {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return '<time>';
  if (Buffer.isBuffer(v)) return `<${v.length} bytes>`;
  if (Array.isArray(v)) return v.map((x) => normalize(labels, cacheDir, key, x));
  if (typeof v === 'object') {
    const out: Row = {};
    for (const k of Object.keys(v as Row).sort()) {
      if (CLOCK_KEYS.has(k)) continue;
      out[k] = normalize(labels, cacheDir, k, (v as Row)[k]);
    }
    return out;
  }
  if (typeof v === 'string') {
    if (UUID_RE.test(v)) return labels.of(v) ?? '<uuid>';
    if (key.endsWith('_at') || key.endsWith('At')) return '<time>';
    if (key === 'inode') return /^\d+:\d+$/.test(v) ? '<dev:ino>' : v;
    if (key === 'local_path') return labels.inText(v.split(cacheDir).join('<cache>'));
    return v;
  }
  return v;
}

describe.skipIf(!url)('scan snapshot over the fixture corpus (integration)', () => {
  it('writes the rows and sends the jobs in the golden file', async () => {
    const cacheDir = await mkdtemp(path.join(tmpdir(), 'tagave-corpus-cache-'));
    process.env.CACHE_DIR = cacheDir;
    // after CACHE_DIR: art.fetch reads it when the module loads
    const { artFetchJob } = await import('./artFetch.js');
    const made = await makeDb(url!);
    const sql: any = made.client;
    const sent: Sent[] = [];
    const ctx: WorkerContext = {
      db: made.db, sql,
      boss: { send: async (name: string, data: unknown, opts: unknown) => { sent.push({ name, data, opts }); return randomUUID(); } } as any,
      logger: pino({ level: 'silent' }),
    };
    // files since 0058, audio_files before: the golden is taken on both sides of the rename
    const [{ t }] = await sql`select to_regclass('public.files')::text as t`;
    const FILES: string = t ? 'files' : 'audio_files';
    const base = await mkdtemp(path.join(tmpdir(), 'tagave-corpus-'));
    const roots: [string, string] = [path.join(base, 'root0'), path.join(base, 'root1')];

    const cleanup = async () => {
      await sql`delete from tag_plans where library_id = ${LIB}`;
      await sql`delete from images where library_id = ${LIB}`;
      await sql`delete from local_albums where library_id = ${LIB}`;
      await sql`delete from scan_roots where library_id = ${LIB}`;
      await sql`delete from libraries where id = ${LIB}`;
      await sql`delete from users where id = ${USER}`;
    };
    try {
      await cleanup();
      await writeCorpus(roots);
      await sql`insert into users (id, email, password_hash) values (${USER}, 'corpus@test.com', 'x')`;
      await sql`insert into libraries (id, name, owner_user_id, settings) values (${LIB}, 'Corpus', ${USER}, '{}')`;
      for (const [i, id] of ROOTS.entries()) {
        await sql`insert into scan_roots (id, library_id, path, display_name, validation_status) values (${id}, ${LIB}, ${roots[i]!}, ${`root${i}`}, 'ok')`;
      }

      const labels = new Labels();
      const rootLabel = (id: string) => labels.of(id) ?? '<root?>';
      const steps: Row = {};
      const extra: Row = {};

      const scan = async (root: 0 | 1, mode: 'full' | 'quick') => {
        await scanRootJob(ctx, { scanRootId: ROOTS[root], mode });
        await drainJobs(ctx, sent);
      };
      const artAll = async () => {
        const albums = await sql`select id from local_albums where library_id = ${LIB} order by cluster_key`;
        for (const a of albums) await artFetchJob(ctx, { localAlbumId: a.id as string });
      };

      const snapshot = async (): Promise<Row> => {
        const files = await sql`select * from ${sql(FILES)} where library_id = ${LIB} order by scan_root_id, rel_path`;
        for (const f of files) labels.learn(f.id, `file:${rootLabel(f.scan_root_id)}/${f.rel_path}`);
        const sidecars = await sql`select * from sidecar_files where library_id = ${LIB} order by scan_root_id, rel_path`;
        for (const s of sidecars) labels.learn(s.id, `sidecar:${rootLabel(s.scan_root_id)}/${s.rel_path}`);
        const albums = await sql`select * from local_albums where library_id = ${LIB} order by cluster_key`;
        for (const a of albums) labels.learn(a.id, `album:${(a.dir_paths as string[]).join('|')}:${a.cluster_key}`);
        const tracks = await sql`select lt.* from local_tracks lt join ${sql(FILES)} f on f.id = lt.audio_file_id
                                  where f.library_id = ${LIB}`;
        for (const tr of tracks) labels.learn(tr.id, `track:${labels.of(tr.audio_file_id)}@${tr.cue_start_ms ?? '-'}`);
        const images = await sql`select * from images where library_id = ${LIB}`;
        for (const im of images) labels.learn(im.id, `image:${labels.of(im.local_album_id) ?? '-'}:${im.kind}`);
        const scans = await sql`select s.scan_root_id, s.status, s.stats from scans s where s.scan_root_id = any(${[...ROOTS]}::uuid[]) order by s.started_at`;

        if (FILES === 'files') {
          // 0058's own columns, outside the golden: every corpus file is an audio file
          extra[`handlers ${Object.keys(steps).length}`] = [...new Set(files.map((f: Row) => `${f.handler} ${f.media_type ?? '-'}`))].sort();
          // the compatibility view reads exactly what the table holds (its old columns)
          const viaView = await sql`select * from audio_files where library_id = ${LIB} order by scan_root_id, rel_path`;
          const strip = ({ handler: _h, media_type: _m, ...rest }: Row) => rest;
          expect(viaView.map((r: Row) => normalize(labels, cacheDir, '', r))).toEqual(files.map((r: Row) => normalize(labels, cacheDir, '', strip(r))));
        }
        const n = (rows: Row[], sortKey: (r: Row) => string) =>
          rows.map((r) => {
            const { handler: _h, media_type: _m, ...rest } = r;
            return normalize(labels, cacheDir, '', rest) as Row;
          }).sort((a, b) => (sortKey(a) < sortKey(b) ? -1 : sortKey(a) > sortKey(b) ? 1 : 0));
        const jobs = sent.splice(0).map((j) => {
          const data = j.name === 'scan.parse'
            ? { audioFileIds: (j.data.audioFileIds as string[]).map((id) => labels.of(id) ?? '<uuid>').sort() }
            : normalize(labels, cacheDir, '', j.data);
          return JSON.stringify({ name: j.name, data, opts: normalize(labels, cacheDir, '', j.opts ?? null) });
        }).sort();
        return {
          files: n(files, (r) => String(r['id'])),
          sidecars: n(sidecars, (r) => String(r['id'])),
          albums: n(albums, (r) => String(r['id'])),
          tracks: n(tracks, (r) => String(r['id'])),
          images: n(images, (r) => String(r['id'])),
          scans: scans.map((s: Row) => normalize(labels, cacheDir, '', s)),
          unpumpedJobs: jobs,
        };
      };

      // A: the corpus as written, both roots, covers fetched
      await scan(0, 'full');
      await scan(1, 'full');
      await artAll();
      steps['A first scan'] = await snapshot();

      // B: the changes, root 0 first (the source of the cross-root move), then a quick scan that finds nothing new
      await changeCorpus(roots);
      await scan(0, 'full');
      await scan(1, 'full');
      await scan(0, 'quick');
      await artAll();
      steps['B after moves'] = await snapshot();

      if (FILES === 'files') {
        expect(extra).toEqual({
          'handlers 0': ['audio audio/flac', 'audio audio/mpeg', 'audio audio/wav'],
          'handlers 1': ['audio audio/flac', 'audio audio/mpeg', 'audio audio/wav'],
        });
      }
      const actual = JSON.parse(JSON.stringify(steps));
      if (process.env.UPDATE_SCAN_GOLDEN === '1' || !existsSync(GOLDEN)) {
        if (process.env.CI) throw new Error(`scan golden missing at ${GOLDEN}; run the test with UPDATE_SCAN_GOLDEN=1 locally`);
        await writeFile(GOLDEN, JSON.stringify(actual, null, 1) + '\n');
      }
      expect(actual).toEqual(JSON.parse(await readFile(GOLDEN, 'utf8')));
    } finally {
      await cleanup().catch(() => undefined);
      await sql.end({ timeout: 5 });
      await rm(base, { recursive: true, force: true });
      await rm(cacheDir, { recursive: true, force: true });
    }
  }, 180_000);
});
