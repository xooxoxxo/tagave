/**
 * fileRecovery.ts through the file gate: the containment check resolves both
 * sides, the stat and the digest run in a helper, and an offline folder is
 * never read as a file that is not there. Uses the built helper
 * (dist/lib/fileHelper.js): build first.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setFileGate } from './fileGate.js';
import { FolderOfflineError } from './folderOffline.js';
import { fileDigest, fileStat, insideRoot, mountIdentity } from './fileRecovery.js';
import { OutageGate } from '../testkit/outageGate.js';

describe('file recovery checks through the file gate', () => {
  const rootId = randomUUID();
  let base = '';
  let real = '';
  let link = '';
  let gate: OutageGate;

  beforeAll(async () => {
    base = await mkdtemp(path.join(tmpdir(), 'tagave-recovery-'));
    real = path.join(base, 'real', 'music');
    await mkdir(path.join(real, 'A'), { recursive: true });
    await writeFile(path.join(real, 'A', 'b.flac'), 'audio of b');
    await mkdir(path.join(base, 'mnt'), { recursive: true });
    link = path.join(base, 'mnt', 'music');
    await symlink(real, link);
    // a link inside the root that leads out of it
    await mkdir(path.join(base, 'outside'), { recursive: true });
    await symlink(path.join(base, 'outside'), path.join(real, 'Away'));
    gate = new OutageGate();
    setFileGate(gate);
  });

  afterEach(() => {
    gate.up();
  });

  afterAll(async () => {
    setFileGate(null);
    await gate?.close();
    if (base) await rm(base, { recursive: true, force: true });
  });

  it('a symlinked root stays inside itself', async () => {
    gate.ops.length = 0;
    await expect(insideRoot(rootId, link, path.join(link, 'A', 'b.flac'))).resolves.toBeUndefined();
    // the same file by its real path, and a file not written yet
    await expect(insideRoot(rootId, link, path.join(real, 'A', 'b.flac'))).resolves.toBeUndefined();
    await expect(insideRoot(rootId, link, path.join(link, 'New', 'Folder', 'c.flac'))).resolves.toBeUndefined();
    expect(gate.ops).toContain('realpath');
    // a link out of the root, and a path that climbs out, are refused
    await expect(insideRoot(rootId, link, path.join(link, 'Away', 'x.flac'))).rejects.toThrow('The file path leaves its music folder');
    await expect(insideRoot(rootId, link, path.join(link, '..', 'elsewhere.flac'))).rejects.toThrow('The file path leaves its music folder');
  });

  it('stat and digest run in the helper; a file that is not there reads null', async () => {
    const st = await fileStat(rootId, path.join(link, 'A', 'b.flac'));
    expect(st).toMatchObject({ isFile: true, isDirectory: false, size: 10 });
    expect(await fileStat(rootId, path.join(link, 'A', 'gone.flac'))).toBeNull();
    const want = createHash('sha256').update('audio of b').digest('hex');
    expect(await fileDigest(rootId, path.join(link, 'A', 'b.flac'))).toBe(want);
    await expect(fileDigest(rootId, path.join(link, 'A'))).rejects.toMatchObject({ code: 'EFTYPE' });
    expect(JSON.parse(await mountIdentity(rootId, link))[0]).toBe(JSON.parse(await mountIdentity(rootId, real))[0]);
  });

  it('an offline folder is never a file that is not there', async () => {
    gate.down = true;
    await expect(fileStat(rootId, path.join(link, 'A', 'gone.flac'))).rejects.toBeInstanceOf(FolderOfflineError);
    await expect(fileDigest(rootId, path.join(link, 'A', 'b.flac'))).rejects.toBeInstanceOf(FolderOfflineError);
    await expect(insideRoot(rootId, link, path.join(link, 'A', 'b.flac'))).rejects.toBeInstanceOf(FolderOfflineError);
    await expect(mountIdentity(rootId, link)).rejects.toBeInstanceOf(FolderOfflineError);
  });
});
