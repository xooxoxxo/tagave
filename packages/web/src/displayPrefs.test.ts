import { describe, expect, it } from 'vitest';
import { DEFAULT_DISPLAY_PREFS, parseDisplayPrefs } from './displayPrefs';

describe('display preferences', () => {
  it('defaults to today\'s look', () => {
    expect(DEFAULT_DISPLAY_PREFS).toEqual({ searchPlacement: 'below', showWordmark: true, shortAlbumArt: true });
    expect(parseDisplayPrefs(null)).toEqual(DEFAULT_DISPLAY_PREFS);
  });
  it('keeps valid stored values', () => {
    expect(parseDisplayPrefs(JSON.stringify({ searchPlacement: 'beside', showWordmark: false, shortAlbumArt: false })))
      .toEqual({ searchPlacement: 'beside', showWordmark: false, shortAlbumArt: false });
  });
  it('falls back per field on junk', () => {
    expect(parseDisplayPrefs(JSON.stringify({ searchPlacement: 'left', showWordmark: 'no' }))).toEqual(DEFAULT_DISPLAY_PREFS);
    expect(parseDisplayPrefs('{not json')).toEqual(DEFAULT_DISPLAY_PREFS);
    expect(parseDisplayPrefs('7')).toEqual(DEFAULT_DISPLAY_PREFS);
  });
});
