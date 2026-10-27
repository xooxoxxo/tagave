/**
 * 0060: a database at 0059 with tracks and albums is upgraded; title and
 * year sources are backfilled only when the file tags carry the value.
 */
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { getTableColumns } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { albumEvidence, localAlbums, localTracks, matchCandidates } from '@tagave/db';
import { createScratchDb, migrateAll, migrateUpTo } from '../testkit/authApp.js';

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)('0060 matching evidence (upgrade with data)', () => {
  let admin: postgres.Sql; let db: { url: string; name: string } | undefined; let sql: postgres.Sql;
  const ids = {
    user: randomUUID(), lib: randomUUID(), root: randomUUID(), tagged: randomUUID(), named: randomUUID(),
    titleTag: randomUUID(), titleFolder: randomUUID(), empty: randomUUID(),
  };
  const fTag = randomUUID(); const fName = randomUUID(); const fNoYear = randomUUID();
  const fAlbumTag = randomUUID(); const fAlbumBlank = randomUUID(); const fNoAlbum = randomUUID();

  beforeAll(async () => {
    admin = postgres(url!, { max: 1, onnotice: () => undefined });
    db = await createScratchDb(url!, admin);
    await migrateUpTo(db.url, '0060');
    sql = postgres(db.url, { max: 2, onnotice: () => undefined });
    await sql`insert into users (id, email, display_name, password_hash) values (${ids.user}, ${'e-' + ids.user + '@test.com'}, 'E', 'x')`;
    await sql`insert into libraries (id, owner_user_id, name, settings) values (${ids.lib}, ${ids.user}, 'E', '{}')`;
    await sql`insert into scan_roots (id, library_id, path, display_name) values (${ids.root}, ${ids.lib}, '/music', 'm')`;
    await sql`insert into files (id, handler, library_id, scan_root_id, rel_path, size_bytes, mtime, status, tags_raw) values
      (${fTag}, 'audio', ${ids.lib}, ${ids.root}, 'A/1.flac', 1, 1, 'present', ${JSON.stringify({ common: { title: 'Eins', year: 2011 } })}::text::jsonb),
      (${fName}, 'audio', ${ids.lib}, ${ids.root}, 'B/01 zwei.flac', 1, 1, 'present', ${JSON.stringify({ common: { album: 'B' } })}::text::jsonb),
      (${fNoYear}, 'audio', ${ids.lib}, ${ids.root}, 'B/02 drei.flac', 1, 1, 'present', '{}'::jsonb),
      (${fAlbumTag}, 'audio', ${ids.lib}, ${ids.root}, 'C/1.flac', 1, 1, 'present', ${JSON.stringify({ common: { title: 'Vier', album: 'Cee' } })}::text::jsonb),
      (${fAlbumBlank}, 'audio', ${ids.lib}, ${ids.root}, 'D/1.flac', 1, 1, 'present', ${JSON.stringify({ common: { title: 'Fuenf', album: '  ' } })}::text::jsonb),
      (${fNoAlbum}, 'audio', ${ids.lib}, ${ids.root}, 'D/2.flac', 1, 1, 'present', ${JSON.stringify({ common: { title: 'Sechs' } })}::text::jsonb)`;
    await sql`insert into local_albums (id, library_id, cluster_key, state, year_guess) values
      (${ids.tagged}, ${ids.lib}, 'k-a', 'needs_review', 2011), (${ids.named}, ${ids.lib}, 'k-b', 'needs_review', 1999),
      (${ids.titleTag}, ${ids.lib}, 'k-c', 'needs_review', null), (${ids.titleFolder}, ${ids.lib}, 'k-d', 'needs_review', null),
      (${ids.empty}, ${ids.lib}, 'k-e', 'needs_review', null)`;
    await sql`insert into local_tracks (local_album_id, audio_file_id, track_no, title_guess) values
      (${ids.tagged}, ${fTag}, 1, 'Eins'), (${ids.named}, ${fName}, 1, '01 zwei'), (${ids.named}, ${fNoYear}, 2, '02 drei'),
      (${ids.titleTag}, ${fAlbumTag}, 1, 'Vier'), (${ids.titleFolder}, ${fAlbumBlank}, 1, 'Fuenf'), (${ids.titleFolder}, ${fNoAlbum}, 2, 'Sechs')`;
    await migrateAll(db.url);
  }, 120_000);

  afterAll(async () => {
    await sql?.end({ timeout: 2 });
    if (db) await admin.unsafe(`drop database if exists ${db.name} with (force)`).catch(() => undefined);
    await admin?.end({ timeout: 2 });
  });

  it('adds the evidence columns and table', async () => {
    const cols = await sql`select table_name, column_name from information_schema.columns
      where (table_name = 'match_candidates' and column_name in ('evidence', 'acoustid_coverage'))
         or (table_name = 'local_tracks' and column_name = 'title_source')
         or (table_name = 'local_albums' and column_name in ('year_source', 'title_source'))
         or table_name = 'album_evidence' order by 1, 2`;
    expect(cols.map((c) => `${c['table_name']}.${c['column_name']}`)).toEqual([
      'album_evidence.evidence', 'album_evidence.local_album_id', 'album_evidence.updated_at', 'album_evidence.v',
      'local_albums.title_source', 'local_albums.year_source', 'local_tracks.title_source',
      'match_candidates.acoustid_coverage', 'match_candidates.evidence',
    ]);
  });

  it('the drizzle schema has every column of the tables 0060 changed', async () => {
    const tables = { match_candidates: matchCandidates, local_tracks: localTracks, local_albums: localAlbums, album_evidence: albumEvidence };
    for (const [name, table] of Object.entries(tables)) {
      const inDb = (await sql<Array<{ c: string }>>`select column_name as c from information_schema.columns where table_name = ${name}`).map((r) => r.c).sort();
      const inSchema = Object.values(getTableColumns(table)).map((c) => c.name).sort();
      expect(inSchema, name).toEqual(inDb);
    }
  });

  it('a title is from the tags only when the tags carry one', async () => {
    const rows = await sql`select audio_file_id, title_source from local_tracks where audio_file_id in (${fTag}, ${fName}, ${fNoYear})`;
    const by = new Map(rows.map((r) => [r['audio_file_id'], r['title_source']]));
    expect(by.get(fTag)).toBe('tag');
    expect(by.get(fName)).toBe('filename');
    expect(by.get(fNoYear)).toBe('filename');
  });

  it('a year is from the tags only when a file carries one; otherwise it came from the folder', async () => {
    const rows = await sql`select id, year_source from local_albums where id in (${ids.tagged}, ${ids.named}, ${ids.titleTag})`;
    const by = new Map(rows.map((r) => [r['id'], r['year_source']]));
    expect(by.get(ids.tagged)).toBe('tag');
    expect(by.get(ids.named)).toBe('folder');
    expect(by.get(ids.titleTag)).toBeNull();
  });

  it('an album title is from the tags when a file carries an album tag, from the folder when none does', async () => {
    const rows = await sql`select id, title_source from local_albums where library_id = ${ids.lib}`;
    const by = new Map(rows.map((r) => [r['id'], r['title_source']]));
    expect(by.get(ids.titleTag)).toBe('tag');
    expect(by.get(ids.named)).toBe('tag');
    // a blank album tag is no tag
    expect(by.get(ids.titleFolder)).toBe('folder');
    expect(by.get(ids.tagged)).toBe('folder');
    // no files: not known
    expect(by.get(ids.empty)).toBeNull();
  });

  it('refuses values outside the vocabulary', async () => {
    await expect(sql`update local_tracks set title_source = 'guess' where audio_file_id = ${fTag}`).rejects.toThrow(/check/);
    await expect(sql`update local_albums set title_source = 'guess' where id = ${ids.titleTag}`).rejects.toThrow(/check/);
    await expect(sql`update local_albums set year_source = 'filename' where id = ${ids.tagged}`).rejects.toThrow(/check/);
  });
});
