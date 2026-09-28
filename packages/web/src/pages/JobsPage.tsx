/**
 * Background activity (Settings › Background activity).
 *
 * Summary first: is anything running, does anything need the owner. Then
 * album identification in plain numbers with a way into the review queue,
 * then the tasks that failed (with the error and a retry), then a compact
 * list of recent work. Worker heartbeats never show; scheduled checks that
 * ran as expected stay folded away. `?job=<id>` highlights one task.
 */
import { useEffect, useState, type ReactNode } from 'react';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import type { JobView } from '@liner/shared';
import { useCurrentLibrary, useIdentifyStats, useKickSweep, useJobs, useRetryJob } from '../hooks';
import type { IdentifyStatsResponse } from '../hooks';
import { Badge, Banner, Button, LinkButton, Table, Th, Td, type BadgeTone } from '../components/ui';
import { formatEta, formatRelativeTime } from '../utils/time';
import styles from './JobsPage.module.css';

const n = (v: number) => v.toLocaleString('en-US');
const plural = (count: number, one: string, many = `${one}s`) => `${n(count)} ${count === 1 ? one : many}`;

function statusBadge(job: JobView): { tone: BadgeTone; text: string } {
  if (job.resolvedAt) return { tone: 'neutral', text: 'Fixed later' };
  if (job.retrying) return { tone: 'info', text: 'Retrying' };
  if ((job.status === 'failed' || job.status === 'interrupted') && !job.needsAttention) return { tone: 'neutral', text: 'Tried again' };
  switch (job.status) {
    case 'running': return { tone: 'info', text: 'Running' };
    case 'waiting': return { tone: 'neutral', text: 'Waiting' };
    case 'done': return { tone: 'success', text: 'Done' };
    case 'failed': return { tone: 'danger', text: 'Failed' };
    case 'interrupted': return { tone: 'warning', text: 'Stopped' };
    case 'cancelled': return { tone: 'neutral', text: 'Cancelled' };
  }
}

function problemMessage(err: unknown): string {
  const e = err as { detail?: string; title?: string } | null;
  return e?.detail || e?.title || 'Something went wrong. Try again in a moment.';
}

