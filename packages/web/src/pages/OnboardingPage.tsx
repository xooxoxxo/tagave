/**
 * First-run setup (spec PLT-4), steps 3–4 of 4, after the owner account
 * exists: a music folder the worker can read, then a first scan followed
 * live until the first album is identified. Everything is read back from the
 * server, so a reload picks up where the owner left off.
 */

import { useState } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import type { AlbumSummary, JobsListResponse } from '@tagave/shared';
import {
  useCurrentLibrary,
  useScanRoots,
  useCreateScanRoot,
  useStartScan,
  useValidateScanRoot,
  useKickSweep,
  type IdentifyStatsResponse,
  type JobInfo,
} from '../hooks';
import { useLibrarySettings, useUpdateLibrarySettings } from '../hooks/useLibrary';
import { useSystemChecks } from '../hooks/useSystem';
import { useUpdates } from '../hooks/useUpdates';
import { api } from '../services/api';
import { Banner, Button, Card, Input, TextField } from '../components/ui';
import { SetupSteps } from '../components/SetupSteps';
import { firstScanState, folderAdvice, folderCheckerLive, workerLive, validateContact } from './setupWizard';
import styles from './OnboardingPage.module.css';

const LIVE_MS = 5000;
/** Scan states that stop the polling. */
const SCAN_OVER = new Set(['done', 'failed', 'interrupted', 'cancelled']);

