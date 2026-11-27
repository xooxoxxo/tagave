/**
 * undoSplitsOfPlan after the split's tracks went into the trash: a check of
 * the source's place that fails for some other reason than an offline share
 * (EACCES) must not skip putting the tracks back. An offline answer still
 * throws out of the undo (tags.revert parks).
 */
import path from 'node:path';
import pino from 'pino';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FolderOfflineError } from '../lib/folderOffline.js';

const fs = vi.hoisted(() => ({
  backError: null as unknown,
  renames: [] as Array<[string, string]>,
}));
const { ROOT, SOURCE, OUTPUTS } = vi.hoisted(() => ({
  ROOT: '/mnt/music',
  SOURCE: 'Robin/Album/Whole.flac',
  OUTPUTS: ['Robin/Album/01 One.flac', 'Robin/Album/02 Two.flac'],
}));

vi.mock('../lib/deletions.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/deletions.js')>();
  return {
    ...actual,
    onDisk: vi.fn(async (_rootId: string, root: string, rel: string) => path.join(root, rel)),
    trashOne: vi.fn(async (_rootId: string, _root: string, rel: string) => ({ outcome: 'trashed', trashRelPath: `.trash/day/${rel}` })),
    restoreWaiting: vi.fn(async () => ({ restored: 1, refused: 0, dropped: 0 })),
    exists: vi.fn(async (_rootId: string, p: string) => {
      if (p === path.join(ROOT, SOURCE)) throw fs.backError;
      return false;
    }),
    makeDirs: vi.fn(async () => null),
    renamePath: vi.fn(async (_rootId: string, from: string, to: string) => {
      fs.renames.push([from, to]);
    }),
    markLibraryDirty: vi.fn(async () => undefined),
  };
});

const { undoSplitsOfPlan } = await import('./planSplits.js');

/** A tagged-template stand-in for ctx.sql: the split row and its source's trash row; every write answers nothing. */
function fakeSql() {
  const sql = (strings: TemplateStringsArray) => {
    const text = strings.join('?');
    if (text.includes('from album_splits')) {
      return Promise.resolve([{ id: 's1', libraryId: 'l1', localAlbumId: 'a1', fileId: 'f1', outputs: OUTPUTS, createdBy: null }]);
    }
    if (text.includes('from file_deletions fd join scan_roots')) {
      return Promise.resolve([{ scanRootId: 'r1', relPath: SOURCE, trashRelPath: `.trash/old/${SOURCE}`, root: ROOT }]);
    }
    return Promise.resolve([]);
  };
  return Object.assign(sql, { begin: vi.fn() });
}

describe('undoSplitsOfPlan: the source\'s place cannot be checked', () => {
  const warn = vi.fn();
  const ctx = () => {
    const logger = pino({ level: 'silent' });
    logger.warn = warn as any;
    return { sql: fakeSql(), db: {} as any, boss: { send: vi.fn() } as any, logger } as any;
  };

  beforeEach(() => {
    fs.renames = [];
    warn.mockClear();
  });

  it('EACCES: the tracks come back out of the trash and the split stays', async () => {
    fs.backError = Object.assign(new Error('permission denied'), { code: 'EACCES' });
    const c = ctx();
    await expect(undoSplitsOfPlan(c, 'p1')).resolves.toEqual({ tried: 1, undone: 0 });
    expect(fs.renames).toEqual(OUTPUTS.map((rel) => [path.join(ROOT, `.trash/day/${rel}`), path.join(ROOT, rel)]));
    expect(c.sql.begin).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
  });

  it('an offline answer still throws out of the undo, nothing put back', async () => {
    fs.backError = new FolderOfflineError('r1', 'io_error', 'EIO');
    await expect(undoSplitsOfPlan(ctx(), 'p1')).rejects.toBeInstanceOf(FolderOfflineError);
    expect(fs.renames).toEqual([]);
  });
});