export function JobsPage() {
  const { libraryId } = useCurrentLibrary();
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as { job?: unknown };
  const focusId = typeof search.job === 'string' && search.job ? search.job : undefined;
  const [showRoutine, setShowRoutine] = useState(false);

  const { data: stats } = useIdentifyStats(libraryId);
  const { data: jobs, isLoading, isError } = useJobs(libraryId, { includeRoutine: showRoutine, job: focusId });
  const retry = useRetryJob(libraryId);
  const [retryNote, setRetryNote] = useState<Record<string, string>>({});

  // Bring the linked task into view once it has rendered.
  useEffect(() => {
    if (!focusId || !jobs) return;
    document.getElementById(`job-${focusId}`)?.scrollIntoView({ block: 'center' });
  }, [focusId, jobs]);

  if (!libraryId || isLoading) return <p className={styles.muted}>Loading activity…</p>;
  if (isError || !jobs) return <Banner tone="danger">Could not load background activity. Reload the page to try again.</Banner>;

  const all = jobs.data;
  const attention = all.filter((j) => j.needsAttention);
  // what is happening now first, then newest first (the API order)
  const live = (j: JobView) => (j.status === 'running' || j.status === 'waiting' ? 0 : 1);
  const recent = all.filter((j) => !j.needsAttention).sort((a, b) => live(a) - live(b));
  const focusMissing = focusId !== undefined && !all.some((j) => j.id === focusId);
  const clearFocus = () => void navigate({ to: '/settings/$section', params: { section: 'activity' }, search: {} });

  const onRetry = (job: JobView) => {
    setRetryNote((m) => ({ ...m, [job.id]: '' }));
    retry.mutate(job.id, {
      onSuccess: (res) => setRetryNote((m) => ({ ...m, [job.id]: res.queued ? 'Started again.' : 'Already queued; it will start soon.' })),
      onError: (err) => setRetryNote((m) => ({ ...m, [job.id]: problemMessage(err) })),
    });
  };

  return (
    <div className={styles.page}>
      <Summary summary={jobs.summary} running={all.filter((j) => j.status === 'running')} />

      {focusMissing && (
        <Banner tone="warning">
          The task from your link is not in the activity list any more.{' '}
          <button type="button" className={styles.inlineLink} onClick={clearFocus}>Show everything</button>
        </Banner>
      )}

      {stats && <Identification stats={stats} libraryId={libraryId} />}

      {attention.length > 0 && (
        <section className={styles.section} aria-labelledby="jobs-attention">
          <h3 id="jobs-attention" className={styles.sectionTitle}>Needs your attention</h3>
          <JobTable
            jobs={attention}
            focusId={focusId}
            action={(job) => (
              <div className={styles.actionCell}>
                {job.retryable ? (
                  <Button size="sm" variant="secondary" onClick={() => onRetry(job)}
                    loading={retry.isPending && retry.variables === job.id}>
                    Retry
                  </Button>
                ) : (
                  <span className={styles.muted}>Can't be restarted here</span>
                )}
                {retryNote[job.id] && <span className={styles.note} role="status">{retryNote[job.id]}</span>}
              </div>
            )}
          />
        </section>
      )}

      <section className={styles.section} aria-labelledby="jobs-recent">
        <div className={styles.sectionHead}>
          <h3 id="jobs-recent" className={styles.sectionTitle}>Recent activity</h3>
          {(showRoutine || jobs.summary.routineHidden > 0) && (
            <Button size="sm" variant="ghost" onClick={() => setShowRoutine((v) => !v)} aria-pressed={showRoutine}>
              {showRoutine ? 'Hide routine entries' : `Show ${plural(jobs.summary.routineHidden, 'hidden entry', 'hidden entries')}`}
            </Button>
          )}
        </div>
        {!showRoutine && jobs.summary.routineHidden > 0 && (
          <p className={styles.hint}>Hidden: scheduled checks that ran as expected, and old failures a later run fixed.</p>
        )}
        {recent.length > 0 ? (
          <JobTable jobs={recent} focusId={focusId} />
        ) : (
          <p className={styles.muted}>Nothing else has run in the last 30 days.</p>
        )}
      </section>
    </div>
  );
}

function Summary({ summary, running }: { summary: { running: number; waiting: number; needsAttention: number; lastFinishedAt: string | null }; running: JobView[] }) {
  if (summary.needsAttention > 0) {
    return (
      <Banner tone="danger">
        <strong>{plural(summary.needsAttention, 'task')} {summary.needsAttention === 1 ? 'needs' : 'need'} your attention.</strong>{' '}
        See what went wrong below and retry once it is fixed.
      </Banner>
    );
  }
  if (summary.running > 0 || summary.waiting > 0) {
    const names = running.map((j) => j.label).slice(0, 3).join(', ');
    return (
      <Banner tone="info">
        <strong>Working.</strong>{' '}
        {names ? `${names}${running.length > 3 ? ' and more' : ''}.` : ''}
        {summary.waiting > 0 ? ` ${plural(summary.waiting, 'task')} waiting to start.` : ''}
      </Banner>
    );
  }
  return (
    <Banner tone="success">
      <strong>All caught up.</strong>{' '}
      {summary.lastFinishedAt ? `Nothing is running; the last task finished ${formatRelativeTime(summary.lastFinishedAt)}.` : 'Nothing is running.'}
    </Banner>
  );
}

