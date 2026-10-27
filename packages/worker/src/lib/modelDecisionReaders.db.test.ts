/**
 * A match a decision model made is automatic, never a person's: every reader
 * that asks "did a person decide this?" must read a model row as the system's.
 * Each case pairs the model row with the same row decided by a person, so the
 * test shows the reader can tell them apart.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { fillAlbumMbid, identifySuggest, identifyWithdraw, makeDb, unconfirmedFilledGroups } from '@tagave/db';
import { freshTouchedReason } from './fileMerge.js';

describe.skipIf(!process.env.TEST_DATABASE_URL)('readers of who decided a match, with a model decision (db)', () => {
  let client: any;
  const userId = randomUUID();
  const libraryId = randomUUID();
  const rootId = randomUUID();
  const rgIds: string[] = [];
  let rgId: string;
  let releaseId: string;
  let albumId: string;
  let fileId: string;

  const modelMatch = async (album: string, release: string) => {
    await client`
      insert into album_matches (library_id, local_album_id, release_id, distance, status, decided_by, decided_kind,
                                 decider_id, decider_version, probability, reason)
      values (${libraryId}, ${album}, ${release}, 0.0500, 'auto', 'system', 'model',
              'jev', 'jev-2026-09-15', 0.9940, 'model accept: jev-2026-09-15, probability 0.9940')`;
  };
  const personMatch = async (album: string, release: string) => {
    await client`
      insert into album_matches (library_id, local_album_id, release_id, distance, status, decided_by, decided_kind, decided_by_user_id, reason)
      values (${libraryId}, ${album}, ${release}, 0.0500, 'confirmed', 'user', 'user', ${userId}, 'accepted')`;
  };

  beforeAll(async () => {
    client = (await makeDb(process.env.TEST_DATABASE_URL!)).client;
    await client`insert into users (id, email, password_hash) values (${userId}, ${`mdr-${userId}@test.com`}, 'x')`;
    await client`insert into libraries (id, name, owner_user_id, settings) values (${libraryId}, 'Model readers', ${userId}, '{}')`;
    await client`insert into scan_roots (id, library_id, path, display_name) values (${rootId}, ${libraryId}, ${`/mdr-${rootId}`}, 'mdr')`;
  });

  // a fresh release group (no MBID yet), release, album and file per case
  beforeEach(async () => {
    rgId = randomUUID();
    rgIds.push(rgId);
    releaseId = randomUUID();
    albumId = randomUUID();
    fileId = randomUUID();
    // a Discogs-only group: an MBID-less group needs another identity
    const master = 900_000_000 + Math.floor(Math.random() * 99_000_000);
    await client`insert into release_groups (id, title, discogs_master_id) values (${rgId}, 'Kosmonument', ${master})`;
    await client`insert into releases (id, release_group_id, title) values (${releaseId}, ${rgId}, 'Kosmonument')`;
    await client`insert into local_albums (id, library_id, cluster_key, release_group_id) values (${albumId}, ${libraryId}, ${`mdr:${albumId}`}, ${rgId})`;
    await client`insert into files (handler, id, library_id, scan_root_id, rel_path, size_bytes, mtime, status)
                 values ('audio', ${fileId}, ${libraryId}, ${rootId}, ${`${albumId}/1.flac`}, 1, 1, 'present')`;
    await client`insert into local_tracks (local_album_id, audio_file_id) values (${albumId}, ${fileId})`;
  });

  afterAll(async () => {
    await client`delete from identity_fills where entity_id = any(${rgIds}::uuid[])`;
    await client`delete from audit_log where subject_id = any(${rgIds}::uuid[])`;
    await client`delete from local_albums where library_id = ${libraryId}`;
    await client`delete from files where library_id = ${libraryId}`;
    await client`delete from release_groups where id = any(${rgIds}::uuid[])`;
    await client`delete from scan_roots where id = ${rootId}`;
    await client`delete from libraries where id = ${libraryId}`;
    await client`delete from users where id = ${userId}`;
    await client.end({ timeout: 5 });
  });

  it('a model decision does not confirm an identity fill (only a person does)', async () => {
    expect(await fillAlbumMbid(client, rgId, randomUUID(), { module: 'mc', sourceRef: null, actorUserId: null })).toBe('filled');
    await modelMatch(albumId, releaseId);
    expect((await unconfirmedFilledGroups(client, [rgId])).has(rgId)).toBe(true);

    await client`update album_matches set status = 'rejected' where local_album_id = ${albumId}`;
    await personMatch(albumId, releaseId);
    expect((await unconfirmedFilledGroups(client, [rgId])).has(rgId)).toBe(false);
  });

  it("a model decision does not protect a linked app's suggestion from withdrawal", async () => {
    const source = `mc:${randomUUID()}`;
    expect(await identifySuggest(client, { localAlbumId: albumId, releaseId, distance: 0.1, breakdown: {}, source, key: 'k1' })).toBe(true);
    await modelMatch(albumId, releaseId);
    expect(await identifyWithdraw(client, { exact: source })).toBe(1);

    expect(await identifySuggest(client, { localAlbumId: albumId, releaseId, distance: 0.1, breakdown: {}, source, key: 'k2' })).toBe(true);
    await client`update album_matches set status = 'rejected' where local_album_id = ${albumId}`;
    await personMatch(albumId, releaseId);
    expect(await identifyWithdraw(client, { exact: source })).toBe(0);
  });

  it("a file merge does not treat a model decision as the owner's", async () => {
    await modelMatch(albumId, releaseId);
    const reason = await client.begin((tx: any) => freshTouchedReason(tx, [fileId], null));
    expect(reason).not.toBe('owner match decision');
    expect(reason).toBeNull();

    await client`delete from album_matches where local_album_id = ${albumId}`;
    await personMatch(albumId, releaseId);
    expect(await client.begin((tx: any) => freshTouchedReason(tx, [fileId], null))).toBe('owner match decision');
  });
});
