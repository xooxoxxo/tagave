/** The DJ guards and the per-person copy the engine reads (djSettings.ts, platform.ts). */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DJ_DEFAULTS, DJ_SETTINGS_STORAGE_KEY } from '@tagave/shared';
import { isIosHomeScreenApp } from './platform';

const IPHONE = { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)', platform: 'iPhone', maxTouchPoints: 5 };
const IPAD_AS_MAC = { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', platform: 'MacIntel', maxTouchPoints: 5 };
const MAC = { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', platform: 'MacIntel', maxTouchPoints: 0 };
const ANDROID = { userAgent: 'Mozilla/5.0 (Linux; Android 15; Pixel 9) Chrome/140.0.0.0 Mobile Safari/537.36', platform: 'Linux armv8l', maxTouchPoints: 5 };

const store = new Map<string, string>();
const localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); }, removeItem: (k: string) => { store.delete(k); }, clear: () => store.clear() };
beforeEach(() => { vi.stubGlobal('localStorage', localStorage); });
afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); store.clear(); });

describe('isIosHomeScreenApp', () => {
  it('an iPhone or iPad opened from the home screen', () => {
    expect(isIosHomeScreenApp({ ...IPHONE, standalone: true }, () => false)).toBe(true);
    expect(isIosHomeScreenApp(IPHONE, (q) => q === '(display-mode: standalone)')).toBe(true);
    expect(isIosHomeScreenApp(IPAD_AS_MAC, (q) => q === '(display-mode: standalone)')).toBe(true);
  });
  it('not Safari in a tab, nor an installed app elsewhere', () => {
    expect(isIosHomeScreenApp(IPHONE, () => false)).toBe(false);
    expect(isIosHomeScreenApp(MAC, () => true)).toBe(false);
    expect(isIosHomeScreenApp(ANDROID, () => true)).toBe(false);
  });
});

describe('djSettings', () => {
  const load = () => import('./djSettings');

  it('is wanted only with the module on, a crossfade, and a device that can mix', async () => {
    vi.stubGlobal('AudioContext', class {});
    const s = await load();
    expect(s.djWanted()).toBe(false);
    s.setDjModuleOn(true);
    expect(s.djWanted()).toBe(false);
    s.setDjSettings({ crossfade: 'fixed' });
    expect(s.djWanted()).toBe(true);
    vi.stubGlobal('AudioContext', undefined);
    expect(s.djWanted()).toBe(false);
  });

  it('never in an iOS home-screen app', async () => {
    vi.stubGlobal('AudioContext', class {});
    vi.stubGlobal('navigator', { ...IPHONE, standalone: true });
    const s = await load();
    s.setDjModuleOn(true);
    s.setDjSettings({ crossfade: 'auto' });
    expect(s.djAvailableHere()).toBe(false);
    expect(s.djWanted()).toBe(false);
  });

  it('keeps one copy per person in this browser', async () => {
    const s = await load();
    s.setDjPerson('anna');
    s.setDjSettings({ crossfade: 'auto', lengthSec: 9 });
    s.setDjPerson('ben');
    expect(s.getDjSettings()).toEqual(DJ_DEFAULTS);
    s.setDjPerson('anna');
    expect(s.getDjSettings()).toMatchObject({ crossfade: 'auto', lengthSec: 9 });
    expect(JSON.parse(localStorage.getItem(DJ_SETTINGS_STORAGE_KEY)!)).toHaveProperty('anna');
  });

  it('tells its listeners', async () => {
    const s = await load();
    const heard = vi.fn();
    const off = s.subscribeDj(heard);
    s.setDjSettings({ beatAligned: true });
    s.setDjModuleOn(true);
    off();
    s.setDjSettings({ beatAligned: false });
    expect(heard).toHaveBeenCalledTimes(2);
  });
});
