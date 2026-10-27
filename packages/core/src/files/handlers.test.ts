import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { TagWriter } from '../providers/types.js';
import { coreTagsDigest } from './audioMetadata.js';
import {
  FILE_TYPE_HANDLERS, audioHandler, claimedHandlerIds, extOf, fileTypeHandler, handlerForName, handlerIdsOf,
} from './handlers.js';
import { APPS } from '../facets/manifests.js';

/** A FLAC with STREAMINFO (2 s, 44.1 kHz stereo 16 bit) and a Vorbis comment block; no audio frames. */
function flac(comments: Record<string, string>): Buffer {
  const u32le = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(n, 0); return b; };
  const block = (type: number, body: Buffer, last: boolean) => {
    const h = Buffer.alloc(4);
    h[0] = (last ? 0x80 : 0) | type;
    h.writeUIntBE(body.length, 1, 3);
    return Buffer.concat([h, body]);
  };
  const si = Buffer.alloc(34);
  si.writeUInt16BE(4096, 0);
  si.writeUInt16BE(4096, 2);
  si.writeBigUInt64BE((44_100n << 44n) | (1n << 41n) | (15n << 36n) | 88_200n, 10);
  const vendor = Buffer.from('test');
  const cs = Object.entries(comments).map(([k, v]) => Buffer.from(`${k}=${v}`));
  const vc = Buffer.concat([u32le(vendor.length), vendor, u32le(cs.length), ...cs.flatMap((c) => [u32le(c.length), c])]);
  return Buffer.concat([Buffer.from('fLaC'), block(0, si, false), block(4, vc, true)]);
}

describe('file-type handler registry', () => {
  it('has one handler per id and one handler per extension', () => {
    const ids = FILE_TYPE_HANDLERS.map((h) => h.id);
    expect(new Set(ids).size).toBe(ids.length);
    const exts = FILE_TYPE_HANDLERS.flatMap((h) => [...h.extensions]);
    expect(new Set(exts).size).toBe(exts.length);
    for (const ext of exts) expect(ext).toMatch(/^\.[a-z0-9]+$/);
  });

  it('claims the thirteen audio extensions the scanner always indexed, in any case', () => {
    expect([...audioHandler.extensions].sort()).toEqual(
      ['.aif', '.aiff', '.ape', '.dff', '.dsf', '.flac', '.m4a', '.mp3', '.mp4', '.ogg', '.opus', '.wav', '.wv'],
    );
    expect(handlerForName('a.FLAC')).toBe(audioHandler);
    expect(handlerForName('Disc 1/b.dsf')).toBe(audioHandler);
  });

  it('claims nothing else: sidecars, books, video and dot files stay out of files', () => {
    for (const name of ['cover.jpg', 'album.cue', 'rip.log', 'notes.txt', 'booklet.pdf', 'novel.epub', 'comic.cbz', 'clip.mkv', 'noext', '.flac']) {
      expect(handlerForName(name), name).toBeNull();
    }
  });

  it('finds a handler by the id a files row stores, and nothing for an unknown id', () => {
    expect(fileTypeHandler('audio')).toBe(audioHandler);
    expect(fileTypeHandler('epub')).toBeNull();
    expect(fileTypeHandler(null)).toBeNull();
  });

  it('lists the handlers each app claims, from its manifest', () => {
    expect(handlerIdsOf('music')).toEqual(['audio']);
    expect(handlerIdsOf('books')).toEqual([]);
    // every file type an app claims is a handler this build carries
    for (const a of APPS) for (const id of a.fileTypes) expect(fileTypeHandler(id), `${a.id} claims ${id}`).not.toBeNull();
  });

  it('claims for the walk only what apps that are on claim (a built-in app always is)', () => {
    expect([...claimedHandlerIds(() => false)]).toEqual(['audio']);
    expect(handlerForName('a.flac', claimedHandlerIds(() => false))).toBe(audioHandler);
    expect(handlerForName('a.flac', new Set())).toBeNull();
    expect(handlerForName('a.flac')).toBe(audioHandler);
  });

  it('gives each audio extension a MIME type', () => {
    for (const ext of audioHandler.extensions) expect(audioHandler.mediaType(ext), ext).toMatch(/^audio\//);
    expect(audioHandler.mediaType('.flac')).toBe('audio/flac');
    expect(audioHandler.mediaType('.mp3')).toBe('audio/mpeg');
    expect(audioHandler.mediaType('.jpg')).toBeNull();
    expect(extOf('x.Opus')).toBe('.opus');
  });
});

describe('audio handler', () => {
  let dir: string;
  beforeAll(async () => { dir = await mkdtemp(path.join(tmpdir(), 'tagave-handler-')); });
  afterAll(async () => { await rm(dir, { recursive: true, force: true }); });

  it('reads the columns and the tag snapshot scan.parse stores', async () => {
    const abs = path.join(dir, '01 - Song.flac');
    await writeFile(abs, flac({ TITLE: 'Song', ARTIST: 'Artist', ALBUM: 'Album', TRACKNUMBER: '1' }));
    const parsed = await audioHandler.parse(abs);
    expect(parsed.columns).toEqual({
      container: 'FLAC', codec: 'FLAC', lossless: true, durationMs: 2000, sampleRate: 44100, bitDepth: 16,
      channels: 2, bitrateKbps: parsed.columns.bitrateKbps, hasEmbeddedArt: false,
    });
    const meta = parsed.metadata as { common: Record<string, unknown>; native: Record<string, unknown> };
    expect(meta.common['title']).toBe('Song');
    expect(Object.keys(meta.native)).toEqual(['vorbis']);
    expect(audioHandler.identityDigest(parsed.metadata)).toBe(coreTagsDigest(parsed.metadata));
    expect(audioHandler.identityDigest(parsed.metadata)).toMatch(/^[0-9a-f]{40}$/);
  });

  it('throws on a file that is not audio, so scan.parse records a parse error', async () => {
    const abs = path.join(dir, 'bad.flac');
    await writeFile(abs, 'not a flac');
    await expect(audioHandler.parse(abs)).rejects.toThrow();
  });

  it('hashes the audio stream by the file extension', async () => {
    const abs = path.join(dir, 'h.flac');
    await writeFile(abs, flac({ TITLE: 'A' }));
    const before = await audioHandler.contentHash!(abs);
    await writeFile(abs, flac({ TITLE: 'A much longer title' }));
    expect(await audioHandler.contentHash!(abs)).toBe(before);
  });

  it('writes through the file writer it is given', async () => {
    const writer: TagWriter = { id: 'fake', read: vi.fn(), write: vi.fn(async () => undefined), supports: () => true };
    await audioHandler.write!('/x/a.flac', { title: 'T' } as never, writer, { id3Version: '2.4' } as never);
    expect(writer.write).toHaveBeenCalledWith('/x/a.flac', { title: 'T' }, { id3Version: '2.4' });
  });
});