export function OnboardingPage() {
  const navigate = useNavigate();
  const { libraryId } = useCurrentLibrary();
  const { data: settings, isLoading: settingsLoading } = useLibrarySettings(libraryId);
  const updateSettings = useUpdateLibrarySettings(libraryId);
  const { data: scanRoots = [] } = useScanRoots(libraryId);
  const createScanRoot = useCreateScanRoot(libraryId);
  const validateRoot = useValidateScanRoot(libraryId);
  const startScan = useStartScan(libraryId);
  const kickSweep = useKickSweep(libraryId);

  const [contactString, setContactString] = useState('');
  const [contactError, setContactError] = useState<string | undefined>();
  const [rootPath, setRootPath] = useState('');
  const [rootName, setRootName] = useState('');
  const [rootWritable, setRootWritable] = useState(true);
  const [rootError, setRootError] = useState<string | undefined>();
  const [addingAnother, setAddingAnother] = useState(false);
  const [discogsToken, setDiscogsToken] = useState('');
  const [acoustidKey, setAcoustidKey] = useState('');
  const [scanError, setScanError] = useState<string | null>(null);

  const readyRoots = scanRoots.filter((r) => r.validationStatus === 'ok');
  const scanStarted = !!settings?.onboardingCompletedAt || scanRoots.some((r) => !!r.lastScanAt);

  // Worker liveness decides what a folder that is still "checking" means;
  // re-read it while there is no worker or a folder is waiting.
  const anyPending = scanRoots.some((r) => r.validationStatus === 'pending');
  const system = useSystemChecks({
    refetchInterval: (data) => (workerLive(data?.checks) === false || anyPending ? 10_000 : false),
  });
  const live = workerLive(system.data?.checks);
  const heartbeat = system.data?.checks.find((c) => c.id === 'workerHeartbeat');
  // Which queues the live workers take: a folder only gets checked by the
  // worker that scans. Only asked while a folder is waiting.
  const updates = useUpdates(anyPending ? libraryId : undefined);
  const checkerLive = anyPending ? folderCheckerLive(updates.data?.workers) : undefined;

  const firstAlbum = useQuery({
    queryKey: ['onboarding', 'first-album', libraryId],
    queryFn: () =>
      api
        .get<{ items: AlbumSummary[] }>(`/libraries/${libraryId}/albums?filter=matched&sort=added_date&limit=1`)
        .then((r) => r.items[0] ?? null),
    enabled: !!libraryId && scanStarted,
    refetchInterval: (q) => (q.state.data ? false : LIVE_MS),
  });
  const identified = firstAlbum.data ?? null;

  const stats = useQuery({
    queryKey: ['identify-stats', libraryId],
    queryFn: () => api.get<IdentifyStatsResponse>(`/libraries/${libraryId}/identify/stats`),
    enabled: !!libraryId && scanStarted,
    refetchInterval: identified ? false : LIVE_MS,
  });

  const scanJob = useQuery({
    queryKey: ['onboarding', 'scan-job', libraryId],
    queryFn: () =>
      api
        // routine included: a scan that found nothing is filed as routine;
        // a failed one comes back under `attention`, not `data`
        .get<JobsListResponse>(`/libraries/${libraryId}/jobs?limit=20&include=routine`)
        .then((r) => [...r.attention, ...r.data].find((j) => j.type === 'scan.root') ?? null),
    enabled: !!libraryId && scanStarted,
    refetchInterval: (q) => (SCAN_OVER.has(q.state.data?.status ?? '') ? false : LIVE_MS),
  });

  if (settingsLoading || !libraryId) {
    return <div className={styles.container} role="status">Loading setup…</div>;
  }

  const needsContact = !settings?.contactString;

  const saveContact = async () => {
    const error = validateContact(contactString);
    setContactError(error);
    if (!error) await updateSettings.mutateAsync({ contactString: contactString.trim() });
  };

  const addRoot = async (e: React.FormEvent) => {
    e.preventDefault();
    const path = rootPath.trim();
    if (!path.startsWith('/')) {
      setRootError('Enter a full path that starts with /, as the worker sees it.');
      return;
    }
    setRootError(undefined);
    await createScanRoot.mutateAsync({
      path,
      displayName: rootName.trim() || path.split('/').filter(Boolean).pop() || path,
      writable: rootWritable,
      enabled: true,
      pollIntervalS: 21600,
    });
    setRootPath('');
    setRootName('');
    setAddingAnother(false);
  };

  const startFirstScan = async () => {
    const root = readyRoots.find((r) => !r.lastScanAt) ?? readyRoots[0];
    if (!root) return;
    try {
      setScanError(null);
      await startScan.mutateAsync(root.id);
      await updateSettings.mutateAsync({ onboardingCompletedAt: new Date().toISOString() });
    } catch (error) {
      const detail = (error as { detail?: string })?.detail;
      setScanError(detail || 'The scan could not be started. Try again in a moment.');
    }
  };

  const finish = async () => {
    if (!settings?.onboardingCompletedAt) {
      await updateSettings.mutateAsync({ onboardingCompletedAt: new Date().toISOString() });
    }
    // Last, skippable step; it moves straight on when a factor exists.
    navigate({ to: '/onboarding/protect' });
  };

  const showRootForm = scanRoots.length === 0 || addingAnother;
  const job = scanJob.data;
  const found = stats.data?.total ?? 0;
  const matched = stats.data?.states.matched ?? 0;
  const scanState = firstScanState({ scanStatus: job?.status, albumsFound: found, grouping: stats.data?.grouping, statsLoaded: !!stats.data });

  return (
    <div className={styles.container}>
      <header className={styles.header}>
        <h1 className={styles.title}>Set up tagave</h1>
        <SetupSteps current={scanStarted || readyRoots.length > 0 ? 'First album' : 'Music folder'} />
      </header>

      {live === false && (
        <Banner tone="warning">
          <strong>No worker is running.</strong> {heartbeat?.remediation ?? ''}{' '}
          <Link to="/settings/$section" params={{ section: 'system' }}>System checks</Link>
        </Banner>
      )}

      {needsContact && (
        <Card title="Contact for metadata services">
          <div className={styles.stack}>
            <TextField
              label="Email address or website"
              value={contactString}
              onChange={(e) => setContactString(e.target.value)}
              error={contactError}
              placeholder="you@example.com or https://example.com"
            />
            <div className={styles.actions}>
              <Button onClick={() => void saveContact()} loading={updateSettings.isPending} disabled={!contactString.trim()}>
                Save
              </Button>
            </div>
          </div>
        </Card>
      )}

      <Card title="Music folder">
        <div className={styles.stack}>

          {scanRoots.length > 0 && (
            <ul className={styles.roots}>
              {scanRoots.map((root) => {
                const advice = folderAdvice(root, { workerLive: live, checkerLive });
                const canRecheck = root.validationStatus !== 'ok' && advice.tone !== 'info';
                return (
                  <li key={root.id} className={styles.root}>
                    <div className={styles.rootHead}>
                      <span className={styles.rootName}>{root.displayName}</span>
                      <code className={styles.rootPath}>{root.path}</code>
                    </div>
                    {advice.tone !== 'success' && <Banner tone={advice.tone}>
                      <strong>{advice.title}{advice.text ? '.' : ''}</strong> {advice.text}
                    </Banner>}
                    {canRecheck && (
                      <div className={styles.actions}>
                        <Button
                          variant="secondary"
                          size="sm"
                          loading={validateRoot.isPending && validateRoot.variables === root.id}
                          onClick={() => validateRoot.mutate(root.id)}
                        >
                          Re-check
                        </Button>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}

          {showRootForm ? (
            <form onSubmit={addRoot} className={styles.stack}>
              <TextField
                label="Path on the worker"
                required
                value={rootPath}
                onChange={(e) => setRootPath(e.target.value)}
                error={rootError}
                placeholder="/mnt/music"
              />
              <TextField
                label="Name"
                value={rootName}
                onChange={(e) => setRootName(e.target.value)}

                placeholder="My music"
              />
              <label className={styles.checkbox}>
                <input type="checkbox" checked={rootWritable} onChange={(e) => setRootWritable(e.target.checked)} />
                Allow tag writes
              </label>
              {createScanRoot.error && (
                <Banner tone="danger">
                  {(createScanRoot.error as { detail?: string }).detail || 'The folder could not be added. Try again.'}
                </Banner>
              )}
              <div className={styles.actions}>
                {addingAnother && (
                  <Button variant="secondary" onClick={() => setAddingAnother(false)}>
                    Cancel
                  </Button>
                )}
                <Button type="submit" loading={createScanRoot.isPending} disabled={!rootPath.trim()}>
                  Add folder
                </Button>
              </div>
            </form>
          ) : (
            <div className={styles.actions}>
              <Button variant="ghost" onClick={() => setAddingAnother(true)}>
                Add another folder
              </Button>
            </div>
          )}
        </div>
      </Card>

      <Card title="First album">
        <div className={styles.stack}>
          {/* A library that has been scanned shows its progress even while a
              folder check is pending again (they re-run every ten minutes). */}
          {!scanStarted && readyRoots.length === 0 ? (
            <p className={styles.description}>Add a folder first</p>
          ) : !scanStarted ? (
            <>
              {scanError && <Banner tone="danger">{scanError}</Banner>}
              <div className={styles.actions}>
                <Button onClick={() => void startFirstScan()} loading={startScan.isPending}>
                  Start first scan
                </Button>
              </div>
            </>
          ) : (
            <>
              <dl className={styles.progress}>
                <div>
                  <dt>Scan</dt>
                  <dd>{scanLine(job)}</dd>
                </div>
                <div>
                  <dt>Albums found</dt>
                  <dd>{stats.data ? found : '…'}</dd>
                </div>
                <div>
                  <dt>Identified</dt>
                  <dd>{stats.data ? matched : '…'}</dd>
                </div>
              </dl>

              {identified ? (
                <Banner tone="success">
                  <strong>First album identified:</strong>{' '}
                  <Link to="/albums/$albumId" params={{ albumId: identified.id }}>
                    {identified.title}
                  </Link>{' '}
                  by {identified.artistCredit}
                </Banner>
              ) : job && (job.status === 'failed' || job.status === 'interrupted' || job.status === 'cancelled') ? (
                <Banner tone="danger">
                  The scan stopped: {job.error ?? 'no reason was recorded'}.{' '}
                  <Link to="/settings/$section" params={{ section: 'activity' }}>Open background activity</Link>
                </Banner>
              ) : scanState === 'grouping' ? (
                <Banner tone="info">Grouping files into albums…</Banner>
              ) : scanState === 'empty' ? (
                <Banner tone="warning">
                  No albums found. Check the folder above.
                </Banner>
              ) : scanState === 'found' ? (
                <Banner tone="info">
                  Identifying albums…{' '}
                  <Button variant="secondary" size="sm" loading={kickSweep.isPending} onClick={() => kickSweep.mutate()}>
                    Identify now
                  </Button>
                </Banner>
              ) : (
                <Banner tone="info">Scanning…</Banner>
              )}
            </>
          )}
        </div>
      </Card>

      <Card title="Optional">
        <div className={styles.stack}>
          <div className={styles.field}>
            <span className={styles.label}>Discogs token</span>

            {settings?.discogsTokenSet ? (
              <div className={styles.row}>
                <span className={styles.configured}>Saved{settings.discogsTokenHint ? ` ••••${settings.discogsTokenHint}` : ''}</span>
                <Button variant="ghost" size="sm" onClick={() => updateSettings.mutate({ discogsToken: null })}>
                  Remove
                </Button>
              </div>
            ) : (
              <div className={styles.row}>
                <Input type="password" aria-label="Discogs token" value={discogsToken} onChange={(e) => setDiscogsToken(e.target.value)} placeholder="Paste your Discogs token" />
                <Button
                  variant="secondary"
                  disabled={!discogsToken}
                  onClick={() => updateSettings.mutate({ discogsToken }, { onSuccess: () => setDiscogsToken('') })}
                >
                  Save
                </Button>
              </div>
            )}
          </div>
          <div className={styles.field}>
            <span className={styles.label}>AcoustID key</span>

            {settings?.acoustidKeySet ? (
              <div className={styles.row}>
                <span className={styles.configured}>Saved{settings.acoustidKeyHint ? ` ••••${settings.acoustidKeyHint}` : ''}</span>
                <Button variant="ghost" size="sm" onClick={() => updateSettings.mutate({ acoustidKey: null })}>
                  Remove
                </Button>
              </div>
            ) : (
              <div className={styles.row}>
                <Input type="password" aria-label="AcoustID key" value={acoustidKey} onChange={(e) => setAcoustidKey(e.target.value)} placeholder="Paste your AcoustID key" />
                <Button
                  variant="secondary"
                  disabled={!acoustidKey}
                  onClick={() => updateSettings.mutate({ acoustidKey }, { onSuccess: () => setAcoustidKey('') })}
                >
                  Save
                </Button>
              </div>
            )}
          </div>
        </div>
      </Card>

      <footer className={styles.footer}>
        <Button onClick={() => void finish()} variant={identified ? 'primary' : 'secondary'}>
          {identified ? 'Go to my library' : 'Finish later'}
        </Button>
      </footer>
    </div>
  );
}

function scanLine(job: JobInfo | null | undefined): string {
  if (!job) return 'Waiting for the worker to start';
  switch (job.status) {
    case 'waiting':
      return 'Waiting for the worker to start';
    case 'running':
      return job.progress?.done ? `Reading files: ${job.progress.done.toLocaleString()} so far` : 'Reading files';
    case 'done':
      return job.progress?.done ? `Finished: ${job.progress.done.toLocaleString()} files read` : 'Finished';
    case 'failed':
    case 'interrupted':
      return 'Stopped';
    case 'cancelled':
      return 'Cancelled';
  }
}
