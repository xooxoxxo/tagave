/**
 * Jobs dashboard showing running and historical jobs
 * M0: Basic view of scan jobs
 */

import { useCurrentLibrary, useScanRoots } from '../hooks';
import { formatDateTime } from '../utils';
import styles from './JobsPage.module.css';

export function JobsPage() {
  const { libraryId } = useCurrentLibrary();
  const { data: scanRoots = [], isLoading } = useScanRoots(libraryId);

  if (!libraryId) {
    return <div className={styles.container}>Loading...</div>;
  }

  // Extract job info from scan roots
  const jobs = scanRoots.flatMap((root) => {
    const items = [];

    if (root.lastStatus === 'scanning' && root.currentScanJobId) {
      items.push({
        id: root.currentScanJobId,
        type: 'scan' as const,
        status: 'running' as const,
        rootName: root.displayName,
        progress: { current: 0, total: root.tracksFound || 100 },
        startedAt: new Date().toISOString(),
      });
    }

    if (root.lastScanAt) {
      items.push({
        id: `${root.id}-last-scan`,
        type: 'scan' as const,
        status: root.lastStatus === 'error' ? 'failed' : 'completed',
        rootName: root.displayName,
        completedAt: root.lastScanAt,
        albumsScanned: root.albumsFound,
        tracksScanned: root.tracksFound,
      });
    }

    return items;
  });

  const runningJobs = jobs.filter((j) => j.status === 'running');
  const completedJobs = jobs.filter((j) => j.status === 'completed').slice(0, 20);
  const failedJobs = jobs.filter((j) => j.status === 'failed');

  return (
    <div className={styles.container}>
      <header className={styles.header}>
        <h1 className={styles.title}>Jobs</h1>
        <p className={styles.subtitle}>Job history and status</p>
      </header>

      {isLoading ? (
        <div className={styles.loading}>Loading jobs...</div>
      ) : (
        <>
          {/* Running jobs */}
          {runningJobs.length > 0 && (
            <section className={styles.section}>
              <h2 className={styles.sectionTitle}>Running</h2>
              <div className={styles.jobsList}>
                {runningJobs.map((job) => (
                  <div key={job.id} className={`${styles.jobCard} ${styles.statusRunning}`}>
                    <div className={styles.jobHeader}>
                      <div>
                        <h3 className={styles.jobTitle}>{job.rootName}</h3>
                        <p className={styles.jobType}>Scan</p>
                      </div>
                      <span className={styles.badge}>Running...</span>
                    </div>
                    {job.progress && (
                      <div className={styles.progress}>
                        <div className={styles.progressBar}>
                          <div
                            className={styles.progressFill}
                            style={{
                              width: `${(job.progress.current / job.progress.total) * 100}%`,
                            }}
                          />
                        </div>
                        <p className={styles.progressText}>
                          {job.progress.current} / {job.progress.total} files
                        </p>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </section>
          )}

          {/* Failed jobs */}
          {failedJobs.length > 0 && (
            <section className={styles.section}>
              <h2 className={styles.sectionTitle}>Failed</h2>
              <div className={styles.jobsList}>
                {failedJobs.map((job) => (
                  <div key={job.id} className={`${styles.jobCard} ${styles.statusFailed}`}>
                    <div className={styles.jobHeader}>
                      <div>
                        <h3 className={styles.jobTitle}>{job.rootName}</h3>
                        <p className={styles.jobType}>Scan</p>
                      </div>
                      <span className={styles.badge}>Failed</span>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}

          {/* Completed jobs */}
          {completedJobs.length > 0 && (
            <section className={styles.section}>
              <h2 className={styles.sectionTitle}>Completed</h2>
              <div className={styles.jobsList}>
                {completedJobs.map((job) => (
                  <div key={job.id} className={`${styles.jobCard} ${styles.statusCompleted}`}>
                    <div className={styles.jobHeader}>
                      <div>
                        <h3 className={styles.jobTitle}>{job.rootName}</h3>
                        <p className={styles.jobType}>Scan</p>
                      </div>
                      <div className={styles.jobMeta}>
                        {(job as any).albumsScanned && (
                          <span className={styles.metaTag}>
                            {(job as any).albumsScanned} albums
                          </span>
                        )}
                        {(job as any).tracksScanned && (
                          <span className={styles.metaTag}>
                            {(job as any).tracksScanned} tracks
                          </span>
                        )}
                      </div>
                    </div>
                    {(job as any).completedAt && (
                      <p className={styles.timestamp}>
                        {formatDateTime((job as any).completedAt)}
                      </p>
                    )}
                  </div>
                ))}
              </div>
            </section>
          )}

          {/* Empty state */}
          {jobs.length === 0 && (
            <div className={styles.emptyState}>
              <p>No jobs yet. Start a scan from Settings.</p>
            </div>
          )}
        </>
      )}
    </div>
  );
}
