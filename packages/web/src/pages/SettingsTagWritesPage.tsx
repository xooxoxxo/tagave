/**
 * Settings › Tag writes (M2, spec §12.8 + M2 plan Q5): the library master
 * switch for writing tags to files, and the default write policy new plans
 * start from. Writes also need a writable scan root (Settings › Scan roots);
 * the worker re-checks both per file when a plan applies.
 */
import { useEffect, useState } from 'react';
import { Link } from '@tanstack/react-router';
import type { TagPolicies } from '@liner/shared';
import { useCurrentLibrary } from '../hooks';
import { useLibrarySettings, useUpdateLibrarySettings, useScanRoots } from '../hooks/useLibrary';
import { SettingsNav } from '../components/SettingsNav';
import styles from './SettingsTagWritesPage.module.css';

type Preset = TagPolicies['preset'];

const PRESETS: Array<{ id: Preset; title: string; hint: string }> = [
  {
    id: 'canonical_ids_and_fill',
    title: 'Canonical IDs + fill (recommended)',
    hint: 'Overwrite MusicBrainz/Discogs IDs, album, album artist, dates, track and disc numbers; fill blank title, artist and genre; never touch comments, ratings, lyrics or artwork.',
  },
  {
    id: 'fill_blanks_only',
    title: 'Fill blanks only',
    hint: 'Only fields that are empty in the file get a value. Nothing that exists changes.',
  },
  {
    id: 'overwrite_all',
    title: 'Overwrite all',
    hint: 'Every mapped field takes the canonical value. Locked fields still win.',
  },
  {
    id: 'custom',
    title: 'Custom',
    hint: 'Start from the recommended preset and set per-field rules in the plan wizard.',
  },
];

const DEFAULT_POLICY: TagPolicies = { preset: 'canonical_ids_and_fill', id3Version: '2.4', multiValueSeparator: '; ' };

const samePolicy = (a: TagPolicies, b: TagPolicies) =>
  a.preset === b.preset && a.id3Version === b.id3Version && a.multiValueSeparator === b.multiValueSeparator;

