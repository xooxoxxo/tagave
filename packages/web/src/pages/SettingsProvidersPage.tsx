/**
 * Provider settings page (spec PLT-4): Discogs token, contact string, and enrichment controls
 */
import { useEffect, useState } from 'react';
import { useCurrentLibrary } from '../hooks';
import { useLibrarySettings, useUpdateLibrarySettings, useEnrichSweep } from '../hooks/useLibrary';
import { useFingerprintStats } from '../hooks/useFingerprint';
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

        <div className={styles.fieldGroup}>
          <label className={styles.label}>AcoustID Key</label>
          <p className={styles.hint}>
            Fingerprint-based identification for albums whose tags are wrong or missing (APE and WavPack image rips, mistagged folders).
            Get a free application key at acoustid.org — the service is free for non-commercial use only.
          </p>
          {settings?.acoustidKeySet ? (
            <div className={styles.tokenConfigured}>
              <span className={styles.tokenHint}>
                Key configured ({settings.acoustidKeyHint ? `••••${settings.acoustidKeyHint}` : 'unknown'})
              </span>
              <button
                onClick={handleClearAcoustidKey}
                disabled={updateSettings.isPending}
                className={styles.clearButton}
              >
                {updateSettings.isPending ? 'Clearing...' : 'Clear'}
              </button>
            </div>
          ) : (
            <button
              onClick={() => setShowAcoustidConfig(!showAcoustidConfig)}
              className={styles.configButton}
            >
              {showAcoustidConfig ? 'Cancel' : 'Configure Key'}
            </button>
          )}
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
            Fingerprint unidentified albums in the background
          </label>
          <p className={styles.hint}>
            Every 15 minutes the file worker fingerprints the next 20 unidentified albums (untagged and no-candidate ones first) and the identify
            worker looks them up on AcoustID at 3 requests/second; matches feed the normal identification with their release candidates.
            {!settings?.acoustidKeySet && ' Needs the key above.'}
          </p>
          {fpStats && (
            <p className={styles.hint}>
              {fpStats.albums.lookedUp.toLocaleString()} of {(fpStats.albums.lookedUp + fpStats.albums.remaining).toLocaleString()} unidentified albums looked up
              {' · '}{fpStats.albums.withCandidates.toLocaleString()} got candidates, {fpStats.albums.noCandidates.toLocaleString()} none
              {fpStats.albums.matchedViaAcoustid > 0 ? ` · ${fpStats.albums.matchedViaAcoustid.toLocaleString()} matched via AcoustID` : ''}
              {' · '}{fpStats.files.fingerprinted.toLocaleString()} files fingerprinted{fpStats.files.failed ? ` (${fpStats.files.failed} failed)` : ''}
              {fpStats.queue.fingerprintWaiting + fpStats.queue.lookupWaiting > 0 ? ` · ${fpStats.queue.fingerprintWaiting + fpStats.queue.lookupWaiting} in the queue` : ''}
              {' · '}{fpStats.lookups.last24h.toLocaleString()} lookups in 24 h
            </p>
          )}
          {fpStats?.provider && (
            <p className={styles.error} role="alert">
              AcoustID is parked until {new Date(fpStats.provider.parkedUntil).toLocaleTimeString()}
              {fpStats.provider.reason ? `: ${fpStats.provider.reason}` : ''}.
              {/invalid api key/i.test(fpStats.provider.reason ?? '')
                ? ' Lookups need an application key (acoustid.org/new-application), not your user key — saving a new key above clears this.'
                : ' Saving a new key above clears this.'}
            </p>
          )}
        </div>

        <div className={styles.actions}>
          <button
            onClick={handleSave}
            disabled={(!discogsToken && !acoustidKey && contactString === settings?.contactString) || updateSettings.isPending}
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
