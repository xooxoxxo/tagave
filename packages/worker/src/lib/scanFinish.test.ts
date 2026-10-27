import { describe, it, expect } from 'vitest';
import { missingHold, isUnderFailedPath, finishNotes } from './scanFinish.js';

describe('missingHold', () => {
  it('holds above 20% of present files when that is below 500', () => {
    expect(missingHold(201, 1000)).toEqual({ held: true, threshold: 200 });
    expect(missingHold(200, 1000)).toEqual({ held: false, threshold: 200 });
  });
  it('holds above 500 when 20% is higher', () => {
    expect(missingHold(501, 100_000)).toEqual({ held: true, threshold: 500 });
  });
  it('never holds 10 files or fewer', () => {
    expect(missingHold(10, 12)).toEqual({ held: false, threshold: 10 });
    expect(missingHold(11, 30)).toEqual({ held: true, threshold: 10 });
  });
});

describe('isUnderFailedPath', () => {
  it('matches the failed dir, its descendants and a failed file', () => {
    expect(isUnderFailedPath('A/B/1.flac', ['A/B'])).toBe(true);
    expect(isUnderFailedPath('A/BC/1.flac', ['A/B'])).toBe(false);
    expect(isUnderFailedPath('A/1.flac', ['A/1.flac'])).toBe(true);
    expect(isUnderFailedPath('x.flac', [''])).toBe(true);
  });
  it('takes a Set and checks every ancestor level', () => {
    const failed = new Set(['A/B/C', 'X/1.flac']);
    expect(isUnderFailedPath('A/B/C/D/1.flac', failed)).toBe(true);
    expect(isUnderFailedPath('A/B/1.flac', failed)).toBe(false);
    expect(isUnderFailedPath('X/1.flac', failed)).toBe(true);
    expect(isUnderFailedPath('X/1.flac.bak', failed)).toBe(false);
    expect(isUnderFailedPath('A/1.flac', new Set())).toBe(false);
  });
});

describe('finishNotes', () => {
  it('finishNotes says what was not done and why', () => {
    expect(finishNotes({ failedDirs: ['A', 'B'], heldMissing: { count: 12, threshold: 10 }, reconcileSkipped: null }))
      .toBe('; could not read A, B; nothing under them was marked missing; Held: 12 files look gone. If they are still gone after 24 hours, they will be marked missing.');
    expect(finishNotes({ failedDirs: [], heldMissing: null, reconcileSkipped: null })).toBe('');
  });
  it('says how many held files were marked missing after the wait', () => {
    expect(finishNotes({ failedDirs: [], heldMissing: null, reconcileSkipped: null, confirmedAfterHold: 612 }))
      .toBe('; Marked missing: 612 files were still gone 24 hours after they were held.');
  });
  it('names three folders and counts the rest', () => {
    expect(finishNotes({ failedDirs: ['A', 'B', 'C', 'D', 'E'], heldMissing: null, reconcileSkipped: 'x' }))
      .toBe('; could not read A, B, C, and 2 more; nothing under them was marked missing; x');
  });
});
