import { describe, expect, it } from 'vitest';
import { workOf } from './SettingsUpdatesPage';

describe('workOf (Settings › Updates, Queues column)', () => {
  it('says all for a worker that serves every queue', () => {
    expect(workOf(['*'])).toBe('all');
  });

  it('groups a split worker’s queues by kind, in a fixed order', () => {
    expect(workOf(['scan.root', 'scan.dir', 'cluster.dir', 'art.fetch', 'gaps.recompute', 'queue.autoaccept', 'facets.refresh', 'fingerprint.album', 'tags.apply'])).toBe('folders, identify, details, tags, upkeep');
    expect(workOf(['identify.album', 'identify.acoustid', 'enrich.release', 'reviews.fetch', 'artists.resolve', 'tracks.link', 'acoustid.lookup'])).toBe('identify, details');
    expect(workOf(['collection.sync'])).toBe('Discogs');
  });

  it('shows a dash for none', () => {
    expect(workOf([])).toBe('–');
  });
});
