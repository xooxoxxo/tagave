import { describe, expect, it } from 'vitest';
import { DEFAULT_DISPLAY_PREFS, parseDisplayPrefs } from './displayPrefs';
import { DEFAULT_ALBUM_WIDGETS } from './pages/albumWidgets';

describe('display preferences', () => {
  it('defaults to today\'s look', () => {
    expect(DEFAULT_DISPLAY_PREFS).toEqual({ searchPlacement: 'below', showWordmark: true, shortAlbumArt: true, shortAlbumWaves: false, albumWidgets: DEFAULT_ALBUM_WIDGETS, artistLayout: 'name', adaptiveColour: true, eqGlow: false });
    expect(parseDisplayPrefs(null)).toEqual(DEFAULT_DISPLAY_PREFS);
  });
  it('keeps valid stored values', () => {
    expect(parseDisplayPrefs(JSON.stringify({ searchPlacement: 'beside', showWordmark: false, shortAlbumArt: false, shortAlbumWaves: true, artistLayout: 'albums', adaptiveColour: false, eqGlow: true })))
      .toEqual({ searchPlacement: 'beside', showWordmark: false, shortAlbumArt: false, shortAlbumWaves: true, albumWidgets: DEFAULT_ALBUM_WIDGETS, artistLayout: 'albums', adaptiveColour: false, eqGlow: true });
  });
  it('keeps valid widget placements and fills in missing widgets', () => {
    expect(parseDisplayPrefs('{"albumWidgets":{"ownership":"above","genre":"hidden","year":"invalid"}}').albumWidgets)
      .toEqual({ genre: 'hidden', year: 'above', tracks: 'below', duration: 'below', format: 'below', ownership: 'above' });
  });
  it('a browser that stored prefs before the artist layout existed gets the name-first page', () => {
    expect(parseDisplayPrefs(JSON.stringify({ searchPlacement: 'beside', showWordmark: false, shortAlbumArt: false })).artistLayout).toBe('name');
  });
  it('a browser that stored prefs before adaptive colour existed gets it on, and the glow off', () => {
    const p = parseDisplayPrefs(JSON.stringify({ searchPlacement: 'beside' }));
    expect(p.adaptiveColour).toBe(true);
    expect(p.eqGlow).toBe(false);
  });
  it('falls back per field on junk', () => {
    expect(parseDisplayPrefs(JSON.stringify({ searchPlacement: 'left', showWordmark: 'no', artistLayout: 'grid', adaptiveColour: 'yes', eqGlow: 1 }))).toEqual(DEFAULT_DISPLAY_PREFS);
    expect(parseDisplayPrefs('{not json')).toEqual(DEFAULT_DISPLAY_PREFS);
    expect(parseDisplayPrefs('7')).toEqual(DEFAULT_DISPLAY_PREFS);
  });
});
