/**
 * The DJ module's Simple mode in React: each person's settings and the
 * bridge that tells the engine whether the module is on, who listens here
 * and what they chose. The settings are the person's own on the server
 * (GET/PUT /me/prefs { dj }, user_prefs 0087), so they follow them between
 * devices; this browser keeps a copy (player/djSettings.ts) for the engine
 * to read before the server answers.
 */
import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { DJ_DEFAULTS, type DjSimpleSettings, type UserPrefsView } from '@tagave/shared';
import { api } from '../services/api';
import { djAvailableHere, getDjSettings, setDjModuleOn, setDjPerson, setDjSettings, subscribeDj } from '../player/djSettings';
import { userPrefsKey } from '../themes/ThemeColours';
import { useModuleOn } from './useFacets';
import { isCasting, useCastStore } from '../player/cast';
import { usePlayerStore } from '../player/engine';
import { useMe } from './useAuth';

const SAVE_MS = 300;
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let saving = 0;
/** A change made here is still on its way to the server. */
const unsaved = () => saveTimer !== null || saving > 0;

function save(client: QueryClient) {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    saving += 1;
    const dj = getDjSettings();
    void api.put<UserPrefsView>('/me/prefs', { dj })
      .then((view) => { client.setQueryData<UserPrefsView>(userPrefsKey, (prev) => ({ theme: view?.theme ?? prev?.theme ?? null, dj: getDjSettings() })); })
      .catch(() => undefined)
      .finally(() => { saving -= 1; });
  }, SAVE_MS);
}

export function useDjSettings(): [DjSimpleSettings, (patch: Partial<DjSimpleSettings>) => void] {
  const settings = useSyncExternalStore(subscribeDj, getDjSettings, () => DJ_DEFAULTS);
  const client = useQueryClient();
  const update = useCallback((patch: Partial<DjSimpleSettings>) => {
    setDjSettings(patch);
    save(client);
  }, [client]);
  return [settings, update];
}

/** Whether this device can mix at all (not an iOS home-screen app). */
export function useDjAvailableHere(): boolean {
  return djAvailableHere();
}

/** Mounted once with the player: the module's switch, the person and their Simple mode reach the engine. */
export function useDjBridge(): void {
  const on = useModuleOn('dj');
  const { data: me } = useMe();
  const id = me?.id ?? null;
  const prefs = useQuery({ queryKey: userPrefsKey, queryFn: () => api.get<UserPrefsView>('/me/prefs'), staleTime: 60_000, retry: false, enabled: !!id && on === true });
  useEffect(() => { setDjPerson(id); }, [id]);
  useEffect(() => { setDjModuleOn(on === true); }, [on]);
  // the server's copy wins (the person changed it on another device), unless a change made here is on its way
  const server = prefs.data;
  useEffect(() => {
    if (!server || unsaved()) return;
    setDjSettings(server.dj ?? DJ_DEFAULTS);
  }, [server]);
}

/** Whether the DJ view can run here now, or why not. */
export type DjViewAvailability = 'ok' | 'unknown' | 'off' | 'device' | 'casting' | 'elsewhere';

/** The rule, alone (tests). */
export function djViewAvailability(p: { moduleOn: boolean | null; availableHere: boolean; casting: boolean; remoteDeviceId: string | null }): DjViewAvailability {
  if (p.moduleOn === null) return 'unknown';
  if (!p.moduleOn) return 'off';
  if (!p.availableHere) return 'device';
  if (p.casting) return 'casting';
  if (p.remoteDeviceId) return 'elsewhere';
  return 'ok';
}

/**
 * The DJ view (Advanced mode) runs while the module is on, this device can
 * run the graph (not an iOS home-screen app), nothing is casting and no
 * other device of the person's plays.
 */
export function useDjViewAvailability(): DjViewAvailability {
  const moduleOn = useModuleOn('dj');
  const casting = isCasting(useCastStore());
  const remoteDeviceId = usePlayerStore((s) => s.remoteDeviceId);
  return djViewAvailability({ moduleOn, availableHere: djAvailableHere(), casting, remoteDeviceId });
}

/** What the /dj route says when the view cannot run here. */
export function djUnavailableText(a: DjViewAvailability): string | null {
  switch (a) {
    case 'off': return 'Off';
    case 'device': case 'elsewhere': return 'Not on this device';
    case 'casting': return 'Casting';
    default: return null;
  }
}
