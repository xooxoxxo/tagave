/**
 * Settings › Tag preferences (M2, spec §12.8 + M2 plan Q5): the library
 * master switch for writing tags to files, and the default write policy new
 * plans start from. Writes also need a writable scan root (Settings › Music
 * folders);
 * the worker re-checks both per file when a plan applies.
 */
import { useEffect, useState } from 'react';
import { docsUrl } from '../utils/docs';
import type { TagPolicies } from '@tagave/shared';
import { useCurrentLibrary } from '../hooks';
import { useLibrarySettings, useUpdateLibrarySettings, useScanRoots } from '../hooks/useLibrary';
import { Button, LinkButton, confirmDialog } from '../components/ui';
import styles from './SettingsTagWritesPage.module.css';

type Preset = TagPolicies['preset'];

const PRESETS: Array<{ id: Preset; title: string }> = [
  { id: 'canonical_ids_and_fill', title: 'Canonical IDs + fill (recommended)' },
  { id: 'fill_blanks_only', title: 'Fill blanks only' },
  { id: 'overwrite_all', title: 'Overwrite all' },
  { id: 'custom', title: 'Custom' },
];

const DEFAULT_POLICY: TagPolicies = { preset: 'canonical_ids_and_fill', id3Version: '2.4', multiValueSeparator: '; ' };

const samePolicy = (a: TagPolicies, b: TagPolicies) =>
  a.preset === b.preset && a.id3Version === b.id3Version && a.multiValueSeparator === b.multiValueSeparator;

/**
 * Content component for embedding in SettingsPage
 */
export function SettingsTagWritesContent() {
  return <SettingsTagWritesContentInner />;
}

/**
 * Full page component (for backward compatibility / direct navigation)
 */
export function SettingsTagWritesPage() {
  return <SettingsTagWritesContentInner />;
}

function SettingsTagWritesContentInner() {
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
      const ok = await confirmDialog({
        title: 'Enable tag writes for this library?',
        message: 'Nothing is written until you apply a tag plan.',
        confirmLabel: 'Turn on',
      });
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
    <div className={styles.content}>
      <div className={styles.section}>
        <h2 className={styles.sectionTitle}>Tag preferences</h2>

        <div className={styles.statusList}>
          <div className={styles.statusRow}>
            <span className={`${styles.statusDot} ${enabled ? styles.on : styles.off}`} />
            <div className={styles.statusText}>
              <strong>Tag writes</strong>
              <span>{enabled ? 'On' : 'Off'}</span>
            </div>
            <Button
              variant={enabled ? 'secondary' : 'primary'}
              onClick={toggleWrites}
              disabled={toggling || update.isPending}
            >
              {toggling ? 'Saving...' : enabled ? 'Turn off' : 'Turn on'}
            </Button>
          </div>

          <div className={styles.statusRow}>
            <span className={`${styles.statusDot} ${writableRoots.length ? styles.on : styles.off}`} />
            <div className={styles.statusText}>
              <strong>Writable folders</strong>
              <span>
                {roots.isLoading
                  ? 'Checking…'
                  : writableRoots.length === 0
                    ? 'None'
                    : writableRoots.map((r) => r.path).join(', ')}
              </span>
            </div>
            <LinkButton variant="secondary" size="sm" to="/settings/library" aria-label="Edit music folders">
              Edit
            </LinkButton>
          </div>
        </div>

        {enabled && writableRoots.length === 0 && (
          <p className={styles.warning}>No folder allows writes</p>
        )}
      </div>

      <div className={styles.section}>
        <h2 className={styles.sectionTitle}>Default write policy</h2>

        <div className={styles.fieldGroup}>
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
                </span>
              </label>
            ))}
          </div>
        </div>

        <div className={styles.fieldGroup}>
          <label htmlFor="id3Version" className={styles.label}>
            MP3 tags
          </label>

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
              Separator
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
          <Button type="button" onClick={savePolicy} disabled={!policyChanged || update.isPending}>
            {update.isPending && !toggling ? 'Saving...' : 'Save'}
          </Button>
          <Button variant="quiet" type="button" onClick={() => setPolicy(saved)} disabled={!policyChanged}>
            Reset
          </Button>
          {update.isSuccess && !policyChanged && <span className={styles.success}>Saved</span>}
          {errorText && <span className={styles.error}>{errorText}</span>}
        </div>
      </div>

      <a className={styles.howTo} href={docsUrl('tag-correction.md')} target="_blank" rel="noreferrer">How to</a>
    </div>
  );
}
