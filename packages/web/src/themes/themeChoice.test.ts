import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DISPLAY_STORAGE_KEY } from '../displayPrefs';
import { THEME_CHOICE_KEY, THEME_TOKENS_KEY, applyThemeTokens, cacheThemeTokens, defaultChoice, parseChoice, resetThemeChoiceForTests, setThemeChoice } from './themeChoice';

function fakeStorage() {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
  };
}

/** Enough of <html> for applyThemeTokens: inline properties and the dataset. */
function fakeRoot() {
  const props = new Map<string, string>();
  return {
    props,
    dataset: {} as Record<string, string | undefined>,
    style: { setProperty: (k: string, v: string) => void props.set(k, v), removeProperty: (k: string) => void props.delete(k) },
  };
}

beforeEach(() => {
  vi.stubGlobal('localStorage', fakeStorage());
  resetThemeChoiceForTests();
});
afterEach(() => vi.unstubAllGlobals());

describe('the theme choice on this browser', () => {
  it('follows the old Adaptive colours switch until the person picks', () => {
    expect(defaultChoice()).toEqual({ theme: 'adaptive', custom: null });
    localStorage.setItem(DISPLAY_STORAGE_KEY, JSON.stringify({ adaptiveColour: false }));
    expect(defaultChoice()).toEqual({ theme: 'classic', custom: null });
  });

  it('keeps only a valid copy', () => {
    expect(parseChoice(JSON.stringify({ theme: 'moody', custom: null }))).toEqual({ theme: 'moody', custom: null });
    expect(parseChoice(JSON.stringify({ theme: 'neon', custom: null }))).toBeNull();
    expect(parseChoice('{')).toBeNull();
    expect(parseChoice(null)).toBeNull();
  });

  it('stores what is set', () => {
    setThemeChoice({ theme: 'custom', custom: { seed: '#3a7d5c' } });
    expect(parseChoice(localStorage.getItem(THEME_CHOICE_KEY))).toEqual({ theme: 'custom', custom: { seed: '#3a7d5c' } });
  });

  it('writes a theme on <html> and takes all of it off, the first paint\'s too', () => {
    const root = fakeRoot();
    // index.html painted from the cache before the app loaded
    cacheThemeTokens({ light: { '--canvas': '#fff', '--old-only': '1' }, dark: { '--canvas': '#000' } });
    root.props.set('--canvas', '#fff');
    root.props.set('--old-only', '1');
    root.props.set('--player-bar-h', '72px');
    root.dataset['themed'] = '';

    applyThemeTokens({ '--canvas': '#eee', '--dew': '#123456' }, root as unknown as HTMLElement);
    expect(Object.fromEntries(root.props)).toEqual({ '--canvas': '#eee', '--dew': '#123456', '--player-bar-h': '72px' });
    expect(root.dataset['themed']).toBe('');

    applyThemeTokens(null, root as unknown as HTMLElement);
    cacheThemeTokens(null);
    expect(Object.fromEntries(root.props)).toEqual({ '--player-bar-h': '72px' });
    expect(root.dataset['themed']).toBeUndefined();
    expect(localStorage.getItem(THEME_TOKENS_KEY)).toBeNull();
  });
});
