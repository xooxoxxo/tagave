/**
 * Provider settings page (spec PLT-4): Discogs token, contact string, and enrichment controls
 */
import { useEffect, useState } from 'react';
import { useCurrentLibrary } from '../hooks';
import { useLibrarySettings, useUpdateLibrarySettings, useEnrichSweep } from '../hooks/useLibrary';
import { SettingsNav } from '../components/SettingsNav';
import styles from './SettingsProvidersPage.module.css';

export function SettingsProvidersPage() {
  const { libraryId } = useCurrentLibrary();
  const { data: settings, isLoading } = useLibrarySettings(libraryId);
  const updateSettings = useUpdateLibrarySettings(libraryId);
  const enrichSweep = useEnrichSweep(libraryId);

  const [contactString, setContactString] = useState('');
  const [discogsToken, setDiscogsToken] = useState('');
  const [showTokenConfig, setShowTokenConfig] = useState(false);
  // settings arrive after the first render; seed the field once they do
  useEffect(() => {
    setContactString(settings?.contactString ?? '');
  }, [settings?.contactString]);

  if (isLoading) return <div className={styles.container}>Loading settings...</div>;

  const handleSave = async () => {
    const update: Record<string, any> = {};
    if (contactString !== settings?.contactString) {
      update.contactString = contactString || undefined;
    }
    if (discogsToken) {
      update.discogsToken = discogsToken;
    }
    if (Object.keys(update).length > 0) {
      await updateSettings.mutateAsync(update);
      setDiscogsToken('');
    }
  };

  const handleClearToken = async () => {
    await updateSettings.mutateAsync({ discogsToken: null });
  };

  return (
    <div className={styles.container}>
      <h1 className={styles.title}>Settings</h1>
      <SettingsNav />

      <div className={styles.section}>
        <h2 className={styles.sectionTitle}>Provider Configuration</h2>

        <div className={styles.fieldGroup}>
          <label htmlFor="contactString" className={styles.label}>
            Contact string (User-Agent)
          </label>
          <p className={styles.hint}>
            Sent in the User-Agent of every provider request (MusicBrainz, Discogs, Wikidata) as required by their
            terms — an email address or URL. Required: no provider calls are made until it is set.
          </p>
          <input
            id="contactString"
            type="text"
            className={styles.input}
            placeholder="Your Name / App (your-email@example.com)"
            value={contactString}
            onChange={(e) => setContactString(e.target.value)}
          />
        </div>

        <div className={styles.fieldGroup}>
          <label className={styles.label}>Discogs API Token</label>
          <p className={styles.hint}>
            A personal access token from discogs.com/settings/developers. With it Liner runs Discogs at 55
            requests/minute instead of 25 and receives cover image URLs; without it Discogs candidates and
            genres still work, only slower and without images.
          </p>
          {settings?.discogsTokenSet ? (
            <div className={styles.tokenConfigured}>
              <span className={styles.tokenHint}>
                Token configured ({settings.discogsTokenHint ? `••••${settings.discogsTokenHint}` : 'unknown'})
              </span>
              <button
                onClick={handleClearToken}
                disabled={updateSettings.isPending}
                className={styles.clearButton}
              >
                {updateSettings.isPending ? 'Clearing...' : 'Clear'}
              </button>
            </div>
          ) : (
            <button
              onClick={() => setShowTokenConfig(!showTokenConfig)}
              className={styles.configButton}
            >
              {showTokenConfig ? 'Cancel' : 'Configure Token'}
            </button>
          )}
          {showTokenConfig && (
            <input
              type="password"
              className={styles.input}
              placeholder="Paste your Discogs API token"
              value={discogsToken}
              onChange={(e) => setDiscogsToken(e.target.value)}
            />
          )}
        </div>

        <div className={styles.actions}>
          <button
            onClick={handleSave}
            disabled={(!discogsToken && contactString === settings?.contactString) || updateSettings.isPending}
            className={styles.button}
          >
            {updateSettings.isPending ? 'Saving...' : 'Save Settings'}
          </button>
          {updateSettings.isSuccess && <span className={styles.success}>Settings saved</span>}
          {updateSettings.isError && (
            <span className={styles.error}>
              {(updateSettings.error as { detail?: string; message?: string })?.detail ??
                (updateSettings.error as Error)?.message ?? 'Failed to save'}
            </span>
          )}
        </div>
      </div>

      <div className={styles.section}>
        <h2 className={styles.sectionTitle}>Enrichment</h2>
        <p className={styles.hint}>
          Bridge your MusicBrainz release identifiers to Discogs and vice versa, unlocking additional metadata
          like genres, styles, and images.
        </p>
        <button
          onClick={() => enrichSweep.mutate()}
          disabled={enrichSweep.isPending}
          className={styles.button}
        >
          {enrichSweep.isPending ? 'Queued...' : 'Bridge Discogs identities now'}
        </button>
        {enrichSweep.isSuccess && <span className={styles.success}>Enrichment job queued</span>}
        {enrichSweep.isError && (
          <span className={styles.error}>
            {(enrichSweep.error as { detail?: string; message?: string })?.detail ??
              (enrichSweep.error as Error)?.message ?? 'Failed to queue'}
          </span>
        )}
      </div>
    </div>
  );
}
