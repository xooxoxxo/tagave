/**
 * Provider settings page (spec PLT-4): Discogs token, contact string, and enrichment controls
 */
import { useEffect, useState } from 'react';
import { useCurrentLibrary } from '../hooks';
import { useLibrarySettings, useUpdateLibrarySettings, useEnrichSweep } from '../hooks/useLibrary';
import { useFingerprintStats } from '../hooks/useFingerprint';
import { Button } from '../components/ui';
import styles from './SettingsProvidersPage.module.css';

export function SettingsProvidersPage() {
  const { libraryId } = useCurrentLibrary();
  const { data: settings, isLoading } = useLibrarySettings(libraryId);
  const updateSettings = useUpdateLibrarySettings(libraryId);
  const { data: fpStats } = useFingerprintStats(libraryId, !!settings?.acoustidKeySet);
  const enrichSweep = useEnrichSweep(libraryId);

  const [contactString, setContactString] = useState('');
  const [discogsToken, setDiscogsToken] = useState('');
  const [acoustidKey, setAcoustidKey] = useState('');
  const [showTokenConfig, setShowTokenConfig] = useState(false);
  const [showAcoustidConfig, setShowAcoustidConfig] = useState(false);
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
    if (acoustidKey) {
      update.acoustidKey = acoustidKey;
    }
    if (Object.keys(update).length > 0) {
      await updateSettings.mutateAsync(update);
      setDiscogsToken('');
      setAcoustidKey('');
    }
  };

  const handleClearToken = async () => {
    await updateSettings.mutateAsync({ discogsToken: null });
  };

  const handleClearAcoustidKey = async () => {
    await updateSettings.mutateAsync({ acoustidKey: null });
  };

  return (
    <div className={styles.container}>
      {/* rendered inside the Settings shell (SettingsPage → PageShell tabs); no page header here */}
      <div className={styles.section}>
        <div className={styles.fieldGroup}>
          <label htmlFor="contactString" className={styles.label}>
            Contact
          </label>
          <input
            id="contactString"
            type="text"
            className={styles.input}
            placeholder="you@example.com"
            required
            value={contactString}
            onChange={(e) => setContactString(e.target.value)}
          />
        </div>

        <div className={styles.fieldGroup}>
          <label className={styles.label}>Discogs token</label>
          {settings?.discogsTokenSet ? (
            <div className={styles.tokenConfigured}>
              <span className={styles.tokenHint}>
                Saved{settings.discogsTokenHint ? ` ••••${settings.discogsTokenHint}` : ''}
              </span>
              <Button
                variant="quiet"
                size="sm"
                onClick={handleClearToken}
                disabled={updateSettings.isPending}
              >
                {updateSettings.isPending ? 'Clearing...' : 'Clear'}
              </Button>
            </div>
          ) : (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setShowTokenConfig(!showTokenConfig)}
            >
              {showTokenConfig ? 'Cancel' : 'Add token'}
            </Button>
          )}
          {!settings?.discogsTokenSet && <a className={styles.hint} href="https://www.discogs.com/settings/developers" target="_blank" rel="noreferrer">Get a token</a>}
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

        <div className={styles.fieldGroup}>
          <label className={styles.label}>AcoustID key</label>
          {settings?.acoustidKeySet ? (
            <div className={styles.tokenConfigured}>
              <span className={styles.tokenHint}>
                Saved{settings.acoustidKeyHint ? ` ••••${settings.acoustidKeyHint}` : ''}
              </span>
              <Button
                variant="quiet"
                size="sm"
                onClick={handleClearAcoustidKey}
                disabled={updateSettings.isPending}
              >
                {updateSettings.isPending ? 'Clearing...' : 'Clear'}
              </Button>
            </div>
          ) : (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setShowAcoustidConfig(!showAcoustidConfig)}
            >
              {showAcoustidConfig ? 'Cancel' : 'Add key'}
            </Button>
          )}
          {!settings?.acoustidKeySet && <a className={styles.hint} href="https://acoustid.org/new-application" target="_blank" rel="noreferrer">Get a key</a>}
          {showAcoustidConfig && (
            <input
              type="password"
              className={styles.input}
              placeholder="Paste your AcoustID API key"
              value={acoustidKey}
              onChange={(e) => setAcoustidKey(e.target.value)}
            />
          )}
        </div>

        <div className={styles.fieldGroup}>
          <label className={styles.label}>
            <input
              type="checkbox"
              checked={!!settings?.fingerprintingEnabled}
              disabled={!settings?.acoustidKeySet || updateSettings.isPending}
              onChange={(e) => updateSettings.mutate({ fingerprintingEnabled: e.target.checked })}
            />{' '}
            Fingerprint unidentified albums
          </label>
          {!settings?.acoustidKeySet && <p className={styles.hint}>Needs an AcoustID key</p>}
          {fpStats && (
            <p className={styles.hint}>
              {fpStats.albums.lookedUp.toLocaleString()} of {(fpStats.albums.lookedUp + fpStats.albums.remaining).toLocaleString()} looked up
              {' · '}{fpStats.albums.withCandidates.toLocaleString()} with candidates
              {fpStats.albums.matchedViaAcoustid > 0 ? ` · ${fpStats.albums.matchedViaAcoustid.toLocaleString()} matched` : ''}
              {' · '}{fpStats.files.fingerprinted.toLocaleString()} files{fpStats.files.failed ? ` (${fpStats.files.failed} failed)` : ''}
              {fpStats.queue.fingerprintWaiting + fpStats.queue.lookupWaiting > 0 ? ` · ${fpStats.queue.fingerprintWaiting + fpStats.queue.lookupWaiting} queued` : ''}
            </p>
          )}
          {fpStats?.provider && (
            <p className={styles.error} role="alert">
              AcoustID paused until {new Date(fpStats.provider.parkedUntil).toLocaleTimeString()}
              {fpStats.provider.reason ? `: ${fpStats.provider.reason}` : ''}
              {/invalid api key/i.test(fpStats.provider.reason ?? '') ? '. Use an application key, not a user key.' : ''}
            </p>
          )}
        </div>

        <div className={styles.actions}>
          <Button
            onClick={handleSave}
            disabled={(!discogsToken && !acoustidKey && contactString === settings?.contactString) || updateSettings.isPending}
          >
            {updateSettings.isPending ? 'Saving...' : 'Save'}
          </Button>
          {updateSettings.isSuccess && <span className={styles.success}>Saved</span>}
          {updateSettings.isError && (
            <span className={styles.error}>
              {(updateSettings.error as { detail?: string; message?: string })?.detail ??
                (updateSettings.error as Error)?.message ?? 'Failed to save'}
            </span>
          )}
        </div>
      </div>

      <div className={styles.section}>

        <Button
          variant="secondary"
          onClick={() => enrichSweep.mutate()}
          disabled={enrichSweep.isPending}
        >
          {enrichSweep.isPending ? 'Queued...' : 'Link Discogs IDs'}
        </Button>
        {enrichSweep.isSuccess && <span className={styles.success}>Queued</span>}
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
