/**
 * Dashboard page showing library overview and recent activity
 * M0: Basic stats and scan status
 */

import { useQuery } from '@tanstack/react-query';
import { useCurrentLibrary, useScanRoots } from '../hooks';
import { api } from '../services/api';

interface LibraryStats {
  albums: number;
  tracks: number;
  hours: number;
  storageBytes: number;
  losslessShare: number;
  states: { matched: number; needsReview: number; pending: number; unidentified: number };
}

function useLibraryStats(libraryId: string | undefined) {
  return useQuery({
    queryKey: ['library-stats', libraryId],
    queryFn: () => api.get<LibraryStats>(`/libraries/${libraryId}/stats`),
    enabled: !!libraryId,
    refetchInterval: 30_000,
  });
}
import styles from './DashboardPage.module.css';

export function DashboardPage() {
  const { libraryId } = useCurrentLibrary();
  const { data: scanRoots, isLoading, error } = useScanRoots(libraryId);
  const { data: stats } = useLibraryStats(libraryId);

  if (!libraryId) {
    return <div className={styles.container}>Loading library...</div>;
  }

  if (isLoading) {
    return <div className={styles.container}>Loading dashboard...</div>;
  }

  if (error) {
    return (
      <div className={styles.container}>
        <div className={styles.error}>Failed to load dashboard</div>
      </div>
    );
  }

  const totalAlbums = stats?.albums ?? 0;
  const totalTracks = stats?.tracks ?? 0;
  const isScanning = scanRoots?.some((root) => root.lastStatus === 'scanning');

  return (
    <div className={styles.container}>
      <header className={styles.header}>
        <h1 className={styles.title}>Dashboard</h1>
        <p className={styles.subtitle}>Library overview and recent activity</p>
      </header>

      <div className={styles.grid}>
        {/* Promise counters per spec 14.2 */}
        <div className={styles.statCard}>
          <div className={styles.statLabel}>Identified</div>
          <div className={styles.statValue}>—</div>
          <div className={styles.statNote}>M1+</div>
        </div>

        <div className={styles.statCard}>
          <div className={styles.statLabel}>Tag Health</div>
          <div className={styles.statValue}>—</div>
          <div className={styles.statNote}>M2+</div>
        </div>

        <div className={styles.statCard}>
          <div className={styles.statLabel}>Open Gaps</div>
          <div className={styles.statValue}>—</div>
          <div className={styles.statNote}>M3+</div>
        </div>

        <div className={styles.statCard}>
          <div className={styles.statLabel}>Reviews</div>
          <div className={styles.statValue}>—</div>
          <div className={styles.statNote}>M4+</div>
        </div>
      </div>

      {/* Library stats */}
      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>Library Overview</h2>
        <div className={styles.overview}>
          <div className={styles.overviewItem}>
            <span className={styles.overviewLabel}>Albums</span>
            <span className={styles.overviewValue}>{totalAlbums.toLocaleString()}</span>
          </div>
          <div className={styles.overviewItem}>
            <span className={styles.overviewLabel}>Tracks</span>
            <span className={styles.overviewValue}>{totalTracks.toLocaleString()}</span>
          </div>
          <div className={styles.overviewItem}>
            <span className={styles.overviewLabel}>Scan Roots</span>
            <span className={styles.overviewValue}>{scanRoots?.length || 0}</span>
          </div>
          {isScanning && (
            <div className={styles.overviewItem}>
              <span className={styles.overviewLabel}>Status</span>
              <span className={styles.overviewValue} style={{ color: 'var(--info)' }}>
                Scanning...
              </span>
            </div>
          )}
        </div>
      </section>

      {/* Scan roots status */}
      {scanRoots && scanRoots.length > 0 && (
        <section className={styles.section}>
          <h2 className={styles.sectionTitle}>Scan Roots</h2>
          <div className={styles.rootsList}>
            {scanRoots.map((root) => (
              <div key={root.id} className={styles.rootItem}>
                <div className={styles.rootInfo}>
                  <h3 className={styles.rootName}>{root.displayName}</h3>
                  <p className={styles.rootPath}>{root.path}</p>
                </div>
                <div className={styles.rootStats}>
                  <span className={styles.stat}>
                    {root.albumsFound} albums
                  </span>
                  <span className={styles.stat}>
                    {root.tracksFound} tracks
                  </span>
                  <span className={styles.stat}>
                    {root.writable ? 'Writable' : 'Read-only'}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Empty state */}
      {!scanRoots || scanRoots.length === 0 && (
        <section className={styles.emptyState}>
          <h2>No scan roots configured</h2>
          <p>Add a scan root in Settings to start indexing your music library.</p>
        </section>
      )}
    </div>
  );
}
