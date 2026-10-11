/**
 * Settings › Updates with the opt-in updater: pick a release, confirm it is
 * you, and follow the run. The updater holds the run, so this view keeps
 * working while the app restarts (it polls and reconnects) and after a
 * reload. A finished run stays on screen until the owner dismisses it.
 */
import { useEffect, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { ReleaseNote, StepUpMethod, UpdateRun, UpdateStep, UpdaterView } from '@liner/shared';
import { Button, Select, confirmDialog } from './ui';
import { StepUpDialog } from './StepUpDialog';
import { useStartUpdate } from '../hooks/useUpdater';
import { getStepUp } from '../services/stepUp';
import styles from './InAppUpdate.module.css';

const DISMISSED_KEY = 'tagave-update-run-dismissed';

function readDismissed(): string | null {
  try {
    return localStorage.getItem(DISMISSED_KEY);
  } catch {
    return null;
  }
}

function writeDismissed(id: string): void {
  try {
    localStorage.setItem(DISMISSED_KEY, id);
  } catch {
    /* private window: the run just stays on screen */
  }
}

/** "the app did not answer" → "The app did not answer." */
function sentence(text: string | null | undefined): string {
  const t = (text ?? '').trim();
  if (!t) return '';
  const s = t[0]!.toUpperCase() + t.slice(1);
  return /[.!?]$/.test(s) ? s : `${s}.`;
}

function clock(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function time(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active]);
  return now;
}

const STEP_MARK: Record<UpdateStep['status'], string> = {
  pending: '',
  running: '',
  done: '✓',
  failed: '✕',
  skipped: '–',
};

function StepList({ run }: { run: UpdateRun }) {
  const steps = run.steps.filter((s) => s.id !== 'rollback' || (s.status !== 'pending' && s.status !== 'skipped'));
  return (
    <ol className={styles.steps}>
      {steps.map((s) => (
        <li key={s.id} className={styles[`step-${s.status}`]} aria-current={s.status === 'running' ? 'step' : undefined}>
          <span className={styles.mark} aria-hidden="true">{STEP_MARK[s.status]}</span>
          <span className={styles.stepLabel}>{s.label}</span>
          <span className={styles.stepTime}>
            {s.startedAt && s.finishedAt ? clock(Date.parse(s.finishedAt) - Date.parse(s.startedAt)) : s.status === 'running' ? 'now' : ''}
          </span>
          <span className="visually-hidden">{s.status}</span>
        </li>
      ))}
    </ol>
  );
}

function RunView({ run, disconnected, onDismiss }: { run: UpdateRun; disconnected: boolean; onDismiss: () => void }) {
  const running = run.status === 'running';
  const now = useNow(running);
  const elapsed = (run.finishedAt ? Date.parse(run.finishedAt) : now) - Date.parse(run.startedAt);
  const current = run.steps.find((s) => s.status === 'running');
  const last = run.log.at(-1);

  let head: { tone: 'info' | 'ok' | 'warn' | 'error'; title: string; body?: string | undefined };
  switch (run.status) {
    case 'running':
      head = { tone: 'info', title: `Updating to ${run.target}`, body: current ? `${current.label}…` : 'Starting…' };
      break;
    case 'succeeded':
      head = { tone: 'ok', title: `Updated to ${run.target}`, body: 'Every part reports healthy.' };
      break;
    case 'rolled_back':
      head = {
        tone: 'warn',
        title: `The update to ${run.target} failed; tagave is back on ${run.rollback?.version ?? run.from}`,
        body: `${sentence(run.reason)}${run.rollback?.restoredDatabase ? ' The new version had changed the database, so the backup from before the update was restored.' : ' The database was not changed.'}`,
      };
      break;
    case 'failed':
      head = { tone: 'warn', title: `The update to ${run.target} did not start`, body: sentence(run.reason) };
      break;
    case 'rollback_failed':
      head = { tone: 'error', title: `The update to ${run.target} failed, and so did the roll back`, body: sentence(run.reason) };
      break;
    case 'interrupted':
    default:
      head = { tone: 'error', title: `The update to ${run.target} was cut off`, body: sentence(run.reason) };
  }

  return (
    <div className={styles.run} aria-live="polite">
      <div className={`${styles.runHead} ${styles[`tone-${head.tone}`]}`}>
        <div>
          <p className={styles.runTitle}>
            {running && <span className={styles.spinner} aria-hidden="true" />}
            {head.title}
          </p>
          {head.body && <p className={styles.runBody}>{head.body}</p>}
        </div>
        <span className={styles.elapsed} title="Elapsed">{clock(elapsed)}</span>
      </div>
      {disconnected && running && (
        <p className={styles.note}>tagave is restarting. This page reconnects on its own.</p>
      )}
      <StepList run={run} />
      {run.backup && <p className={styles.note}>Backup from before the update: <code>{run.backup}</code></p>}
      <details className={styles.log}>
        <summary>Log{last ? <span className={styles.lastLine}>{last.message}</span> : null}</summary>
        <pre className={styles.logText}>
          {run.log.map((l) => `${time(l.at)}  ${l.level === 'info' ? '' : `${l.level}: `}${l.message}`).join('\n')}
        </pre>
      </details>
      {!running && (
        <div className={styles.row}>
          <Button size="sm" variant="secondary" onClick={onDismiss}>Done</Button>
        </div>
      )}
    </div>
  );
}

