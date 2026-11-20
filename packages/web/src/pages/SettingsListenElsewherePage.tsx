/**
 * Your settings › Listen elsewhere (each person's own): the
 * streaming platforms the Listen control offers you, in this order, and
 * which one "Play on …" opens on missing albums and Missing playlist rows
 * (one of yours, or none). None until you tick one. A tick and the Missing
 * albums choice each save when changed (the save model), the outcome in
 * the head of the group that changed. ListenElsewhereView is the section
 * alone, driven by props (stories, tests); SettingsListenElsewhereContent
 * connects it.
 */
import { useState } from 'react';
import { LISTEN_PLATFORMS, LISTEN_PLATFORM_NAMES, type ListenPlatform } from '@tagave/shared';
import { SaveStatus, Select, SettingsGroup, SettingsRow, useSaveFlash, type SaveState } from '../components/ui';
import { useListenPrefs, useSetListenPrefs } from '../hooks/useListenLinks';
import type { ApiError } from '../services/api';
import styles from './SettingsListenElsewherePage.module.css';

/** Which group the last change was in: its head shows the save. */
export type ListenElsewhereGroup = 'platforms' | 'primary';

export interface ListenElsewhereViewProps {
  platforms: readonly ListenPlatform[];
  /** "Play on …": one of `platforms`, or null */
  primary?: ListenPlatform | null;
  saving?: boolean;
  /** the last save was kept */
  saved?: boolean;
  /** the last save failed: the API's detail, or '' for none */
  error?: string | null;
  /** where the last change was (default Platforms) */
  changed?: ListenElsewhereGroup;
  onChange: (platforms: ListenPlatform[]) => void;
  onPrimary?: (primary: ListenPlatform | null) => void;
}

export function ListenElsewhereView({ platforms, primary = null, saving = false, saved = false, error = null, changed = 'platforms', onChange, onPrimary }: ListenElsewhereViewProps) {
  const toggle = (p: ListenPlatform, on: boolean) =>
    onChange(LISTEN_PLATFORMS.filter((x) => (x === p ? on : platforms.includes(x))));
  const state: SaveState = error != null ? 'failed' : saved ? 'saved' : null;
  const status = <SaveStatus state={state} detail={error || null} />;
  const showPrimary = !!onPrimary && platforms.length > 0;
  return (
    <div className={styles.page} aria-busy={saving || undefined}>
      <SettingsGroup title="Platforms" help="The Listen control offers these, in this order" status={changed === 'platforms' || !showPrimary ? status : null}>
        {LISTEN_PLATFORMS.map((p) => (
          <SettingsRow key={p} label={LISTEN_PLATFORM_NAMES[p]}>
            <input type="checkbox" className={styles.check} checked={platforms.includes(p)} onChange={(e) => toggle(p, e.target.checked)} />
          </SettingsRow>
        ))}
      </SettingsGroup>
      {showPrimary && (
        <SettingsGroup title="Missing albums" help="Play on opens this platform for an album you do not have" status={changed === 'primary' ? status : null}>
          <SettingsRow label="Play on">
            <Select dense value={primary ?? ''} onChange={(e) => onPrimary((e.target.value || null) as ListenPlatform | null)}>
              <option value="">None</option>
              {platforms.map((p) => <option key={p} value={p}>{LISTEN_PLATFORM_NAMES[p]}</option>)}
            </Select>
          </SettingsRow>
        </SettingsGroup>
      )}
    </div>
  );
}

export function SettingsListenElsewhereContent() {
  const prefs = useListenPrefs();
  const save = useSetListenPrefs();
  const flash = useSaveFlash();
  // the ticks show at once; the server's answer replaces them
  const [draft, setDraft] = useState<{ platforms: ListenPlatform[]; primary: ListenPlatform | null } | null>(null);
  const [changed, setChanged] = useState<ListenElsewhereGroup>('platforms');
  if (!prefs.data) return null;
  const current = draft ?? { platforms: prefs.data.platforms, primary: prefs.data.primary };
  const send = (group: ListenElsewhereGroup, next: { platforms: ListenPlatform[]; primary: ListenPlatform | null }) => {
    setDraft(next);
    setChanged(group);
    flash.clear();
    save.mutate(next, {
      onSuccess: () => flash.saved(),
      onError: (err) => { const e = err as Partial<ApiError> | null; flash.failed(e?.detail ?? null); },
      onSettled: () => setDraft(null),
    });
  };
  return (
    <ListenElsewhereView
      platforms={current.platforms}
      primary={current.primary}
      saving={save.isPending}
      saved={flash.state === 'saved'}
      error={flash.state === 'failed' ? flash.detail ?? '' : null}
      changed={changed}
      // a platform taken off the list is no longer the primary one
      onChange={(platforms) => send('platforms', { platforms, primary: current.primary && platforms.includes(current.primary) ? current.primary : null })}
      onPrimary={(primary) => send('primary', { platforms: current.platforms, primary })}
    />
  );
}
