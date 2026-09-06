/**
 * Wikidata release-group identity (ENR-7 / REV-2): QID + Discogs master +
 * enwiki title + review-site identifiers in one SPARQL round trip. Fixture is
 * the live answer for OK Computer's P436, which carries TWO items (the album
 * and the OKNOTOK reissue, the latter with the Metacritic id).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { WikidataClient, parseWikidataBindings, pickIdentityBinding } from './wikidata.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const loadFixture = (name: string) => JSON.parse(readFileSync(join(__dirname, '__fixtures__', name), 'utf-8'));

describe('parseWikidataBindings (identity fields)', () => {
  it('reads metacritic / allmusic / rym identifiers when present', () => {
    const bindings = parseWikidataBindings(loadFixture('wikidata_identity_okcomputer.json'));
    expect(bindings.length).toBeGreaterThanOrEqual(2);
    const album = bindings.find((b) => b.item === 'Q202996');
    expect(album).toMatchObject({ master: 21491, enwiki: 'OK_Computer', allmusic: 'mw0000024289', rym: 'album/radiohead/ok-computer' });
    expect(album?.metacritic).toBeUndefined();
    expect(bindings.find((b) => b.item === 'Q33328630')).toMatchObject({ metacritic: 'music/ok-computer-oknotok-1997-2017' });
  });
});

describe('pickIdentityBinding', () => {
  it('prefers an item with a Wikipedia article, then the oldest (lowest) QID', () => {
    expect(pickIdentityBinding([
      { item: 'Q33328630', enwiki: 'Reissue', metacritic: 'm' },
      { item: 'Q202996', enwiki: 'Album' },
    ])?.item).toBe('Q202996');
    expect(pickIdentityBinding([{ item: 'Q5' }, { item: 'Q3', enwiki: 'Z' }])?.item).toBe('Q3');
    expect(pickIdentityBinding([{ item: 'Q50' }, { item: 'Q7' }])?.item).toBe('Q7');
    expect(pickIdentityBinding([{ enwiki: 'no item' }])).toBeNull();
    expect(pickIdentityBinding([])).toBeNull();
  });
});

describe('WikidataClient.findReleaseGroupIdentity', () => {
  it('asks for P1954/P1712/P1729/P8392 and the enwiki sitelink, and picks the album item', async () => {
    let seenQuery = '';
    const fetchImpl = (async (url: string) => {
      seenQuery = decodeURIComponent(new URL(url).searchParams.get('query') ?? '');
      return new Response(JSON.stringify(loadFixture('wikidata_identity_okcomputer.json')), { status: 200 });
    }) as unknown as typeof fetch;
    const client = new WikidataClient({ userAgent: 't', fetchImpl });

    const identity = await client.findReleaseGroupIdentity('b1392450-e666-3926-a536-22c65f834433');

    for (const prop of ['P436', 'P1954', 'P1712', 'P1729', 'P8392']) expect(seenQuery).toContain(prop);
    expect(identity).toEqual({
      qid: 'Q202996',
      discogsMasterId: 21491,
      enwikiTitle: 'OK_Computer',
      allmusicId: 'mw0000024289',
      rymId: 'album/radiohead/ok-computer',
    });
  });

  it('keeps findByMbReleaseGroup working on the same query', async () => {
    const fetchImpl = (async () => new Response(JSON.stringify(loadFixture('wikidata_identity_okcomputer.json')), { status: 200 })) as unknown as typeof fetch;
    const client = new WikidataClient({ userAgent: 't', fetchImpl });
    expect(await client.findByMbReleaseGroup('x')).toEqual({ qid: 'Q202996', discogsMasterId: 21491, enwikiTitle: 'OK_Computer' });
  });

  it('returns null when nothing matches', async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({ results: { bindings: [] } }), { status: 200 })) as unknown as typeof fetch;
    expect(await new WikidataClient({ userAgent: 't', fetchImpl }).findReleaseGroupIdentity('x')).toBeNull();
  });
});

describe('WikidataClient.findArtistIdentity', () => {
  it('asks for P434/P1953 and the enwiki sitelink, and picks the artist item', async () => {
    let seenQuery = '';
    const fetchImpl = (async (url: string) => {
      seenQuery = decodeURIComponent(new URL(url).searchParams.get('query') ?? '');
      return new Response(JSON.stringify(loadFixture('wikidata_artist_identity.json')), { status: 200 });
    }) as unknown as typeof fetch;
    const client = new WikidataClient({ userAgent: 't', fetchImpl });

    const identity = await client.findArtistIdentity('b1392450-e666-3926-a536-22c65f834433');

    expect(seenQuery).toContain('P434');
    expect(seenQuery).toContain('P1953');
    expect(identity).toEqual({
      qid: 'Q5',
      discogsArtistId: 123456,
      enwikiTitle: 'Miles_Davis',
    });
  });

  it('returns identity without discogs ID when not present', async () => {
    const fixture = {
      head: { vars: ['item', 'discogsArtist', 'enwiki'] },
      results: {
        bindings: [{
          item: { type: 'uri', value: 'http://www.wikidata.org/entity/Q123' },
          enwiki: { type: 'uri', value: 'https://en.wikipedia.org/wiki/Artist_Name' },
        }],
      },
    };
    const fetchImpl = (async () => new Response(JSON.stringify(fixture), { status: 200 })) as unknown as typeof fetch;
    const client = new WikidataClient({ userAgent: 't', fetchImpl });

    const identity = await client.findArtistIdentity('test-mbid');

    expect(identity).toEqual({
      qid: 'Q123',
      enwikiTitle: 'Artist_Name',
    });
    expect(identity?.discogsArtistId).toBeUndefined();
  });

  it('returns null when the artist is not found in Wikidata', async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({ results: { bindings: [] } }), { status: 200 })) as unknown as typeof fetch;
    const client = new WikidataClient({ userAgent: 't', fetchImpl });

    const identity = await client.findArtistIdentity('unknown-mbid');

    expect(identity).toBeNull();
  });

  it('throws on rate limit (429)', async () => {
    const fetchImpl = (async () => new Response('', { status: 429 })) as unknown as typeof fetch;
    const client = new WikidataClient({ userAgent: 't', fetchImpl });

    await expect(client.findArtistIdentity('test-mbid')).rejects.toThrow(/rate limited/);
  });

  it('returns null on other HTTP errors', async () => {
    const fetchImpl = (async () => new Response('', { status: 500 })) as unknown as typeof fetch;
    const client = new WikidataClient({ userAgent: 't', fetchImpl });

    const identity = await client.findArtistIdentity('test-mbid');

    expect(identity).toBeNull();
  });
});
