/**
 * Jobs dashboard showing running and historical jobs
 * Operator-focused view with summary, failed jobs surfaced, internal jobs hidden
 */

import { Link, useSearch } from '@tanstack/react-router';
import { useCurrentLibrary, useIdentifyStats, useKickSweep, useJobs, useCancelJob, usePauseJob } from '../hooks';
import { formatRelativeTime } from '../utils/time';
import styles from './JobsPage.module.css';

// Job types that are internal/noise (heartbeats, periodic schedules)
const INTERNAL_JOB_TYPES = new Set([
  'worker.heartbeat',
  'worker.health',
  'system.tick',
  'schedule.minute',
  'schedule.hourly',
  'schedule.daily',
]);

interface JobInfoForDisplay {
  id: string;
  type: string;
  state: string;
  progress?: { done: number; total: number; message?: string };
  startedAt?: string | undefined;
  finishedAt?: string | undefined;
  error?: string | null;
  createdAt: string;
}

function getJobDescription(job: JobInfoForDisplay): string {
  const typeMap: Record<string, string> = {
    'identify.sweep': 'Album identification',
    'identify.album': 'Identify album',
    'scan.root': 'Scan folder',
    'tag.write': 'Write tags',
  };
  return typeMap[job.type] || job.type;
}

function formatDuration(startedAt: string | undefined, finishedAt: string | undefined): string {
  if (!startedAt) return '—';
  const start = new Date(startedAt).getTime();
  const end = finishedAt ? new Date(finishedAt).getTime() : Date.now();
  const seconds = Math.floor((end - start) / 1000);
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  return `${Math.floor(seconds / 3600)}h`;
}

