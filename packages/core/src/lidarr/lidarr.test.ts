import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LidarrClient, LidarrError, albumFolderOf, getAlbumInLidarr, inScanRoot, lidarrConnectionOf, normalizeLidarrUrl, observeLidarr, LIDARR_NOT_FOUND_AFTER_MS } from './index.js';
import { startFakeLidarr, type FakeLidarr } from './fake.js';
import { sealSecret } from '../crypto/secretbox.js';

const KEY = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
const RG = '11111111-1111-4111-8111-111111111111';
const ARTIST = '22222222-2222-4222-8222-222222222222';

describe('normalizeLidarrUrl', () => {
  it('keeps http(s) with a path, drops the slash and /api/v1', () => {
    expect(normalizeLidarrUrl('http://lidarr.local:8686/')).toBe('http://lidarr.local:8686');
    expect(normalizeLidarrUrl(' https://example.com/lidarr/api/v1 ')).toBe('https://example.com/lidarr');
  });
  it('refuses other schemes, credentials and queries', () => {
    for (const bad of ['ftp://x', 'file:///etc/passwd', 'javascript:alert(1)', 'http://u:p@x', 'http://x/?apikey=1', 'nope']) {
      expect(() => normalizeLidarrUrl(bad), bad).toThrow(LidarrError);
    }
  });
});

describe('the client against a fake Lidarr', () => {
  let lidarr: FakeLidarr;
  beforeAll(async () => {
    lidarr = await startFakeLidarr({ apiKey: KEY, rootFolders: ['/music', '/data/other'] });
    lidarr.catalog.set(RG, { title: 'Second Album', artistMbid: ARTIST, artistName: 'The Band', tracks: 9 });
  });
  afterAll(async () => { await lidarr.close(); });

  it('sends the key as X-Api-Key only, never in the URL', async () => {
    const c = new LidarrClient({ url: lidarr.url, apiKey: KEY });
    expect((await c.status()).version).toBe('2.9.6.4552');
    expect(lidarr.calls.at(-1)).toMatchObject({ url: '/api/v1/system/status', keyOk: true });
    expect(lidarr.calls.every((call) => !call.url.includes(KEY))).toBe(true);
  });

  it('a wrong key is "API key refused"', async () => {
    await expect(new LidarrClient({ url: lidarr.url, apiKey: 'wrongwrongwrong' }).status()).rejects.toThrow('API key refused');
  });

  it('Get: a new artist is added for this album only, then searched', async () => {
    const conn = { server: { url: lidarr.url, apiKey: KEY }, rootFolderPath: '/music', qualityProfileId: 2, metadataProfileId: 1 };
    const got = await getAlbumInLidarr(new LidarrClient(conn.server), conn, { releaseGroupMbid: RG, artistMbid: ARTIST, artistName: 'The Band' });
    expect(got.existed).toBe(false);
    const post = lidarr.calls.find((c) => c.method === 'POST' && c.url === '/api/v1/album')!;
    expect(post.body).toMatchObject({
      foreignAlbumId: RG,
      monitored: true,
      artist: { foreignArtistId: ARTIST, rootFolderPath: '/music', qualityProfileId: 2, metadataProfileId: 1, monitorNewItems: 'none', addOptions: { monitor: 'none', albumsToMonitor: [RG], searchForMissingAlbums: false } },
    });
    expect(lidarr.commands).toEqual([{ name: 'AlbumSearch', albumIds: [got.albumId] }]);
    // again: the album is there, so it is monitored and searched, never added twice
    lidarr.albums[0]!.monitored = false;
    const again = await getAlbumInLidarr(new LidarrClient(conn.server), conn, { releaseGroupMbid: RG, artistMbid: ARTIST, artistName: 'The Band' });
    expect(again).toMatchObject({ albumId: got.albumId, existed: true });
    expect(lidarr.albums[0]!.monitored).toBe(true);
    expect(lidarr.calls.filter((c) => c.method === 'POST' && c.url === '/api/v1/album')).toHaveLength(1);
  });

  it('a Lidarr validation message comes back as one line', async () => {
    const c = new LidarrClient({ url: lidarr.url, apiKey: KEY });
    await expect(c.addAlbum({ foreignAlbumId: RG, artist: { foreignArtistId: ARTIST } })).rejects.toThrow('This album has already been added.');
  });
});

