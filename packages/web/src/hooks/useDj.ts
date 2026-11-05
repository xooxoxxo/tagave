/**
 * The DJ module's Simple mode in React: each person's settings (kept in this
 * browser: player/djSettings.ts) and the bridge that tells the engine
 * whether the module is on and who listens here.
 */
import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { DJ_DEFAULTS, type DjSettings } from '@tagave/shared';
import { djAvailableHere, getDjSettings, setDjModuleOn, setDjPerson, setDjSettings, subscribeDj } from '../player/djSettings';
import { useModuleOn } from './useFacets';
import { useMe } from './useAuth';

export function useDjSettings(): [DjSettings, (patch: Partial<DjSettings>) => void] {
  const settings = useSyncExternalStore(subscribeDj, getDjSettings, () => DJ_DEFAULTS);
  const update = useCallback((patch: Partial<DjSettings>) => setDjSettings(patch), []);
  return [settings, update];
}

/** Whether this device can mix at all (not an iOS home-screen app). */
export function useDjAvailableHere(): boolean {
  return djAvailableHere();
}

/** Mounted once with the player: the module's switch and the signed-in person reach the engine. */
export function useDjBridge(): void {
  const on = useModuleOn('dj');
  const { data: me } = useMe();
  const id = me?.id ?? null;
  useEffect(() => { setDjPerson(id); }, [id]);
  useEffect(() => { setDjModuleOn(on === true); }, [on]);
}
