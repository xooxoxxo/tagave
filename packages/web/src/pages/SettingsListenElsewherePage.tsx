/**
 * Settings › Listen elsewhere (your account; the listen-links module): the
 * streaming platforms the Listen control offers you, in this order, and
 * which one "Play on …" opens on missing albums and Missing playlist rows
 * (one of yours, or none). None until you tick one. ListenElsewhereView is
 * the section alone, driven by props (stories, tests);
 * SettingsListenElsewhereContent connects it.
 */
import { useState } from 'react';
import { LISTEN_PLATFORMS, LISTEN_PLATFORM_NAMES, type ListenPlatform } from '@tagave/shared';
import { Banner, Select } from '../components/ui';
import { useListenPrefs, useSetListenPrefs } from '../hooks/useListenLinks';
import styles from './SettingsListenElsewherePage.module.css';

export interface ListenElsewhereViewProps {
  platforms: readonly ListenPlatform[];
  /** "Play on …": one of `platforms`, or null */
  primary?: ListenPlatform | null;
  saving?: boolean;
  error?: string | null;
  onChange: (platforms: ListenPlatform[]) => void;
  onPrimary?: (primary: ListenPlatform | null) => void;
}

export function ListenElsewhereView({ platforms, primary = null, saving = false, error = null, onChange, onPrimary }: ListenElsewhereViewProps) {
  const toggle = (p: ListenPlatform, on: boolean) =>
    onChange(LISTEN_PLATFORMS.filter((x) => (x === p ? on : platforms.includes(x))));
  return (
    <>
      <h2>Listen elsewhere</h2>
      <fieldset className={styles.list} aria-busy={saving || undefined}>
        <legend className={styles.legend}>Platforms</legend>
        {LISTEN_PLATFORMS.map((p) => (
          <label key={p} className={styles.option}>
            <input type="checkbox" checked={platforms.includes(p)} onChange={(e) => toggle(p, e.target.checked)} />
            <span>{LISTEN_PLATFORM_NAMES[p]}</span>
          </label>
        ))}
      </fieldset>
      {onPrimary && platforms.length > 0 && (
        <label className={styles.primary}>
          <span className={styles.legend}>Missing albums</span>
          <Select value={primary ?? ''} onChange={(e) => onPrimary((e.target.value || null) as ListenPlatform | null)}>
            <option value="">None</option>
            {platforms.map((p) => <option key={p} value={p}>{LISTEN_PLATFORM_NAMES[p]}</option>)}
          </Select>
        </label>
      )}
      {error && <p className={styles.error} role="alert">{error}</p>}
    </>
  );
}

/** Listen elsewhere is off (Settings › Modules): the section says so. */
export function ListenElsewhereOff({ owner }: { owner: boolean }) {
  return (
    <>
      <h2>Listen elsewhere</h2>
      <Banner tone="info">Listen elsewhere is turned off.{owner ? ' Turn it on in Settings › Modules.' : ''}</Banner>
    </>
  );
}

export function SettingsListenElsewhereContent() {
  const prefs = useListenPrefs();
  const save = useSetListenPrefs();
  // the ticks show at once; the server's answer replaces them
  const [draft, setDraft] = useState<{ platforms: ListenPlatform[]; primary: ListenPlatform | null } | null>(null);
  if (!prefs.data) return <h2>Listen elsewhere</h2>;
  const current = draft ?? { platforms: prefs.data.platforms, primary: prefs.data.primary };
  const send = (next: { platforms: ListenPlatform[]; primary: ListenPlatform | null }) => {
    setDraft(next);
    save.mutate(next, { onSettled: () => setDraft(null) });
  };
  return (
    <ListenElsewhereView
      platforms={current.platforms}
      primary={current.primary}
      saving={save.isPending}
      error={save.isError ? 'Couldn’t save. Try again.' : null}
      // a platform taken off the list is no longer the primary one
      onChange={(platforms) => send({ platforms, primary: current.primary && platforms.includes(current.primary) ? current.primary : null })}
      onPrimary={(primary) => send({ platforms: current.platforms, primary })}
    />
  );
}
