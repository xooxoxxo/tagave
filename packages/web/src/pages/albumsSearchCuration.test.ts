import { describe, expect, it } from 'vitest';
import { hasCurationFilters, withoutCurationFilters, type AlbumsSearch } from './albumsSearch';

describe('albums list: curation filters are Maintenance-only', () => {
  it('spots match state, library issues and match kind', () => {
    expect(hasCurationFilters({ state: ['matched'] } as AlbumsSearch)).toBe(true);
    expect(hasCurationFilters({ gap: ['quality'] } as AlbumsSearch)).toBe(true);
    expect(hasCurationFilters({ decided: 'by_me' } as AlbumsSearch)).toBe(true);
    expect(hasCurationFilters({ genre: ['Jazz'], q: 'blue' } as AlbumsSearch)).toBe(false);
    expect(hasCurationFilters({ state: [] } as unknown as AlbumsSearch)).toBe(false);
  });

  it('drops only the curation filters, keeping the listening ones and the sort', () => {
    const search = { state: ['matched'], gap: ['quality'], decided: 'by_me', genre: ['Jazz'], sort: 'year' } as AlbumsSearch;
    expect(withoutCurationFilters(search)).toEqual({ genre: ['Jazz'], sort: 'year' });
  });
});
