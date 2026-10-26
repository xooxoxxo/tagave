/**
 * The resolver against answers recorded from MusicBrainz, Wikidata and
 * Apple on 2026-10-20 (fixtures/): no network. OK Computer and Radiohead.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ListenLinkResolver, type ListenProvider } from './resolve.js';

const OK_COMPUTER = 'b1392450-e666-3926-a536-22c65f834433';
const RADIOHEAD = 'a74b1b7f-71a5-4011-9441-d0b5e4122711';
const UA = 'tagave/0.1 (+owner@example.org)';
const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');

interface Sent { url: string; headers: Record<string, string>; credentials: string | undefined }

/** A fetch that answers from the fixtures by URL, and records what was sent. */
function recorded(routes: Array<[RegExp, string | (() => Response)]>) {
  const sent: Sent[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    sent.push({ url, headers: { ...(init?.headers as Record<string, string>) }, credentials: init?.credentials });
    const hit = routes.find(([re]) => re.test(url));
    if (!hit) return new Response('{}', { status: 404 });
    return typeof hit[1] === 'string' ? new Response(fixture(hit[1]), { status: 200 }) : hit[1]();
  }) as typeof fetch;
  return { sent, fetchImpl };
}

const ALL = ['qobuz', 'spotify', 'apple', 'youtube-music', 'tidal', 'bandcamp', 'amazon', 'deezer'] as const;

describe('ListenLinkResolver.album', () => {
  it('finds OK Computer on every platform from MusicBrainz, preferring the release titled like the album', async () => {
    const { sent, fetchImpl } = recorded([[/musicbrainz\.org\/ws\/2\/release\?release-group=/, 'mb-releases-ok-computer.json']]);
    const paced: ListenProvider[] = [];
    const r = new ListenLinkResolver({ userAgent: UA, fetchImpl, pace: async (p, fn) => { paced.push(p); return fn(); } });
    const { links, incomplete } = await r.album({ mbid: OK_COMPUTER, title: 'OK Computer' }, ALL);
    expect(incomplete).toBe(false);
    const by = Object.fromEntries(links.map((l) => [l.platform, l]));
    expect(Object.keys(by).sort()).toEqual([...ALL].sort());
    // the 2016 reissue titled "OK Computer", not "OK Computer OKNOTOK 1997 2017"
    expect(by['qobuz']).toEqual({ platform: 'qobuz', url: 'https://play.qobuz.com/album/0634904078164', source: 'mb-release' });
    expect(by['bandcamp']!.url).toBe('https://radiohead.bandcamp.com/album/ok-computer');
    expect(by['amazon']!.url).toBe('https://music.amazon.com/albums/B071SGTLJ4');
    for (const l of links) expect(l.source).toBe('mb-release');
    // every platform found: Wikidata and Apple are not asked
    expect(sent).toHaveLength(1);
    expect(paced).toEqual(['musicbrainz']);
  });

  it('asks Wikidata only for what MusicBrainz lacks, then Apple by barcode', async () => {
    const browse = { releases: [{ id: 'r1', title: 'OK Computer', status: 'Official', date: '1997-05-21', barcode: '634904078164', relations: [] }] };
    const { sent, fetchImpl } = recorded([
      [/musicbrainz\.org/, () => new Response(JSON.stringify(browse))],
      [/query\.wikidata\.org/, () => new Response(JSON.stringify({ results: { bindings: [] } }))],
      [/itunes\.apple\.com\/lookup\?upc=634904078164/, 'itunes-upc-634904078164.json'],
    ]);
    const r = new ListenLinkResolver({ userAgent: UA, fetchImpl });
    const { links } = await r.album({ mbid: OK_COMPUTER, title: 'OK Computer' }, ['apple']);
    expect(links).toEqual([{ platform: 'apple', url: 'https://music.apple.com/us/album/ok-computer/1097861387', source: 'itunes-upc' }]);
    expect(sent.map((s) => new URL(s.url).host)).toEqual(['musicbrainz.org', 'query.wikidata.org', 'itunes.apple.com']);
  });

  it('takes Wikidata’s album ids when MusicBrainz has none', async () => {
    const { fetchImpl } = recorded([
      [/musicbrainz\.org/, () => new Response(JSON.stringify({ releases: [] }))],
      [/query\.wikidata\.org/, 'wikidata-album-ok-computer.json'],
    ]);
    const r = new ListenLinkResolver({ userAgent: UA, fetchImpl });
    const { links } = await r.album({ mbid: OK_COMPUTER, title: 'OK Computer' }, ['qobuz', 'spotify', 'youtube-music']);
    expect(links).toEqual([
      { platform: 'spotify', url: 'https://open.spotify.com/album/2fGCAYUMssLKiUAoNdxGLx', source: 'wikidata' },
      { platform: 'qobuz', url: 'https://play.qobuz.com/album/0634904078164', source: 'wikidata' },
    ]);
  });

  it('keeps what MusicBrainz found when Wikidata or Apple do not answer, and says so', async () => {
    const browse = { releases: [{ id: 'r1', title: 'X', barcode: '634904078164', relations: [{ type: 'streaming', 'target-type': 'url', url: { resource: 'https://tidal.com/album/1' } }] }] };
    const { fetchImpl } = recorded([
      [/musicbrainz\.org/, () => new Response(JSON.stringify(browse))],
      [/query\.wikidata\.org/, () => new Response('slow down', { status: 429 })],
      [/itunes\.apple\.com/, () => new Response('nope', { status: 500 })],
    ]);
    const r = new ListenLinkResolver({ userAgent: UA, fetchImpl });
    const res = await r.album({ mbid: OK_COMPUTER, title: 'X' }, ['tidal', 'spotify', 'apple']);
    expect(res).toEqual({ links: [{ platform: 'tidal', url: 'https://tidal.com/album/1', source: 'mb-release' }], incomplete: true });
  });

  it('fails when MusicBrainz is rate limited (the job retries), and asks nothing for a bad MBID or no platform', async () => {
    const { sent, fetchImpl } = recorded([[/musicbrainz\.org/, () => new Response('busy', { status: 503 })]]);
    const r = new ListenLinkResolver({ userAgent: UA, fetchImpl });
    await expect(r.album({ mbid: OK_COMPUTER, title: 'OK Computer' }, ['qobuz'])).rejects.toThrow(/rate limited \(503\)/);
    sent.length = 0;
    expect(await r.album({ mbid: 'not-an-mbid', title: 'x' }, ['qobuz'])).toEqual({ links: [], incomplete: false });
    expect(await r.album({ mbid: OK_COMPUTER, title: 'x' }, [])).toEqual({ links: [], incomplete: false });
    expect(sent).toHaveLength(0);
  });
});