function Identification({ stats, libraryId }: { stats: IdentifyStatsResponse; libraryId: string }) {
  const kick = useKickSweep(libraryId);
  const { states, total, rate, etaSeconds, sweep } = stats;
  const running = sweep?.state === 'running';
  const done = sweep?.progress.done ?? 0;
  const sweepTotal = sweep?.progress.total || total;
  const pct = running && sweepTotal > 0 ? Math.min(100, Math.round((done / sweepTotal) * 100)) : 0;
  const finishedAt = !running ? sweep?.finishedAt ?? null : null;

  if (total === 0) return null;

  return (
    <section className={styles.card} aria-labelledby="jobs-identify">
      <div className={styles.cardHead}>
        <h3 id="jobs-identify" className={styles.sectionTitle}>Album identification</h3>
        <Badge tone={running ? 'info' : 'success'}>{running ? 'Running' : 'Finished'}</Badge>
      </div>

      {running ? (
        <>
          <p className={styles.lead}>Checking your albums: {n(done)} of {n(sweepTotal)} done ({pct}%).</p>
          <div className={styles.bar} role="progressbar" aria-valuemin={0} aria-valuemax={sweepTotal} aria-valuenow={done} aria-label="Albums checked">
            <div className={styles.barFill} style={{ width: `${pct}%` }} />
          </div>
          {rate.perMin > 0 && (
            <p className={styles.hint}>
              About {plural(Math.round(rate.perMin), 'album')} a minute
              {etaSeconds && etaSeconds > 0 ? `, done in ${formatEta(etaSeconds).replace('~', 'about ')}` : ''}.
            </p>
          )}
        </>
      ) : (
        <p className={styles.lead}>
          {states.pending > 0
            ? `${plural(states.pending, 'album')} still waiting to be checked.`
            : `All ${plural(total, 'album')} have been checked${finishedAt ? ` (finished ${formatRelativeTime(finishedAt)})` : ''}.`}
        </p>
      )}

      <dl className={styles.counts}>
        <div><dt>Identified</dt><dd>{n(states.matched)}</dd></div>
        <div><dt>Need your review</dt><dd>{n(states.needsReview)}</dd></div>
        <div><dt>No match found</dt><dd>{n(states.unidentified)}</dd></div>
      </dl>

      <div className={styles.actions}>
        {states.needsReview > 0 && (
          <LinkButton to="/work" search={{ tab: 'review' }} size="sm">Review {plural(states.needsReview, 'match', 'matches')}</LinkButton>
        )}
        {states.unidentified > 0 && (
          <LinkButton to="/work" search={{ tab: 'identify' }} size="sm" variant="secondary">See albums with no match</LinkButton>
        )}
        {!running && states.pending > 0 && (
          <Button size="sm" variant="secondary" onClick={() => kick.mutate()} loading={kick.isPending} disabled={kick.isSuccess}>
            {kick.isSuccess ? 'Started' : 'Check waiting albums now'}
          </Button>
        )}
      </div>
      {kick.isError && <p className={styles.error} role="alert">{problemMessage(kick.error)}</p>}
    </section>
  );
}

function JobTable({ jobs, focusId, action }: { jobs: JobView[]; focusId: string | undefined; action?: (job: JobView) => ReactNode }) {
  return (
    <Table className={styles.table}>
      <thead>
        <tr>
          <Th>Task</Th>
          <Th>Status</Th>
          <Th>When</Th>
          {action && <Th><span className={styles.srOnly}>Action</span></Th>}
        </tr>
      </thead>
      <tbody>
        {jobs.map((job) => {
          const badge = statusBadge(job);
          return (
            <tr key={job.id} id={`job-${job.id}`} className={[styles.row, job.id === focusId ? styles.focused : ''].filter(Boolean).join(' ')}
              aria-current={job.id === focusId ? 'true' : undefined}>
              <Td className={styles.taskCell}>
                <div className={styles.task}>
                  <span className={styles.taskName}>{job.label}</span>
                  {job.summary && <span className={styles.taskSummary}>{job.summary}</span>}
                  {job.progress && (
                    <span className={styles.miniBar} aria-hidden="true">
                      <span style={{ width: `${Math.round((job.progress.done / job.progress.total) * 100)}%` }} />
                    </span>
                  )}
                  {job.error && !job.resolvedAt && <span className={styles.errorText} title={job.error}>{job.error}</span>}
                </div>
              </Td>
              <Td className={styles.statusCell}><Badge tone={badge.tone}>{badge.text}</Badge></Td>
              <Td className={styles.whenCell}>
                <Link to="/settings/$section" params={{ section: 'activity' }} search={{ job: job.id }} className={styles.whenLink}
                  title={`${new Date(job.at).toLocaleString()} (link to this task)`}>
                  {formatRelativeTime(job.at)}
                </Link>
              </Td>
              {action && <Td className={styles.actionTd}>{action(job)}</Td>}
            </tr>
          );
        })}
      </tbody>
    </Table>
  );
}
