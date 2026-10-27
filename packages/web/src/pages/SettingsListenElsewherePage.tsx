/**
 * Settings › Listen elsewhere (your account; the listen-links module): the
 * streaming platforms the Listen control offers you, in this order. None
 * until you tick one. ListenElsewhereView is the section alone, driven by
 * props (stories, tests); SettingsListenElsewhereContent connects it.
 */
import { useState } from 'react';
import { LISTEN_PLATFORMS, LISTEN_PLATFORM_NAMES, type ListenPlatform } from '@tagave/shared';
import { Banner } from '../components/ui';
import { useListenPrefs, useSetListenPrefs } from '../hooks/useListenLinks';
import styles from './SettingsListenElsewherePage.module.css';

export interface ListenElsewhereViewProps {
  platforms: readonly ListenPlatform[];
  saving?: boolean;
  error?: string | null;
  onChange: (platforms: ListenPlatform[]) => void;
}

export function ListenElsewhereView({ platforms, saving = false, error = null, onChange }: ListenElsewhereViewProps) {
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
  const [draft, setDraft] = useState<ListenPlatform[] | null>(null);
  if (!prefs.data) return <h2>Listen elsewhere</h2>;
  return (
    <ListenElsewhereView
      platforms={draft ?? prefs.data.platforms}
      saving={save.isPending}
      error={save.isError ? 'Couldn’t save. Try again.' : null}
      onChange={(next) => {
        setDraft(next);
        save.mutate(next, { onSettled: () => setDraft(null) });
      }}
    />
  );
}