describe('ListenLinkResolver.artist', () => {
  it('finds Radiohead’s pages from MusicBrainz, then Wikidata for the rest', async () => {
    const { fetchImpl } = recorded([
      [/musicbrainz\.org\/ws\/2\/artist\//, 'mb-artist-radiohead.json'],
      [/query\.wikidata\.org/, 'wikidata-artist-radiohead.json'],
    ]);
    const r = new ListenLinkResolver({ userAgent: UA, fetchImpl });
    const { links } = await r.artist(RADIOHEAD, ALL);
    const by = Object.fromEntries(links.map((l) => [l.platform, l]));
    expect(by['qobuz']).toEqual({ platform: 'qobuz', url: 'https://play.qobuz.com/artist/43840', source: 'mb-artist' });
    expect(by['spotify']!.url).toBe('https://open.spotify.com/artist/4Z8W4fKeB5YxbusRsdQVPb');
    expect(by['youtube-music']!.url).toBe('https://music.youtube.com/channel/UCr_iyUANcn9OX_yy9piYoLw');
    expect(by['amazon']!.url).toBe('https://music.amazon.co.uk/artists/B000QJXOGC');
    expect(by['bandcamp']!.url).toBe('https://radiohead.bandcamp.com/');
    expect(Object.keys(by).sort()).toEqual([...ALL].sort());
  });
});

describe('what leaves the server', () => {
  it('only MBIDs and barcodes, with the install’s User-Agent: no cookie, no credentials, nothing about the person', async () => {
    const browse = { releases: [{ id: 'r1', title: 'OK Computer', barcode: '634904078164', relations: [] }] };
    const { sent, fetchImpl } = recorded([
      [/musicbrainz\.org\/ws\/2\/release/, () => new Response(JSON.stringify(browse))],
      [/musicbrainz\.org\/ws\/2\/artist/, 'mb-artist-radiohead.json'],
      [/query\.wikidata\.org/, () => new Response(JSON.stringify({ results: { bindings: [] } }))],
      [/itunes\.apple\.com/, 'itunes-upc-634904078164.json'],
    ]);
    const r = new ListenLinkResolver({ userAgent: UA, fetchImpl });
    await r.album({ mbid: OK_COMPUTER, title: 'OK Computer' }, ALL);
    await r.artist(RADIOHEAD, ALL);
    expect(sent.length).toBeGreaterThanOrEqual(4);
    for (const s of sent) {
      expect(Object.keys(s.headers).sort()).toEqual(['Accept', 'User-Agent']);
      expect(s.headers['User-Agent']).toBe(UA);
      expect(s.credentials).toBe('omit');
      const u = new URL(s.url);
      expect(u.protocol).toBe('https:');
      expect(['musicbrainz.org', 'query.wikidata.org', 'itunes.apple.com']).toContain(u.host);
      // the identifiers sent are MBIDs and barcodes only
      const ids = decodeURIComponent(u.pathname + u.search).match(/[0-9a-f-]{36}|\b\d{12,13}\b/g) ?? [];
      for (const id of ids) expect([OK_COMPUTER, RADIOHEAD, '634904078164']).toContain(id);
    }
    expect(sent.map((s) => s.url)).toEqual([
      `https://musicbrainz.org/ws/2/release?release-group=${OK_COMPUTER}&inc=url-rels&fmt=json&limit=100`,
      expect.stringMatching(/^https:\/\/query\.wikidata\.org\/sparql\?format=json&query=/),
      'https://itunes.apple.com/lookup?upc=634904078164&entity=album',
      `https://musicbrainz.org/ws/2/artist/${RADIOHEAD}?inc=url-rels&fmt=json`,
    ]);
  });
});
