import { describe, expect, it } from 'vitest';
import { DEFAULT_DISPLAY_PREFS, parseDisplayPrefs } from './displayPrefs';

describe('display preferences', () => {
  it('defaults to today\'s look', () => {
    expect(DEFAULT_DISPLAY_PREFS).toEqual({ searchPlacement: 'below', showWordmark: true, shortAlbumArt: true, artistLayout: 'name' });
    expect(parseDisplayPrefs(null)).toEqual(DEFAULT_DISPLAY_PREFS);
  });
  it('keeps valid stored values', () => {
    expect(parseDisplayPrefs(JSON.stringify({ searchPlacement: 'beside', showWordmark: false, shortAlbumArt: false, artistLayout: 'albums' })))
      .toEqual({ searchPlacement: 'beside', showWordmark: false, shortAlbumArt: false, artistLayout: 'albums' });
  });
  it('a browser that stored prefs before the artist layout existed gets the name-first page', () => {
    expect(parseDisplayPrefs(JSON.stringify({ searchPlacement: 'beside', showWordmark: false, shortAlbumArt: false })).artistLayout).toBe('name');
  });
  it('falls back per field on junk', () => {
    expect(parseDisplayPrefs(JSON.stringify({ searchPlacement: 'left', showWordmark: 'no', artistLayout: 'grid' }))).toEqual(DEFAULT_DISPLAY_PREFS);
    expect(parseDisplayPrefs('{not json')).toEqual(DEFAULT_DISPLAY_PREFS);
    expect(parseDisplayPrefs('7')).toEqual(DEFAULT_DISPLAY_PREFS);
  });
});