export interface InAppUpdateProps {
  view: UpdaterView;
  /** The view could not be refreshed (the app is restarting). */
  disconnected: boolean;
  current: string;
  releases: ReleaseNote[];
  /** The requires-attention notes have been read (or there are none). */
  confirmed: boolean;
  /** A release check ran and found nothing newer. */
  upToDate?: boolean;
}

export function InAppUpdate({ view, disconnected, current, releases, confirmed, upToDate = false }: InAppUpdateProps) {
  const queryClient = useQueryClient();
  const start = useStartUpdate();
  const run = view.updater?.run ?? null;
  const [dismissed, setDismissed] = useState<string | null>(() => readDismissed());
  const [picked, setPicked] = useState<string>(releases[0]?.version ?? '');
  const [stepUp, setStepUp] = useState<{ version: string; methods: StepUpMethod[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const versions = useMemo(() => releases.map((r) => r.version), [releases]);

  useEffect(() => {
    if (!versions.includes(picked)) setPicked(versions[0] ?? '');
  }, [versions, picked]);

  // A run that just finished changes what runs: refresh the version table.
  const finishedId = run && run.status !== 'running' ? run.id : null;
  useEffect(() => {
    if (finishedId) void queryClient.invalidateQueries({ queryKey: ['updates'] });
  }, [finishedId, queryClient]);

  const go = async (version: string) => {
    setError(null);
    try {
      await start.mutateAsync(version);
      setDismissed(null);
    } catch (err) {
      const e = err as { status?: number; title?: string; detail?: string };
      if (e.status === 403 && e.title === 'Step-up required') {
        const s = await getStepUp();
        setStepUp({ version, methods: s.methods });
      } else {
        setError(e.detail ?? e.title ?? 'The update could not be started.');
      }
    }
  };

  const begin = async () => {
    if (!picked) return;
    const ok = await confirmDialog({
      title: `Update to ${picked}?`,
      message: (
        <>
          <p>The updater backs up the database, switches this install to {picked} and restarts tagave. It is unavailable for a minute or two.</p>
          <p>If {picked} does not come up healthy, the updater goes back to {current} and restores the backup when the database was changed.</p>
        </>
      ),
      confirmLabel: `Update to ${picked}`,
    });
    if (!ok) return;
    try {
      const s = await getStepUp();
      if (!s.fresh) {
        setStepUp({ version: picked, methods: s.methods });
        return;
      }
    } catch {
      /* the server decides anyway */
    }
    await go(picked);
  };

  if (run && run.id !== dismissed) {
    return (
      <RunView
        run={run}
        disconnected={disconnected}
        onDismiss={() => { writeDismissed(run.id); setDismissed(run.id); }}
      />
    );
  }

  return (
    <div className={styles.idle}>
      {view.updater?.role === 'app' && (
        <p className={styles.note}>Split install: this updates this computer only. Then run <code>install-tagave.sh update</code> on the music computer.</p>
      )}
      {versions.length === 0 ? (
        <p className={styles.note}>{upToDate ? `Up to date: ${current}.` : `You run ${current}. No newer release is known.`}</p>
      ) : (
        <>
          <div className={styles.row}>
            {versions.length > 1 && (
              <Select dense aria-label="Release to update to" value={picked} onChange={(e) => setPicked(e.target.value)} className={styles.select}>
                {versions.map((v, i) => <option key={v} value={v}>{v}{i === 0 ? ' (newest)' : ''}</option>)}
              </Select>
            )}
            <Button disabled={!confirmed || !picked || start.isPending} loading={start.isPending} onClick={() => void begin()}>
              Update to {picked}
            </Button>
          </div>
          <p className={styles.note}>Backs up the database, restarts tagave and goes back to {current} if the new version fails its health check.</p>
          {!confirmed && <p className={styles.note}>Tick the box above first.</p>}
        </>
      )}
      {error && <p className={styles.error} role="alert">{error}</p>}
      {stepUp && (
        <StepUpDialog
          action={`Updating to ${stepUp.version}`}
          methods={stepUp.methods}
          onCancel={() => setStepUp(null)}
          onDone={() => { const v = stepUp.version; setStepUp(null); void go(v); }}
        />
      )}
    </div>
  );
}
