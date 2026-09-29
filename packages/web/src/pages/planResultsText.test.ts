import { describe, it, expect } from 'vitest';
import type { TagPlanResultAlbum, TagPlanResults } from '@liner/shared';
import { resultsFilesLine, resultsHeadline } from './planResultsText';

const album = (over: Partial<TagPlanResultAlbum> = {}): TagPlanResultAlbum => ({
  id: '00000000-0000-4000-8000-000000000001', title: 'The Last Tycoon', artistCredit: 'Peter Morén', artistId: null,
  year: 2008, coverUrl: null, trackCount: 10, planFiles: 10, mergedFrom: 0, ...over,
});
const results = (over: Partial<TagPlanResults> = {}): TagPlanResults => ({
  filesWritten: 10, filesFailed: 0, albumsInScope: 1, albums: [album()], looseFiles: 0, updating: false, ...over,
});

describe('resultsHeadline', () => {
  it('a merge that became one album says how many went in, and names the result', () => {
    expect(resultsHeadline(results({ albums: [album({ mergedFrom: 2 })] }))).toBe('3 albums became 1: The Last Tycoon by Peter Morén');
  });

  it('several albums in scope that ended as one say so too', () => {
    expect(resultsHeadline(results({ albumsInScope: 3 }))).toBe('3 albums became 1: The Last Tycoon by Peter Morén');
  });

  it('one album in, one album out: just its name', () => {
    expect(resultsHeadline(results())).toBe('The Last Tycoon by Peter Morén');
  });

  it('several albums', () => {
    const two = [album(), album({ id: '00000000-0000-4000-8000-000000000002', title: 'Other' })];
    expect(resultsHeadline(results({ albums: two, albumsInScope: 2 }))).toBe('2 albums');
    expect(resultsHeadline(results({ albums: two, albumsInScope: 5 }))).toBe('5 albums became 2');
    expect(resultsHeadline(results({ albums: two, albumsInScope: null }))).toBe('2 albums');
  });

  it('files outside any album', () => {
    expect(resultsHeadline(results({ albums: [], looseFiles: 4, filesWritten: 4 }))).toBe('4 files written, not part of any album');
  });
});

describe('resultsFilesLine', () => {
  it('counts written, failed and loose files', () => {
    expect(resultsFilesLine(results())).toBe('10 files written');
    expect(resultsFilesLine(results({ filesWritten: 1, filesFailed: 2, looseFiles: 1 }))).toBe('1 file written · 2 failed · 1 file not in an album');
  });
});