export function SettingsTagWritesPage() {
  const { libraryId } = useCurrentLibrary();
  const settings = useLibrarySettings(libraryId);
  const roots = useScanRoots(libraryId);
  const update = useUpdateLibrarySettings(libraryId);

  const [policy, setPolicy] = useState<TagPolicies>(DEFAULT_POLICY);
  const [saved, setSaved] = useState<TagPolicies>(DEFAULT_POLICY);
  const [toggling, setToggling] = useState(false);

  useEffect(() => {
    if (!settings.data) return;
    const stored = settings.data.tagPolicy ?? DEFAULT_POLICY;
    setPolicy(stored);
    setSaved(stored);
  }, [settings.data]);

  const enabled = settings.data?.tagWritesEnabled === true;
  const rootList = roots.data ?? [];
  const writableRoots = rootList.filter((r) => r.writable);
  const policyChanged = !samePolicy(policy, saved);

  const toggleWrites = async () => {
    if (!enabled) {
      const ok = window.confirm(
        'Enable tag writes for this library? Nothing is written until you apply a tag plan; every write is journaled, verified against the audio-stream hash and revertible.',
      );
      if (!ok) return;
    }
    setToggling(true);
    try {
      await update.mutateAsync({ tagWritesEnabled: !enabled });
    } finally {
      setToggling(false);
    }
  };

  const savePolicy = async () => {
    const next: TagPolicies = {
      preset: policy.preset,
      id3Version: policy.id3Version,
      multiValueSeparator: policy.multiValueSeparator,
    };
    await update.mutateAsync({ tagPolicy: next });
    setSaved(next);
  };

  if (settings.isLoading) return <div className={styles.container}>Loading settings...</div>;

  const errorText = update.isError
    ? ((update.error as { detail?: string; message?: string })?.detail ?? (update.error as Error)?.message ?? 'Failed to save')
    : null;

  return (
    <div className={styles.container}>
      <h1 className={styles.title}>Settings</h1>
      <SettingsNav />

      <div className={styles.section}>
        <h2 className={styles.sectionTitle}>Tag writes</h2>
        <p className={styles.pageHint}>
          Liner never writes to your files unless this switch is on <em>and</em> the file sits under a scan root marked
          writable. Writes happen only through tag plans: preview the diff, apply, and revert from the album History tab
          if needed. Each file is written to a temp copy, re-read, checked against its audio-stream hash and renamed
          into place. Artwork is never modified; APE and WavPack are read-only.
        </p>

        <div className={styles.statusList}>
          <div className={styles.statusRow}>
            <span className={`${styles.statusDot} ${enabled ? styles.on : styles.off}`} />
            <div className={styles.statusText}>
              <strong>Library switch</strong>
              <span>{enabled ? 'Tag writes enabled' : 'Tag writes disabled (default)'}</span>
            </div>
            <button
              type="button"
              className={enabled ? styles.resetButton : styles.button}
              onClick={toggleWrites}
              disabled={toggling || update.isPending}
            >
              {toggling ? 'Saving...' : enabled ? 'Disable tag writes' : 'Enable tag writes'}
            </button>
          </div>

          <div className={styles.statusRow}>
            <span className={`${styles.statusDot} ${writableRoots.length ? styles.on : styles.off}`} />
            <div className={styles.statusText}>
              <strong>Writable scan roots</strong>
              <span>
                {roots.isLoading
                  ? 'Checking…'
                  : rootList.length === 0
                    ? 'No scan roots configured'
                    : writableRoots.length === 0
                      ? `None of ${rootList.length} root(s) allow writes`
                      : writableRoots.map((r) => r.path).join(', ')}
              </span>
            </div>
            <Link to="/settings/scan-roots" className={styles.linkButton}>
              Scan roots
            </Link>
          </div>
        </div>

        {enabled && writableRoots.length === 0 && (
          <p className={styles.warning}>
            The switch is on but no root allows writes yet — plans will preview but refuse to apply until you press
            “Allow tag writes” on a root under Scan roots.
          </p>
        )}
      </div>

      <div className={styles.section}>
        <h2 className={styles.sectionTitle}>Default write policy</h2>
        <p className={styles.hint}>
          New plans start from this policy; each plan can still change it before preview. Recommended defaults follow
          the M2 plan: canonical IDs + fill, ID3v2.4 UTF-8 for MP3s.
        </p>

        <div className={styles.fieldGroup}>
          <label className={styles.label}>Preset</label>
          <div className={styles.radioGroup}>
            {PRESETS.map((p) => (
              <label key={p.id} className={`${styles.radioLabel} ${policy.preset === p.id ? styles.radioActive : ''}`}>
                <input
                  type="radio"
                  name="preset"
                  className={styles.radio}
                  checked={policy.preset === p.id}
                  onChange={() => setPolicy({ ...policy, preset: p.id })}
                />
                <span className={styles.radioText}>
                  <strong>{p.title}</strong>
                  <span>{p.hint}</span>
                </span>
              </label>
            ))}
          </div>
        </div>

        <div className={styles.fieldGroup}>
          <label htmlFor="id3Version" className={styles.label}>
            ID3 version for MP3
          </label>
          <p className={styles.hint}>
            v2.4 stores UTF-8 and real multi-value frames. Pick v2.3 only for players that cannot read v2.4; values are
            then joined with the separator below.
          </p>
          <select
            id="id3Version"
            className={styles.select}
            value={policy.id3Version}
            onChange={(e) => setPolicy({ ...policy, id3Version: e.target.value as TagPolicies['id3Version'] })}
          >
            <option value="2.4">ID3v2.4 (UTF-8, recommended)</option>
            <option value="2.3">ID3v2.3 (legacy players)</option>
          </select>
        </div>

        {policy.id3Version === '2.3' && (
          <div className={styles.fieldGroup}>
            <label htmlFor="separator" className={styles.label}>
              Multi-value separator (v2.3 only)
            </label>
            <input
              id="separator"
              className={styles.input}
              value={policy.multiValueSeparator}
              onChange={(e) => setPolicy({ ...policy, multiValueSeparator: e.target.value })}
            />
          </div>
        )}

        <div className={styles.actions}>
          <button type="button" onClick={savePolicy} disabled={!policyChanged || update.isPending} className={styles.button}>
            {update.isPending && !toggling ? 'Saving...' : 'Save policy'}
          </button>
          <button type="button" onClick={() => setPolicy(saved)} disabled={!policyChanged} className={styles.resetButton}>
            Reset
          </button>
          {update.isSuccess && !policyChanged && <span className={styles.success}>Saved</span>}
          {errorText && <span className={styles.error}>{errorText}</span>}
        </div>
      </div>

      <div className={styles.section}>
        <h2 className={styles.sectionTitle}>First run, safely</h2>
        <ol className={styles.steps}>
          <li>Allow tag writes on your music root under <Link to="/settings/scan-roots">Scan roots</Link>.</li>
          <li>Enable the library switch above.</li>
          <li>
            Open <Link to="/plans">Plans</Link>, create a plan for one artist or a handful of albums, and preview it.
          </li>
          <li>Apply, check a file in your player, then revert from the album’s History tab and apply again.</li>
          <li>Only then widen the scope.</li>
        </ol>
      </div>
    </div>
  );
}