describe('the client refuses what a Lidarr should not send', () => {
  let url: string;
  let close: () => Promise<void>;
  beforeAll(async () => {
    const server = createServer((req, res) => {
      if (req.url?.includes('redirect')) { res.writeHead(302, { location: 'http://elsewhere.example/' }); res.end(); return; }
      if (req.url?.includes('big')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ version: 'x'.repeat(3 * 1024 * 1024) })); return; }
      if (req.url?.includes('html')) { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<script>alert(1)</script>'); return; }
      if (req.url?.includes('slow')) return; // never answers
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ version: `<b>${'9'.repeat(100)}</b>` }));
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    close = () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); });
  });
  afterAll(async () => { await close(); });

  it('no redirect, no oversized body, no HTML, a timeout, text capped', async () => {
    await expect(new LidarrClient({ url: `${url}/redirect`, apiKey: KEY }).status()).rejects.toThrow('redirected');
    await expect(new LidarrClient({ url: `${url}/big`, apiKey: KEY }).status()).rejects.toThrow('too much data');
    await expect(new LidarrClient({ url: `${url}/html`, apiKey: KEY }).status()).rejects.toThrow('Not a Lidarr answer');
    await expect(new LidarrClient({ url: `${url}/slow`, apiKey: KEY }, { timeoutMs: 200 }).status()).rejects.toThrow('did not answer in time');
    expect((await new LidarrClient({ url, apiKey: KEY }).status()).version).toHaveLength(40);
  });
});

describe('states and paths', () => {
  const album = (files: number) => ({ id: 1, foreignAlbumId: RG, title: null, monitored: true, statistics: { trackFileCount: files, trackCount: 10 } });
  const at = new Date('2026-11-01T00:00:00Z');
  it('Downloading with its progress, Importing, Wanted, then Not found after three days', () => {
    expect(observeLidarr(album(0), [{ id: 1, albumId: 1, size: 200, sizeleft: 50 }], at, at.getTime())).toEqual({ state: 'downloading', progress: 75, error: null });
    expect(observeLidarr(album(10), [], at, at.getTime())).toMatchObject({ state: 'imported' });
    expect(observeLidarr(album(0), [], at, at.getTime() + 1000)).toMatchObject({ state: 'wanted' });
    expect(observeLidarr(album(0), [], at, at.getTime() + LIDARR_NOT_FOUND_AFTER_MS + 1)).toMatchObject({ state: 'not_found' });
  });
  it('finds the music folder an album landed in, by its own path or its host path', () => {
    const roots = [{ id: 'a', path: '/music' }, { id: 'b', path: '/mnt/lib', hostPath: '/srv/media/music' }];
    expect(inScanRoot('/music/The Band/Second Album (2001)', roots)).toEqual({ scanRootId: 'a', dirPath: 'The Band/Second Album (2001)' });
    expect(inScanRoot('/srv/media/music/X/Y/', roots)).toEqual({ scanRootId: 'b', dirPath: 'X/Y' });
    expect(inScanRoot('/musicals/X', roots)).toBeNull();
    expect(albumFolderOf(['/music/A/B/CD1/01.flac', '/music/A/B/CD2/01.flac'])).toBe('/music/A/B');
  });
  it('a saved connection opens its key; an incomplete one is none', () => {
    const secret = 'test-app-secret-0123456789abcdef';
    expect(lidarrConnectionOf({ url: 'http://x', apiKey: sealSecret(KEY, secret), rootFolderPath: '/music', qualityProfileId: 1, metadataProfileId: 1 }, secret)?.server.apiKey).toBe(KEY);
    expect(lidarrConnectionOf({ url: 'http://x' }, secret)).toBeNull();
    expect(() => lidarrConnectionOf({ url: 'http://x', apiKey: sealSecret(KEY, secret), rootFolderPath: '/m', qualityProfileId: 1, metadataProfileId: 1 }, 'another-secret-xxxxxxxxxxxxxxxx')).toThrow();
  });
});
