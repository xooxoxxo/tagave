/**
 * First-run onboarding checklist (spec PLT-4)
 * Guided setup: contact string → scan root → Discogs token → AcoustID key → start scan
 */

import { useEffect, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useCurrentLibrary, useScanRoots, useCreateScanRoot, useStartScan } from '../hooks';
import { useLibrarySettings, useUpdateLibrarySettings } from '../hooks/useLibrary';
import styles from './OnboardingPage.module.css';

export function OnboardingPage() {
  const navigate = useNavigate();
  const { libraryId } = useCurrentLibrary();
  const { data: settings, isLoading: settingsLoading } = useLibrarySettings(libraryId);
  const updateSettings = useUpdateLibrarySettings(libraryId);
  const { data: scanRoots = [] } = useScanRoots(libraryId);
  const createScanRoot = useCreateScanRoot(libraryId);
  const startScan = useStartScan(libraryId);

  // Form states
  const [contactString, setContactString] = useState('');
  const [showAddRoot, setShowAddRoot] = useState(false);
  const [rootPath, setRootPath] = useState('');
  const [rootDisplayName, setRootDisplayName] = useState('');
  const [rootWritable, setRootWritable] = useState(true);
  const [discogsToken, setDiscogsToken] = useState('');
  const [acoustidKey, setAcoustidKey] = useState('');
  const [showDiscogsConfig, setShowDiscogsConfig] = useState(false);
  const [showAcoustidConfig, setShowAcoustidConfig] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);

  // Initialize contact string from settings
  useEffect(() => {
    if (settings?.contactString) {
      setContactString(settings.contactString);
    }
  }, [settings?.contactString]);

  if (settingsLoading || !libraryId) {
    return <div className={styles.container}>Loading setup...</div>;
  }

  const validatedRoots = scanRoots.filter((r) => r.validationStatus === 'ok');
  const pendingRoots = scanRoots.filter((r) => r.validationStatus === 'pending');
  const completedAt = settings?.onboardingCompletedAt;

  // Step statuses
  const step1Done = !!contactString;
  const step2Done = scanRoots.length > 0 && scanRoots.some((r) => r.validationStatus === 'ok');
  const step3Done = settings?.discogsTokenSet;
  const step4Done = settings?.acoustidKeySet;
  const step5Enabled = validatedRoots.length > 0;
  const step5Done = completedAt;

  const handleSaveContactString = async () => {
    if (contactString !== settings?.contactString) {
      await updateSettings.mutateAsync({ contactString });
    }
  };

  const handleAddRoot = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!rootPath.trim() || !rootDisplayName.trim()) return;

    await createScanRoot.mutateAsync({
      path: rootPath,
      displayName: rootDisplayName,
      writable: rootWritable,
      enabled: true,
      pollIntervalS: 21600,
    });

    setRootPath('');
    setRootDisplayName('');
    setRootWritable(true);
    setShowAddRoot(false);
  };

  const handleSaveDiscogsToken = async () => {
    if (discogsToken) {
      await updateSettings.mutateAsync({ discogsToken });
      setDiscogsToken('');
      setShowDiscogsConfig(false);
    }
  };

  const handleClearDiscogsToken = async () => {
    await updateSettings.mutateAsync({ discogsToken: null });
  };

  const handleSaveAcoustidKey = async () => {
    if (acoustidKey) {
      await updateSettings.mutateAsync({ acoustidKey });
      setAcoustidKey('');
      setShowAcoustidConfig(false);
    }
  };

  const handleClearAcoustidKey = async () => {
    await updateSettings.mutateAsync({ acoustidKey: null });
  };

  const handleStartFirstScan = async () => {
    // Start scan for the first root that hasn't been scanned yet
    const rootToScan = validatedRoots.find((r) => !r.lastScanAt) || validatedRoots[0];
    if (rootToScan) {
      try {
        setScanError(null);
        await startScan.mutateAsync(rootToScan.id);
        // Mark onboarding as completed
        await updateSettings.mutateAsync({
          onboardingCompletedAt: new Date().toISOString(),
        });
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Failed to start scan. Please try again.';
        setScanError(errorMessage);
      }
    }
  };

  const handleFinish = async () => {
    if (!completedAt) {
      await updateSettings.mutateAsync({
        onboardingCompletedAt: new Date().toISOString(),
      });
    }
    navigate({ to: '/' });
  };

  const handleSkip = () => {
    navigate({ to: '/' });
  };

  return (
    <div className={styles.container}>
      <header className={styles.header}>
        <h1 className={styles.title}>Set Up Liner</h1>
        <p className={styles.subtitle}>
          Complete these steps to start indexing your music library
        </p>
      </header>

      <div className={styles.checklist}>
        {/* Step 1: Contact String */}
        <div className={`${styles.step} ${step1Done ? styles.done : ''}`}>
          <div className={styles.stepHeader}>
            <h2 className={styles.stepTitle}>Contact String</h2>
            <span className={`${styles.pill} ${step1Done ? styles.completed : styles.required}`}>
              {step1Done ? 'Done' : 'Required'}
            </span>
          </div>
          <p className={styles.description}>
            Sent in the User-Agent of every provider request (MusicBrainz, Discogs, Wikidata).
            <strong> Required:</strong> no provider calls happen until it is set.
          </p>
          <div className={styles.control}>
            <input
              type="text"
              className={styles.input}
              placeholder="Your Name / App (your-email@example.com)"
              value={contactString}
              onChange={(e) => setContactString(e.target.value)}
            />
            <button
              onClick={handleSaveContactString}
              disabled={
                contactString === settings?.contactString ||
                !contactString ||
                updateSettings.isPending
              }
              className={styles.button}
            >
              {updateSettings.isPending ? 'Saving...' : 'Save'}
            </button>
          </div>
        </div>

        {/* Step 2: Scan Root */}
        <div className={`${styles.step} ${step2Done ? styles.done : ''}`}>
          <div className={styles.stepHeader}>
            <h2 className={styles.stepTitle}>Add a Scan Root</h2>
            <span className={`${styles.pill} ${step2Done ? styles.completed : styles.required}`}>
              {step2Done ? 'Done' : 'Required'}
            </span>
          </div>
          <p className={styles.description}>
            The path must exist on the worker host where your music is mounted.
            <strong> Required:</strong> at least one valid scan root to run a scan.
          </p>

          {/* Existing roots */}
          {scanRoots.length > 0 && (
            <div className={styles.rootsList}>
              {scanRoots.map((root) => (
                <div key={root.id} className={styles.rootItem}>
                  <div className={styles.rootInfo}>
                    <span className={styles.rootName}>{root.displayName}</span>
                    <span className={styles.rootPath}>{root.path}</span>
                  </div>
                  <span
                    className={`${styles.validationPill} ${styles[root.validationStatus]}`}
                  >
                    {root.validationStatus === 'pending' && 'Validating...'}
                    {root.validationStatus === 'ok' && 'Valid'}
                    {root.validationStatus === 'missing' && 'Path not found'}
                    {root.validationStatus === 'not_directory' && 'Not a directory'}
                    {root.validationStatus === 'unreadable' && 'Not readable'}
                  </span>
                </div>
              ))}
            </div>
          )}

          {/* Add form */}
          {!showAddRoot ? (
            <button
              onClick={() => setShowAddRoot(true)}
              className={styles.addButton}
            >
              + Add Scan Root
            </button>
          ) : (
            <form onSubmit={handleAddRoot} className={styles.form}>
              <div className={styles.field}>
                <label className={styles.label}>Path (absolute)</label>
                <input
                  type="text"
                  placeholder="/music or /mnt/music"
                  value={rootPath}
                  onChange={(e) => setRootPath(e.target.value)}
                  className={styles.input}
                />
              </div>
              <div className={styles.field}>
                <label className={styles.label}>Display Name</label>
                <input
                  type="text"
                  placeholder="My Music"
                  value={rootDisplayName}
                  onChange={(e) => setRootDisplayName(e.target.value)}
                  className={styles.input}
                />
              </div>
              <div className={styles.checkboxField}>
                <input
                  type="checkbox"
                  id="writable"
                  checked={rootWritable}
                  onChange={(e) => setRootWritable(e.target.checked)}
                  className={styles.checkbox}
                />
                <label htmlFor="writable" className={styles.checkboxLabel}>
                  Allow tag writes (enable metadata updates)
                </label>
              </div>
              <div className={styles.formActions}>
                <button
                  type="submit"
                  disabled={!rootPath.trim() || !rootDisplayName.trim() || createScanRoot.isPending}
                  className={styles.button}
                >
                  {createScanRoot.isPending ? 'Creating...' : 'Add'}
                </button>
                <button
                  type="button"
                  onClick={() => setShowAddRoot(false)}
                  className={styles.cancelButton}
                >
                  Cancel
                </button>
              </div>
            </form>
          )}

          {pendingRoots.length > 0 && (
            <p className={styles.note}>
              Validating {pendingRoots.length} root{pendingRoots.length > 1 ? 's' : ''}...
            </p>
          )}
        </div>

        {/* Step 3: Discogs Token */}
        <div className={`${styles.step} ${step3Done ? styles.done : ''}`}>
          <div className={styles.stepHeader}>
            <h2 className={styles.stepTitle}>Discogs Token (Optional)</h2>
            <span className={`${styles.pill} ${step3Done ? styles.completed : styles.optional}`}>
              {step3Done ? 'Done' : 'Optional'}
            </span>
          </div>
          <p className={styles.description}>
            A personal access token from discogs.com/settings/developers. With it Liner runs Discogs
            at 55 requests/minute instead of 25 and receives cover image URLs; without it candidates
            and genres still work, only slower and without images.
          </p>

          <div className={styles.control}>
            {settings?.discogsTokenSet ? (
              <>
                <span className={styles.configured}>
                  Token configured ({settings.discogsTokenHint ? `••••${settings.discogsTokenHint}` : 'unknown'})
                </span>
                <button
                  onClick={handleClearDiscogsToken}
                  disabled={updateSettings.isPending}
                  className={styles.clearButton}
                >
                  {updateSettings.isPending ? 'Clearing...' : 'Clear'}
                </button>
              </>
            ) : (
              <>
                <button
                  onClick={() => setShowDiscogsConfig(!showDiscogsConfig)}
                  className={styles.configButton}
                >
                  {showDiscogsConfig ? 'Cancel' : 'Configure Token'}
                </button>
                {showDiscogsConfig && (
                  <>
                    <input
                      type="password"
                      placeholder="Paste your Discogs API token"
                      value={discogsToken}
                      onChange={(e) => setDiscogsToken(e.target.value)}
                      className={styles.input}
                    />
                    <button
                      onClick={handleSaveDiscogsToken}
                      disabled={!discogsToken || updateSettings.isPending}
                      className={styles.button}
                    >
                      {updateSettings.isPending ? 'Saving...' : 'Save'}
                    </button>
                  </>
                )}
              </>
            )}
          </div>
        </div>

        {/* Step 4: AcoustID Key */}
        <div className={`${styles.step} ${step4Done ? styles.done : ''}`}>
          <div className={styles.stepHeader}>
            <h2 className={styles.stepTitle}>AcoustID Key (Optional)</h2>
            <span className={`${styles.pill} ${step4Done ? styles.completed : styles.optional}`}>
              {step4Done ? 'Done' : 'Optional'}
            </span>
          </div>
          <p className={styles.description}>
            Fingerprint-based identification of untagged files using the AcoustID service.
            <strong> Coming in a later milestone</strong> — the key is stored now for future use.
          </p>

          <div className={styles.control}>
            {settings?.acoustidKeySet ? (
              <>
                <span className={styles.configured}>
                  Key configured ({settings.acoustidKeyHint ? `••••${settings.acoustidKeyHint}` : 'unknown'})
                </span>
                <button
                  onClick={handleClearAcoustidKey}
                  disabled={updateSettings.isPending}
                  className={styles.clearButton}
                >
                  {updateSettings.isPending ? 'Clearing...' : 'Clear'}
                </button>
              </>
            ) : (
              <>
                <button
                  onClick={() => setShowAcoustidConfig(!showAcoustidConfig)}
                  className={styles.configButton}
                >
                  {showAcoustidConfig ? 'Cancel' : 'Configure Key'}
                </button>
                {showAcoustidConfig && (
                  <>
                    <input
                      type="password"
                      placeholder="Paste your AcoustID API key"
                      value={acoustidKey}
                      onChange={(e) => setAcoustidKey(e.target.value)}
                      className={styles.input}
                    />
                    <button
                      onClick={handleSaveAcoustidKey}
                      disabled={!acoustidKey || updateSettings.isPending}
                      className={styles.button}
                    >
                      {updateSettings.isPending ? 'Saving...' : 'Save'}
                    </button>
                  </>
                )}
              </>
            )}
          </div>
        </div>

        {/* Step 5: Start First Scan */}
        <div className={`${styles.step} ${step5Done ? styles.done : ''}`}>
          <div className={styles.stepHeader}>
            <h2 className={styles.stepTitle}>Start First Scan</h2>
            <span className={`${styles.pill} ${step5Done ? styles.completed : styles.required}`}>
              {step5Done ? 'Done' : 'Required'}
            </span>
          </div>
          <p className={styles.description}>
            <strong>Enabled when at least one scan root is validated.</strong> Albums appear on the
            dashboard as folders are indexed. You can monitor progress in the{' '}
            <a href="/jobs" className={styles.link}>
              Jobs
            </a>{' '}
            page.
          </p>

          {scanError && (
            <div className={styles.error}>
              {scanError}
            </div>
          )}

          {step5Done ? (
            <div className={styles.control}>
              <span className={styles.configured}>Scanning in progress...</span>
              <a href="/jobs" className={styles.link}>
                View jobs
              </a>
            </div>
          ) : (
            <button
              onClick={handleStartFirstScan}
              disabled={!step5Enabled || startScan.isPending}
              className={`${styles.button} ${!step5Enabled ? styles.disabled : ''}`}
            >
              {startScan.isPending ? 'Starting scan...' : 'Start First Scan'}
            </button>
          )}
        </div>
      </div>

      {/* Footer */}
      <footer className={styles.footer}>
        <div className={styles.footerButtons}>
          <button onClick={handleFinish} className={styles.primaryButton}>
            Finish
          </button>
          <button onClick={handleSkip} className={styles.secondaryButton}>
            Do this later
          </button>
        </div>
      </footer>
    </div>
  );
}
