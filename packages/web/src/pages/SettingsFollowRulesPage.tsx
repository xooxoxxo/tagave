/**
 * Settings › Follow Rules page (spec XO-301 GAP-2): library-level follow rules for artist discographies
 */
import { useEffect, useState } from 'react';
import { useCurrentLibrary } from '../hooks';
import { useFollowRules, usePatchFollowRules, type FollowRules } from '../hooks/useArtists';
import styles from './SettingsFollowRulesPage.module.css';

const PRIMARY_TYPES = ['Album', 'EP', 'Single'];
const SECONDARY_TYPES = ['Compilation', 'Live', 'Remix', 'DJ-mix', 'Mixtape/Street', 'Demo', 'Soundtrack'];

/**
 * Content component for embedding in SettingsPage
 */
export function SettingsFollowRulesContent() {
  return <SettingsFollowRulesContentInner />;
}

/**
 * Full page component (for backward compatibility / direct navigation)
 */
export function SettingsFollowRulesPage() {
  return <SettingsFollowRulesContentInner />;
}

function SettingsFollowRulesContentInner() {
  const { libraryId } = useCurrentLibrary();
  const { data: currentRules, isLoading: rulesLoading } = useFollowRules(libraryId);
  const patchFollowRules = usePatchFollowRules(libraryId);

  const [includePrimary, setIncludePrimary] = useState<string[]>([]);
  const [excludeSecondary, setExcludeSecondary] = useState<string[]>([]);
  const [autoFollowMinAlbums, setAutoFollowMinAlbums] = useState(2);
  const [savedRules, setSavedRules] = useState<FollowRules | null>(null);

  // Initialize fields when settings arrive
  useEffect(() => {
    if (currentRules) {
      setIncludePrimary(currentRules.includePrimary);
      setExcludeSecondary(currentRules.excludeSecondary);
      setAutoFollowMinAlbums(currentRules.autoFollowMinAlbums);
      setSavedRules(currentRules);
    }
  }, [currentRules]);

  const handlePrimaryTypeChange = (type: string, checked: boolean) => {
    setIncludePrimary((prev) =>
      checked ? [...prev, type] : prev.filter((t) => t !== type)
    );
  };

  const handleSecondaryTypeChange = (type: string, checked: boolean) => {
    setExcludeSecondary((prev) =>
      checked ? [...prev, type] : prev.filter((t) => t !== type)
    );
  };

  const handleSave = async () => {
    const newRules: FollowRules = {
      includePrimary,
      excludeSecondary,
      autoFollowMinAlbums,
    };

    await patchFollowRules.mutateAsync(newRules);
    setSavedRules(newRules);
  };

  const handleReset = () => {
    if (savedRules) {
      setIncludePrimary(savedRules.includePrimary);
      setExcludeSecondary(savedRules.excludeSecondary);
      setAutoFollowMinAlbums(savedRules.autoFollowMinAlbums);
    }
  };

  const hasChanges =
    JSON.stringify(includePrimary) !== JSON.stringify(savedRules?.includePrimary ?? []) ||
    JSON.stringify(excludeSecondary) !== JSON.stringify(savedRules?.excludeSecondary ?? []) ||
    autoFollowMinAlbums !== (savedRules?.autoFollowMinAlbums ?? 2);

  if (rulesLoading) return <div className={styles.container}>Loading settings...</div>;

  return (
    <div className={styles.content}>
      <div className={styles.section}>
        <h2 className={styles.sectionTitle}>Follow Rules</h2>

        <p className={styles.pageHint}>
          Default inclusion: primary type Album; optional EP and Single. Default exclusion: Compilation, Live, Remix, DJ-mix, Mixtape/Street, Demo, Soundtrack. Auto-follow when artist has ≥ albums in library. These apply to new follows, refresh, and auto-follow; per-artist overrides available on artist page.
        </p>

        <div className={styles.fieldGroup}>
          <label className={styles.label}>Include Primary Types</label>
          <p className={styles.hint}>
            Which release types to include when following new artists or refreshing discographies.
          </p>
          <div className={styles.checkboxGroup}>
            {PRIMARY_TYPES.map((type) => (
              <label key={type} className={styles.checkboxLabel}>
                <input
                  type="checkbox"
                  checked={includePrimary.includes(type)}
                  onChange={(e) => handlePrimaryTypeChange(type, e.target.checked)}
                  className={styles.checkbox}
                />
                <span>{type}</span>
              </label>
            ))}
          </div>
        </div>

        <div className={styles.fieldGroup}>
          <label className={styles.label}>Exclude Secondary Types</label>
          <p className={styles.hint}>
            Which release types to exclude when following new artists or refreshing discographies.
          </p>
          <div className={styles.checkboxGroup}>
            {SECONDARY_TYPES.map((type) => (
              <label key={type} className={styles.checkboxLabel}>
                <input
                  type="checkbox"
                  checked={excludeSecondary.includes(type)}
                  onChange={(e) => handleSecondaryTypeChange(type, e.target.checked)}
                  className={styles.checkbox}
                />
                <span>{type}</span>
              </label>
            ))}
          </div>
        </div>

        <div className={styles.fieldGroup}>
          <label htmlFor="autoFollowMinAlbums" className={styles.label}>
            Auto-follow Threshold
          </label>
          <p className={styles.hint}>
            Minimum number of albums by an artist in your library before automatically following them (1–10, default 2).
          </p>
          <div className={styles.inputWrapper}>
            <input
              id="autoFollowMinAlbums"
              type="number"
              min="1"
              max="10"
              className={styles.input}
              value={autoFollowMinAlbums}
              onChange={(e) =>
                setAutoFollowMinAlbums(Math.max(1, Math.min(10, parseInt(e.target.value, 10) || 1)))
              }
            />
          </div>
        </div>

        <div className={styles.actions}>
          <button
            onClick={handleSave}
            disabled={!hasChanges || patchFollowRules.isPending}
            className={styles.button}
          >
            {patchFollowRules.isPending ? 'Saving...' : 'Save'}
          </button>
          <button
            onClick={handleReset}
            disabled={!hasChanges}
            className={styles.resetButton}
          >
            Reset to defaults
          </button>
          {patchFollowRules.isSuccess && <span className={styles.success}>Settings saved</span>}
          {patchFollowRules.isError && (
            <span className={styles.error}>
              {(patchFollowRules.error as { detail?: string; message?: string })?.detail ??
                (patchFollowRules.error as Error)?.message ?? 'Failed to save'}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
