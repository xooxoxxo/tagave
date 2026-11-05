/**
 * Each person's DJ settings (Settings › Modules › DJ), kept in the browser
 * that plays, one entry per person who signs in here; every access guarded,
 * so with storage blocked a choice still applies for this page view. Another
 * device that plays the queue applies its own. The engine and the settings
 * page read the same snapshot, and whether the module is on (GET /facets).
 */
import { DJ_DEFAULTS, DJ_SETTINGS_STORAGE_KEY, type DjSettings } from '@tagave/shared';
import { parseDjSettings } from './djPlan';
import { isIosHomeScreenApp } from './platform';

const listeners = new Set<() => void>();
let person = '';
let current: DjSettings | undefined;
let moduleOn = false;

function readAll(): Record<string, unknown> {
  try {
    const raw = globalThis.localStorage?.getItem(DJ_SETTINGS_STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

const notify = () => listeners.forEach((l) => l());

export function getDjSettings(): DjSettings {
  current ??= parseDjSettings(readAll()[person] ?? DJ_DEFAULTS);
  return current;
}

export function setDjSettings(patch: Partial<DjSettings>): void {
  const next = parseDjSettings({ ...getDjSettings(), ...patch });
  try {
    globalThis.localStorage?.setItem(DJ_SETTINGS_STORAGE_KEY, JSON.stringify({ ...readAll(), [person]: next }));
  } catch {
    // storage blocked: the choice applies for this page view
  }
  current = next;
  notify();
}

/** The person signed in here (their settings apply); '' before anyone is known. */
export function setDjPerson(id: string | null | undefined): void {
  const next = id ?? '';
  if (next === person) return;
  person = next;
  current = undefined;
  notify();
}

/** Whether the module is on for this install (Settings › Modules). */
export function setDjModuleOn(on: boolean): void {
  if (on === moduleOn) return;
  moduleOn = on;
  notify();
}

export function djModuleOn(): boolean {
  return moduleOn;
}

/** DJ can run in this browser: Web Audio exists, and it is not an iOS home-screen app. */
export function djAvailableHere(): boolean {
  return typeof globalThis.AudioContext !== 'undefined' && !isIosHomeScreenApp();
}

/** The module is on, the person's crossfade is not Off, and this device can mix. */
export function djWanted(): boolean {
  return moduleOn && getDjSettings().crossfade !== 'off' && djAvailableHere();
}

export function subscribeDj(listener: () => void): () => void {
  listeners.add(listener);
  const onStorage = (e: StorageEvent) => {
    if (e.key !== DJ_SETTINGS_STORAGE_KEY) return;
    current = undefined;
    listener();
  };
  globalThis.addEventListener?.('storage', onStorage);
  return () => {
    listeners.delete(listener);
    globalThis.removeEventListener?.('storage', onStorage);
  };
}
