import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { LidarrRequestView } from '@tagave/shared';
import { LidarrChip, MissingLidarr, lidarrStateText, missingAlbumItems } from './LidarrControls';

const req = (state: LidarrRequestView['state'], progress: number | null = null): LidarrRequestView =>
  ({ id: 'r1', releaseGroupId: 'rg1', state, progress, error: null, requestedAt: '2026-11-03T10:00:00Z' });
const act = { get: () => undefined, retry: () => undefined, cancel: () => undefined };

describe('a missing album and Lidarr', () => {
  it('one word per state, Downloading with its percent', () => {
    expect(['wanted', 'imported', 'done', 'not_found'].map((s) => lidarrStateText(req(s as never)))).toEqual(['Wanted', 'Importing', 'In library', 'Not found']);
    expect(lidarrStateText(req('downloading', 42))).toBe('Downloading 42%');
    expect(lidarrStateText(req('downloading'))).toBe('Downloading');
  });

  it('the ⋮: Get when it can be asked for, Retry and Cancel when not found, Cancel while on its way', () => {
    expect(missingAlbumItems(undefined, true, act).map((i) => i.label)).toEqual(['Get']);
    expect(missingAlbumItems(undefined, false, act)).toEqual([]);
    expect(missingAlbumItems(req('not_found'), true, act).map((i) => i.label)).toEqual(['Retry', 'Cancel']);
    expect(missingAlbumItems(req('downloading', 10), true, act).map((i) => i.label)).toEqual(['Cancel']);
    expect(missingAlbumItems(req('done'), true, act)).toEqual([]);
  });

  it('the chip shows the state on the cover; nothing without a request or the module', () => {
    const view = { available: true, canGet: false, gettable: [], requests: { rg1: req('downloading', 40) } };
    const html = renderToStaticMarkup(<MissingLidarr.Provider value={{ view, libraryId: 'l', artistId: 'a' }}><LidarrChip releaseGroupId="rg1" /></MissingLidarr.Provider>);
    expect(html).toContain('Downloading 40%');
    expect(renderToStaticMarkup(<LidarrChip releaseGroupId="rg1" />)).toBe('');
  });
});