export function JobsPage() {
  const { libraryId } = useCurrentLibrary();
  const search = useSearch({ strict: false }) as { jobId?: string };
  const focusJobId = search.jobId;

  const { data: identifyStats, isLoading: statsLoading } = useIdentifyStats(libraryId);
  const { data: jobsData, isLoading: jobsLoading } = useJobs(libraryId);
  const kickSweep = useKickSweep(libraryId);
  const cancelJob = useCancelJob(libraryId);
  const pauseJob = usePauseJob(libraryId);

  if (!libraryId) {
    return <div className={styles.container}>Loading...</div>;
  }

  const isLoading = statsLoading || jobsLoading;
  const allJobs = jobsData?.data || [];

  // Filter out internal jobs
  const userVisibleJobs = allJobs.filter((job) => !INTERNAL_JOB_TYPES.has(job.type));

  // Organize jobs by status
  const runningJobs = userVisibleJobs.filter((j) => j.state === 'running');
  const failedJobs = userVisibleJobs.filter((j) => j.state === 'failed');
  const completedJobs = userVisibleJobs.filter((j) => j.state === 'completed').slice(0, 20);

  // Identify sweep status
  const sweepActive = identifyStats?.sweep?.state === 'running';
  const sweepCompleted = identifyStats?.sweep?.state === 'completed';

  // Format sweep summary
  const sweepSummary = identifyStats && identifyStats.sweep ? (() => {
    const { states, total } = identifyStats;
    if (sweepCompleted || (identifyStats.sweep.state !== 'running' && identifyStats.sweep.progress.done === identifyStats.sweep.progress.total)) {
      return `All ${total?.toLocaleString() || '—'} albums identified: ${states.matched?.toLocaleString() || '0'} matched, ${states.needsReview?.toLocaleString() || '0'} need review.`;
    }
    if (sweepActive) {
      const progress = identifyStats.sweep.progress;
      const pct = progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0;
      return `Identifying albums: ${progress.done?.toLocaleString() || '0'} of ${progress.total?.toLocaleString() || '—'} (${pct}%)`;
    }
    return `Identification idle: ${states.matched?.toLocaleString() || '0'} matched, ${states.needsReview?.toLocaleString() || '0'} need review.`;
  })() : null;

  // Is anything running or stuck?
  const isActivelyProcessing = runningJobs.length > 0 || sweepActive;
  const hasFailures = failedJobs.length > 0 || identifyStats?.queue.failed || 0 > 0;

  return (
    <div className={styles.container}>
      {isLoading ? (
        <div className={styles.loading}>Loading jobs...</div>
      ) : (
        <>
          {/* Status summary */}
          <section className={styles.summarySection}>
            {isActivelyProcessing && (
              <div className={`${styles.summaryCard} ${styles.summaryActive}`}>
                <div className={styles.summaryIcon}>⏱</div>
                <div className={styles.summaryContent}>
                  <h3 className={styles.summaryTitle}>Processing active</h3>
                  <p className={styles.summaryText}>
                    {runningJobs.length > 0 && `${runningJobs.length} job${runningJobs.length === 1 ? '' : 's'} running`}
                    {runningJobs.length > 0 && sweepActive && ' · '}
                    {sweepActive && 'Album identification running'}
                  </p>
                </div>
              </div>
            )}

            {hasFailures && (
              <div className={`${styles.summaryCard} ${styles.summaryWarning}`}>
                <div className={styles.summaryIcon}>⚠</div>
                <div className={styles.summaryContent}>
                  <h3 className={styles.summaryTitle}>Issues to review</h3>
                  <p className={styles.summaryText}>
                    {failedJobs.length > 0 && `${failedJobs.length} job${failedJobs.length === 1 ? '' : 's'} failed`}
                  </p>
                </div>
              </div>
            )}

            {!isActivelyProcessing && !hasFailures && (
              <div className={`${styles.summaryCard} ${styles.summaryIdle}`}>
                <div className={styles.summaryIcon}>✓</div>
                <div className={styles.summaryContent}>
                  <h3 className={styles.summaryTitle}>All caught up</h3>
                  <p className={styles.summaryText}>No active jobs or issues.</p>
                </div>
              </div>
            )}
          </section>

          {/* Identification sweep */}
          {identifyStats && identifyStats.sweep && (
            <section className={styles.section}>
              <h2 className={styles.sectionTitle}>Album identification</h2>
              <div className={styles.sweepCard}>
                <div className={styles.sweepHeader}>
                  <div className={styles.sweepInfo}>
                    <p className={styles.sweepStatus}>{sweepSummary}</p>
                  </div>
                  <span className={`${styles.badge} ${sweepActive ? styles.statusRunning : styles.statusCompleted}`}>
                    {sweepActive ? 'Running' : 'Idle'}
                  </span>
                </div>

                {sweepActive && (
                  <div className={styles.progress}>
                    <div
                      className={styles.progressBar}
                      role="progressbar"
                      aria-valuemin={0}
                      aria-valuemax={identifyStats.sweep.progress.total || 1}
                      aria-valuenow={identifyStats.sweep.progress.done || 0}
                    >
                      <div
                        className={styles.progressFill}
                        style={{
                          width: identifyStats.sweep.progress.total
                            ? `${((identifyStats.sweep.progress.done / identifyStats.sweep.progress.total) * 100) || 0}%`
                            : '0%',
                        }}
                      />
                    </div>
                  </div>
                )}

                <div className={styles.sweepActions}>
                  <button
                    className={styles.btn}
                    onClick={() => kickSweep.mutate()}
                    disabled={kickSweep.isPending || sweepActive}
                    title={sweepActive ? 'Identification is already running' : 'Start identification now'}
                  >
                    {kickSweep.isPending ? 'Starting...' : 'Start now'}
                  </button>
                  <Link to="/identify" className={styles.link}>
                    Review queue
                  </Link>
                </div>
              </div>
            </section>
          )}

          {/* Failed jobs */}
          {failedJobs.length > 0 && (
            <section className={styles.section}>
              <h2 className={styles.sectionTitle}>Failed jobs</h2>
              <div className={styles.tableWrapper}>
                <table className={styles.jobsTable}>
                  <thead>
                    <tr>
                      <th>Job</th>
                      <th>Error</th>
                      <th>When</th>
                      <th>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {failedJobs.map((job) => (
                      <tr
                        key={job.id}
                        className={`${styles.jobRow} ${focusJobId === job.id ? styles.highlighted : ''}`}
                      >
                        <td className={styles.jobNameCell}>
                          <div className={styles.jobName}>{getJobDescription(job)}</div>
                        </td>
                        <td className={styles.errorCell}>
                          {job.error ? (
                            <span className={styles.errorText} title={job.error}>
                              {job.error.substring(0, 60)}
                              {job.error.length > 60 ? '…' : ''}
                            </span>
                          ) : (
                            '—'
                          )}
                        </td>
                        <td className={styles.timeCell}>
                          {job.finishedAt ? formatRelativeTime(job.finishedAt) : '—'}
                        </td>
                        <td className={styles.actionsCell}>
                          <button
                            className={styles.actionBtn}
                            title="Clear this job"
                            onClick={() => cancelJob.mutate(job.id)}
                            disabled={cancelJob.isPending}
                          >
                            {cancelJob.isPending && cancelJob.variables === job.id ? 'Clearing...' : 'Clear'}
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          {/* Running jobs */}
          {runningJobs.length > 0 && (
            <section className={styles.section}>
              <h2 className={styles.sectionTitle}>Running jobs</h2>
              <div className={styles.tableWrapper}>
                <table className={styles.jobsTable}>
                  <thead>
                    <tr>
                      <th>Job</th>
                      <th>Progress</th>
                      <th>Duration</th>
                      <th>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {runningJobs.map((job) => (
                      <tr
                        key={job.id}
                        className={`${styles.jobRow} ${focusJobId === job.id ? styles.highlighted : ''}`}
                      >
                        <td className={styles.jobNameCell}>
                          <div className={styles.jobName}>{getJobDescription(job)}</div>
                        </td>
                        <td className={styles.progressCell}>
                          {job.progress && job.progress.total > 0 ? (
                            <div className={styles.inlineProgress}>
                              <div className={styles.progressBarInline}>
                                <div
                                  className={styles.progressFillInline}
                                  style={{
                                    width: `${Math.min((job.progress.done / job.progress.total) * 100, 100)}%`,
                                  }}
                                />
                              </div>
                              <span className={styles.progressLabel}>
                                {job.progress.done}/{job.progress.total}
                              </span>
                            </div>
                          ) : (
                            '—'
                          )}
                        </td>
                        <td className={styles.timeCell}>
                          {formatDuration(job.startedAt, job.finishedAt)}
                        </td>
                        <td className={styles.actionsCell}>
                          <button
                            className={styles.actionBtn}
                            title="Pause this job"
                            onClick={() => pauseJob.mutate(job.id)}
                            disabled={pauseJob.isPending}
                          >
                            {pauseJob.isPending && pauseJob.variables === job.id ? 'Pausing...' : 'Pause'}
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          {/* Completed jobs */}
          {completedJobs.length > 0 && (
            <section className={styles.section}>
              <h2 className={styles.sectionTitle}>Recent completed</h2>
              <div className={styles.tableWrapper}>
                <table className={styles.jobsTable}>
                  <thead>
                    <tr>
                      <th>Job</th>
                      <th>Completed</th>
                      <th>Duration</th>
                    </tr>
                  </thead>
                  <tbody>
                    {completedJobs.map((job) => (
                      <tr key={job.id} className={styles.jobRow}>
                        <td className={styles.jobNameCell}>
                          <div className={styles.jobName}>{getJobDescription(job)}</div>
                        </td>
                        <td className={styles.timeCell}>
                          {job.finishedAt ? formatRelativeTime(job.finishedAt) : '—'}
                        </td>
                        <td className={styles.timeCell}>
                          {formatDuration(job.startedAt, job.finishedAt)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          {/* Empty state */}
          {userVisibleJobs.length === 0 && !identifyStats?.sweep && (
            <div className={styles.emptyState}>
              <p>No jobs yet. Scans and identification will appear here.</p>
            </div>
          )}
        </>
      )}
    </div>
  );
}
