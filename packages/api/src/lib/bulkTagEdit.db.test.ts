/**
 * The folder tag editor covers exactly the files under the folder that music
 * claims (its manifest's handlers): a file of another handler under the same
 * folder is not one of them.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { makeDb } from '@tagave/db';
import { filesInFolder } from './bulkTagEdit.js';

describe.skipIf(!process.env.TEST_DATABASE_URL)('filesInFolder (db)', () => {
  let db: any;
  let client: any;
  const userId = randomUUID();
  const libraryId = randomUUID();
  const rootId = randomUUID();
  const tags = (title: string) => JSON.stringify({ common: { album: 'Mixed', artist: 'A', albumartist: 'A', title } });

  beforeAll(async () => {
    const made = await makeDb(process.env.TEST_DATABASE_URL!);
    db = made.db;
    client = made.client;
    await client`insert into users (id, email, password_hash) values (${userId}, ${`bulk-${userId}@test.com`}, 'x')`;
    await client`insert into libraries (id, name, owner_user_id) values (${libraryId}, 'Bulk', ${userId})`;
    await client`insert into scan_roots (id, library_id, path, display_name, validation_status) values (${rootId}, ${libraryId}, '/nowhere', 'bulk', 'ok')`;
    for (const [rel, handler, title] of [['Mixed/01.flac', 'audio', 'one'], ['Mixed/02.doc', 'test-doc', 'two']] as const) {
      await client`insert into files (library_id, scan_root_id, rel_path, handler, size_bytes, mtime, status, tags_raw)
                   values (${libraryId}, ${rootId}, ${rel}, ${handler}, 10, 1, 'present', ${tags(title)}::text::jsonb)`;
    }
  });

  afterAll(async () => {
    await client`delete from files where library_id = ${libraryId}`;
    await client`delete from scan_roots where id = ${rootId}`;
    await client`delete from libraries where id = ${libraryId}`;
    await client`delete from users where id = ${userId}`;
    await client.end({ timeout: 5 });
  });

  it('reads only the files music claims under the folder', async () => {
    const { files } = await filesInFolder(db, libraryId, 'Mixed', rootId);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({ album: 'Mixed', artist: 'A' });
  });
});
