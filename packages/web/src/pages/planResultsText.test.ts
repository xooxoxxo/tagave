import { describe, it, expect } from 'vitest';
import type { TagPlanResultAlbum, TagPlanResults } from '@liner/shared';
import { RESULT_STATUSES, resultsFilesLine, resultsHeadline, revertedLine } from './planResultsText';

const album = (over: Partial<TagPlanResultAlbum> = {}): TagPlanResultAlbum => ({
  id: '00000000-0000-4000-8000-000000000001', title: 'The Last Tycoon', artistCredit: 'Peter Morén', artistId: null,
  year: 2008, coverUrl: null, trackCount: 10, planFiles: 10, ...over,
});
const results = (over: Partial<TagPlanResults> = {}): TagPlanResults => ({
  filesWritten: 10, filesFailed: 0, albumsBefore: 1, albumCount: 1, albums: [album()], looseFiles: 0, updating: false, ...over,
});
const two = [album(), album({ id: '00000000-0000-4000-8000-000000000002', title: 'Other' })];

describe('resultsHeadline', () => {
  it('files that sat in three albums before the plan and now form one say so, and name the result', () => {
    expect(resultsHeadline(results({ albumsBefore: 3 }))).toBe('3 albums became 1: The Last Tycoon by Peter Morén');
  });

  it('one album in, one album out: just its name, even if an earlier action merged it', () => {
    expect(resultsHeadline(results())).toBe('The Last Tycoon by Peter Morén');
  });

  it('no count from before (older plans): never claims a merge', () => {
    expect(resultsHeadline(results({ albumsBefore: null }))).toBe('The Last Tycoon by Peter Morén');
    expect(resultsHeadline(results({ albumsBefore: null, albums: two, albumCount: 2 }))).toBe('2 albums');
  });

  it('several albums, counted in full even when the list is capped', () => {
    expect(resultsHeadline(results({ albums: two, albumCount: 2, albumsBefore: 2 }))).toBe('2 albums');
    expect(resultsHeadline(results({ albums: two, albumCount: 2, albumsBefore: 5 }))).toBe('5 albums became 2');
    expect(resultsHeadline(results({ albums: two, albumCount: 140, albumsBefore: 140 }))).toBe('140 albums');
    expect(resultsHeadline(results({ albums: two, albumCount: 140, albumsBefore: 150 }))).toBe('150 albums became 140');
  });

  it('files outside any album', () => {
    expect(resultsHeadline(results({ albums: [], albumCount: 0, looseFiles: 4, filesWritten: 4 }))).toBe('4 files written, not part of any album');
  });
});

describe('resultsFilesLine', () => {
  it('counts written, failed and loose files', () => {
    expect(resultsFilesLine(results())).toBe('10 files written');
    expect(resultsFilesLine(results({ filesWritten: 1, filesFailed: 2, looseFiles: 1 }))).toBe('1 file written · 2 failed · 1 file not in an album');
  });

  it('says when only the first albums are listed', () => {
    expect(resultsFilesLine(results({ albums: two, albumCount: 140 }))).toBe('10 files written · first 2 albums shown');
  });
});

describe('reverted plans', () => {
  it('lead with no results section: the albums they made are gone', () => {
    expect(RESULT_STATUSES.has('reverted')).toBe(false);
    expect(RESULT_STATUSES.has('applied')).toBe(true);
  });

  it('keep one plain line instead', () => {
    expect(revertedLine(10)).toBe('Reverted: the tags from before this plan are back on 10 files.');
    expect(revertedLine(1)).toBe('Reverted: the tags from before this plan are back on 1 file.');
  });
});
