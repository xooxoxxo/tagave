import { describe, it, expect } from 'vitest';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseFile } from 'music-metadata';
import { writeFlac } from './flac.js';

describe('writeFlac', () => {
  it('writes a FLAC music-metadata reads back, tags and duration included', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'tagave-flac-'));
    try {
      const p = path.join(dir, 'x.flac');
      await writeFlac(p, { title: 'Song', artist: 'Artist', album: 'Album One', albumartist: 'Artist', track: 2, disc: 1, date: '2001', seconds: 42, padding: 100 });
      const meta = await parseFile(p, { duration: true });
      expect(meta.common).toMatchObject({ title: 'Song', artist: 'Artist', album: 'Album One', albumartist: 'Artist', track: { no: 2 }, disk: { no: 1 } });
      expect(Math.round(meta.format.duration!)).toBe(42);
      const small = path.join(dir, 'y.flac');
      await writeFlac(small, { title: 'Song', seconds: 42, padding: 0 });
      expect((await stat(p)).size).toBeGreaterThan((await stat(small)).size);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
