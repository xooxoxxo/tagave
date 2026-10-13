/**
 * The artist page's albums against the test database. "Aarni": only the
 * split release is identified (credited to Aarni); the demos and albums are
 * known by their album-artist tags alone. They must all be Aarni's — on the
 * artist page, in the artists list's counts and in its card mosaic — while
 * another artist's albums and a release group credited to someone else stay
 * out. A followed artist's gaps list what is missing.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { makeDb } from '@liner/db';
import { fetchArtistAlbums } from './artistAlbums.js';
import { coversFor, fetchArtistRows } from './artistList.js';

describe.skipIf(!process.env.TEST_DATABASE_URL)('artist page albums (db)', () => {
  let db: any;
  let client: any;
  const userId = randomUUID();
  const libraryId = randomUUID();
  // a name no other suite uses: the artists table is shared
  const name = `Aarni ${randomUUID().slice(0, 6)}`;
  const aarni = randomUUID();
  const other = randomUUID();
  const rg = { split: randomUUID(), missing: randomUUID(), skipped: randomUUID(), uncredited: randomUUID(), othersRg: randomUUID() };
  const album: Record<string, string> = {};

  const addAlbum = async (key: string, guess: string, title: string, year: number | null, tracks: number, releaseGroupId: string | null = null) => {
    const id = randomUUID();
    album[key] = id;
    await client`insert into local_albums (id, library_id, cluster_key, artist_guess, title_guess, year_guess, track_count, release_group_id)
                 values (${id}, ${libraryId}, ${`${guess}/${title}`}, ${guess}, ${title}, ${year}, ${tracks}, ${releaseGroupId})`;
  };

  beforeAll(async () => {
    const made = await makeDb(process.env.TEST_DATABASE_URL!);
    db = made.db;
    client = made.client;
    await client`insert into users (id, email, password_hash) values (${userId}, ${`aa-${userId}@test.local`}, 'x')`;
    await client`insert into libraries (id, owner_user_id, name) values (${libraryId}, ${userId}, 'artist albums')`;
    await client`insert into artists (id, name, type, country) values (${aarni}, ${name}, 'Group', 'FI'), (${other}, ${`Umbra ${name}`}, 'Group', 'FI')`;
    // a release group needs an identity: the MBID is its own id here
    await client`insert into release_groups (id, mbid, title, primary_type, first_release_date) values
      (${rg.split}, ${rg.split}, ${`${name} / Umbra Nihil`}, 'EP', '2002-01-01'),
      (${rg.missing}, ${rg.missing}, 'Tohcoth', 'Album', '2008-03-01'),
      (${rg.skipped}, ${rg.skipped}, 'Live Bootleg', 'Album', '2010-01-01'),
      (${rg.uncredited}, ${rg.uncredited}, 'Bathos', null, null),
      (${rg.othersRg}, ${rg.othersRg}, 'Not Theirs', 'Album', '2005-01-01')`;
    await client`insert into release_group_artists (release_group_id, artist_id, position) values
      (${rg.split}, ${aarni}, 0), (${rg.split}, ${other}, 1),
      (${rg.missing}, ${aarni}, 0), (${rg.skipped}, ${aarni}, 0), (${rg.othersRg}, ${other}, 0)`;
    // identified: the split, credited to both
    await addAlbum('split', `${name} / Umbra Nihil`, 'Split', 2002, 1, rg.split);
    // tags only: no release group; the tag in another case and with a track-number prefix
    await addAlbum('demo', name.toLowerCase(), 'Demo 2001 + Promo 2002', 2003, 1);
    await addAlbum('promo', `02. ${name}`, "Duumipeikon paluu (Demo '02)", null, 4);
    // a release group with no credits counts by its tags too
    await addAlbum('bathos', name, 'Bathos (tags)', 2004, 9, rg.uncredited);
    // tagged with the name but identified as someone else's release: not Aarni's
    await addAlbum('notTheirs', name, 'Not Theirs', 2005, 7, rg.othersRg);
    // another artist entirely
    await addAlbum('else', 'Somebody Else', 'Elsewhere', 1999, 5);
    await client`insert into images (library_id, entity_type, entity_id, local_album_id, kind, origin, license_note, thumb_bytes)
                 values (${libraryId}, 'local_album', ${album['demo']!}, ${album['demo']!}, 'front', 'owner', 'test', ${Buffer.from([0xff, 0xd8, 0xff])})`;
    // a followed artist's gaps: one missing, one dismissed
    await client`insert into gaps (library_id, kind, subject_type, subject_id, state) values
      (${libraryId}, 'missing_album', 'release_group', ${rg.missing}, 'open'),
      (${libraryId}, 'missing_album', 'release_group', ${rg.skipped}, 'dismissed')`;
  });

  afterAll(async () => {
    await client`delete from gaps where library_id = ${libraryId}`;
    await client`delete from images where library_id = ${libraryId}`;
    await client`delete from local_albums where library_id = ${libraryId}`;
    await client`delete from release_group_artists where release_group_id in ${client(Object.values(rg))}`;
    await client`delete from release_groups where id in ${client(Object.values(rg))}`;
    await client`delete from artists where id in ${client([aarni, other])}`;
    await client`delete from libraries where id = ${libraryId}`;
    await client`delete from users where id = ${userId}`;
    await client.end({ timeout: 5 });
  });

  it('lists identified and tag-matched albums, oldest first, with track counts', async () => {
    const { albums, owned } = await fetchArtistAlbums(db, libraryId, { id: aarni, name });
    const inLibrary = albums.filter((a) => a.ownership === 'digital' || a.ownership === 'both');
    expect(inLibrary.map((a) => [a.title, a.year, a.trackCount, a.matchedBy])).toEqual([
      [`${name} / Umbra Nihil`, 2002, 1, 'credit'],
      ['Demo 2001 + Promo 2002', 2003, 1, 'tags'],
      ['Bathos', 2004, 9, 'tags'],
      ["Duumipeikon paluu (Demo '02)", null, 4, 'tags'],
    ]);
    // owned: albums · tracks
    expect(owned).toEqual({ albums: 4, tracks: 15 });
    // the cover is served for the album that has one
    expect(inLibrary.find((a) => a.matchedBy === 'tags' && a.coverUrl)?.localAlbumId).toBe(album['demo']);
  });

  it('lists the gaps: missing, and skipped (dismissed) for Maintenance', async () => {
    const { albums } = await fetchArtistAlbums(db, libraryId, { id: aarni, name });
    expect(albums.filter((a) => a.ownership === 'missing').map((a) => [a.title, a.year, a.primaryType])).toEqual([['Tohcoth', 2008, 'Album']]);
    const skipped = albums.filter((a) => a.ownership === 'ignored');
    expect(skipped.map((a) => a.title)).toEqual(['Live Bootleg']);
    expect(skipped[0]!.gapId).toBeTruthy();
  });

  it('keeps other artists out', async () => {
    const { albums } = await fetchArtistAlbums(db, libraryId, { id: aarni, name });
    const ids = albums.map((a) => a.localAlbumId);
    expect(ids).not.toContain(album['notTheirs']);
    expect(ids).not.toContain(album['else']);
  });

  it('the artists list counts the same albums under the one, clickable row', async () => {
    const rows = await fetchArtistRows(db, libraryId, '');
    const mine = rows.filter((r) => r.name.toLowerCase() === name.toLowerCase());
    expect(mine).toEqual([expect.objectContaining({ id: aarni, resolved: true, albumCount: 4, trackCount: 15, yearFrom: 2002, yearTo: 2004 })]);
    // the tag-matched album's cover reaches the card mosaic
    const covers = await coversFor(db, libraryId, mine);
    expect(covers.get(aarni)).toEqual([album['demo']]);
  });

  it('uses the expression index for the tag lookup (0040)', async () => {
    // one connection: the setting must apply to the explain (a tiny table would seq-scan anyway)
    const plan = await client.begin(async (tx: any) => {
      await tx`set local enable_seqscan = off`;
      return tx.unsafe(
        `explain select id from local_albums where library_id = $1 and lower(liner_display_artist(artist_guess)) = lower($2)`,
        [libraryId, name],
      );
    });
    expect(plan.map((r: Record<string, string>) => Object.values(r)[0]).join('\n')).toMatch(/idx_local_albums_display_artist_lower/);
  });
});
