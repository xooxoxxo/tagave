/**
 * The colour theme, the controller (mounted once in Layout, before
 * AdaptiveColour): reads the person's choice from the server (it follows
 * them between devices), writes a generated theme's tokens on <html> for the
 * mode in effect, and caches both modes' tokens so the next load paints
 * themed from the first frame (index.html). Adaptive and Classic take every
 * token off: the brand tokens stay, and Adaptive's cover colours are
 * AdaptiveColour's.
 */
import { useCallback, useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { ThemeChoice, UserPrefsView } from '@tagave/shared';
import { api } from '../services/api';
import { useResolvedDark } from '../adaptive/AdaptiveColour';
import { applyThemeTokens, cacheThemeTokens, defaultChoice, setThemeChoice, useThemeChoiceValue } from './themeChoice';

export const userPrefsKey = ['me', 'prefs'] as const;

type Engine = typeof import('./engine');
let engine: Promise<Engine> | null = null;
const loadEngine = () => (engine ??= import('./engine'));

const SAVE_MS = 400;
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let saving = 0;
let lastSent: ThemeChoice | null = null;
/** A change made here is still on its way to the server. */
const unsaved = () => saveTimer !== null || saving > 0;

/** The person's theme plus a setter: it applies at once, and is saved to the server shortly after (the editor's slider sends one save, not one per step). */
export function useThemeChoice(): [ThemeChoice, (next: ThemeChoice) => void] {
  const choice = useThemeChoiceValue();
  const client = useQueryClient();
  const set = useCallback((next: ThemeChoice) => {
    setThemeChoice(next);
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = null;
      saving += 1;
      lastSent = next;
      void api.put<UserPrefsView>('/me/prefs', { theme: next })
        .catch(() => undefined)
        .finally(() => {
          saving -= 1;
          // the last save in: the server's copy is what this browser shows
          if (!unsaved() && lastSent) client.setQueryData<UserPrefsView>(userPrefsKey, { theme: lastSent });
        });
    }, SAVE_MS);
  }, [client]);
  return [choice, set];
}

export function ThemeColours() {
  const choice = useThemeChoiceValue();
  const dark = useResolvedDark();
  const prefs = useQuery({ queryKey: userPrefsKey, queryFn: () => api.get<UserPrefsView>('/me/prefs'), staleTime: 60_000, retry: false });

  // the server's copy wins (another device, another person on this browser),
  // unless a change made here is still on its way there
  const server = prefs.data;
  useEffect(() => {
    if (!server || unsaved()) return;
    setThemeChoice(server.theme ?? defaultChoice());
  }, [server]);

  const key = JSON.stringify(choice);
  useEffect(() => {
    if (choice.theme === 'adaptive' || choice.theme === 'classic') {
      applyThemeTokens(null);
      cacheThemeTokens(null);
      return;
    }
    let live = true;
    void loadEngine().then((m) => {
      if (!live) return;
      const spec = m.generatedSpec(choice);
      if (!spec) return;
      const both = m.tokensFor(spec);
      applyThemeTokens(dark ? both.dark : both.light);
      cacheThemeTokens(both);
    });
    return () => { live = false; };
  }, [key, dark]); // eslint-disable-line react-hooks/exhaustive-deps

  return null;
}
