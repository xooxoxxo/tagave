import { describe, it, expect } from 'vitest';
import { explainPreview } from './planOutcome';

const a1 = '00000000-0000-4000-8000-000000000001';
const a2 = '00000000-0000-4000-8000-000000000002';
const f = (n: number) => `00000000-0000-4000-8000-0000000001${String(n).padStart(2, '0')}`;

describe('explainPreview', () => {
  it('nothing to change because the albums are not identified', () => {
    const o = explainPreview({
      filesTouched: 0, fieldsModified: 0, lockedFieldsRespected: 0, filesInScope: 3, filesAlreadyCorrect: 0, filesLockedOnly: 0,
      filesSkipped: [
        { audioFileId: f(1), reason: 'album_not_identified', localAlbumId: a1 },
        { audioFileId: f(2), reason: 'album_not_identified', localAlbumId: a2 },
        { audioFileId: f(3), reason: 'album_not_identified', localAlbumId: a2 },
      ],
    })!;
    expect(o.nothing).toBe(true);
    expect(o.explained).toBe(true);
    expect(o.notIdentified).toEqual({ files: 3, albumIds: [a1, a2] });
  });

  it('reads plans previewed before the reasons were split', () => {
    const o = explainPreview({
      filesTouched: 0, fieldsModified: 0, lockedFieldsRespected: 0,
      filesSkipped: [{ audioFileId: f(1), reason: 'audio_file_error', message: 'album not identified' }, { audioFileId: f(2), reason: 'audio_file_error', message: 'EACCES' }],
    })!;
    expect(o.notIdentified.files).toBe(1);
    expect(o.notIdentified.albumIds).toEqual([]);
    expect(o.errors).toEqual({ files: 1, sample: 'EACCES' });
    expect(o.alreadyCorrect).toBeNull();
  });

  it('already correct and locked are told apart', () => {
    const o = explainPreview({ filesTouched: 0, fieldsModified: 0, lockedFieldsRespected: 2, filesSkipped: [], filesAlreadyCorrect: 5, filesLockedOnly: 1 })!;
    expect(o).toMatchObject({ nothing: true, alreadyCorrect: 5, lockedOnly: 1, lockedChanges: 2, explained: true });
  });

  it('an old plan with no detail explains nothing', () => {
    const o = explainPreview({ filesTouched: 0, fieldsModified: 0, lockedFieldsRespected: 0, filesSkipped: [] })!;
    expect(o.explained).toBe(false);
    expect(explainPreview(undefined)).toBeNull();
  });
});
