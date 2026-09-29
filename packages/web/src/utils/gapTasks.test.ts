import { describe, expect, it } from 'vitest';
import { doneLabel, gapLine, missingTrackLabel, positionRanges, taskText, wrongFix } from './gapTasks';

const transformation = {
  kind: 'incomplete_album',
  flag: '',
  details: {
    have: 14,
    want: 18,
    missing: [
      { disc: 1, position: 1, title: 'Sound of Soul', lengthMs: 1 },
      { disc: 1, position: 2, title: 'Change', lengthMs: 1 },
      { disc: 1, position: 3, title: 'Sensibility', lengthMs: 1 },
      { disc: 1, position: 4, title: 'Benevolent Smile', lengthMs: 1 },
    ],
  },
};

describe('positionRanges', () => {
  it('folds runs and keeps pairs apart', () => {
    expect(positionRanges([1, 2, 3, 4])).toBe('1–4');
    expect(positionRanges([1, 2])).toBe('1 and 2');
    expect(positionRanges([7, 1, 3, 5, 6])).toBe('1, 3 and 5–7');
    expect(positionRanges([9])).toBe('9');
  });
});

describe('missingTrackLabel', () => {
  it('names the discs of a multi-disc album', () => {
    expect(missingTrackLabel([{ disc: 1, position: 3 }, { disc: 1, position: 4 }, { disc: 2, position: 1 }]))
      .toBe('Disc 1 tracks 3 and 4, disc 2 track 1');
    expect(missingTrackLabel([{ disc: 1, position: 5 }])).toBe('Track 5');
  });
});

describe('gapLine', () => {
  it('says how many tracks are missing', () => {
    expect(gapLine(transformation)).toBe('4 tracks of 18 are missing');
  });
  it('describes one quality flag per row', () => {
    expect(gapLine({ kind: 'quality', flag: 'lowBitrate', details: { flags: { lowBitrate: 3 } } })).toBe('Low bitrate · 3 tracks');
    expect(gapLine({ kind: 'quality', flag: 'noCover', details: { flags: { noCover: true } } })).toBe('No cover art');
  });
  it('explains the tag-write alert', () => {
    expect(gapLine({ kind: 'quality', details: { reason: 'audio_hash_mismatch' } })).toMatch(/tag write stopped/);
  });
});

describe('taskText', () => {
  it('turns an incomplete album into the owner’s task', () => {
    expect(taskText(transformation, { title: 'Transformation', folder: 'Karunesh/Transformation' })).toBe(
      'Find the 4 missing tracks of Transformation (Tracks 1–4: Sound of Soul, Change, Sensibility, Benevolent Smile) and add them to Karunesh/Transformation',
    );
  });
  it('uses the singular for one track and falls back without a folder', () => {
    const one = { kind: 'incomplete_album', details: { have: 9, want: 10, missing: [{ disc: 1, position: 10, title: 'Coda' }] } };
    expect(taskText(one, { title: 'X' })).toBe('Find the missing track of X (Track 10: Coda) and add it to the album’s folder');
  });
  it('writes a task for other kinds and quality flags', () => {
    expect(taskText({ kind: 'missing_album', details: { title: 'Heart' } }, { artist: 'Karunesh' })).toBe('Get Heart by Karunesh and add it to your library');
    expect(taskText({ kind: 'duplicate', details: { count: 3 } }, { title: 'Blue' })).toBe('Choose which of the 3 copies of Blue to keep and remove the others from your music folders');
    expect(taskText({ kind: 'quality', flag: 'noCover', details: { flags: { noCover: true } } }, { title: 'Blue' })).toBe('Add cover art to Blue');
    expect(taskText({ kind: 'quality', flag: 'parseErrors', details: { flags: { parseErrors: 2 } } }, { title: 'Blue', folder: 'J/Blue' }))
      .toBe('Replace the 2 unreadable files of Blue in J/Blue');
    expect(taskText({ kind: 'quality', flag: 'trackNumberIssues', details: { flags: { trackNumberIssues: { issues: ['missing tracknumber at track index 3'] } } } }, { title: 'Blue' }))
      .toBe('Fix track numbers on Blue (1 track)');
  });
});

describe('wrongFix', () => {
  it('points an incomplete album at the editions', () => {
    expect(wrongFix(transformation).action).toBe('editions');
    expect(wrongFix({ kind: 'quality' }).action).toBeNull();
  });
});

describe('doneLabel', () => {
  it('says the scan resolved it, or that the album is gone', () => {
    expect(doneLabel({ resolvedAt: '2026-09-29T10:00:00Z', subjectGone: false }, 'en-GB')).toMatch(/^Resolved by scan on 29 Sep/);
    expect(doneLabel({ resolvedAt: null, subjectGone: true })).toBe('No longer in your library');
  });
});
