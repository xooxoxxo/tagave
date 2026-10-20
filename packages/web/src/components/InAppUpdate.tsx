/**
 * Settings › Updates with the opt-in updater: pick a release, confirm it is
 * you, and follow the run. The updater holds the run, so this view keeps
 * working while the app restarts (it polls and reconnects) and after a
 * reload. A successful run on the version the app now runs goes away on its
 * own (the api marks it settled); any other finished run stays until Done.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { ReleaseNote, StepUpMethod, UpdateRun, UpdateStall, UpdateStep, UpdaterSelfReplace, UpdaterView } from '@tagave/shared';
import { Button, Select, confirmDialog } from './ui';
import { StepUpDialog } from './StepUpDialog';
import { restartingOn, updaterKey, useStartUpdate, type SeenUpdaterView } from '../hooks/useUpdater';
import { getStepUp } from '../services/stepUp';
import { reloadIntoNewBuild } from '../services/buildCheck';
import { UpdateGlyph, type GlyphTone } from './update/UpdateGlyph';
import { runProgress } from './update/glyphPaint';
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
export function sentence(text: string | null | undefined): string {
  const t = (text ?? '').trim();
  if (!t) return '';
  const s = t[0]!.toUpperCase() + t.slice(1);
  return /[.!?]$/.test(s) ? s : `${s}.`;
}

export function clock(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function time(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export function useNow(active: boolean): number {
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

/** A step of an update or a module run. */
export type RunStepLike = Pick<UpdateStep, 'label' | 'status' | 'startedAt' | 'finishedAt'> & { id: string };

/** A line under a step: what it does now, why it is stuck, or why it failed. */
export interface StepNote {
  text: string;
  tone: 'live' | 'warn' | 'error';
  /** What to do, for a stall that needs the owner. */
  advice?: string | undefined;
}

/**
 * The steps with their marks and times; the roll back only once it ran.
 * Shared with Settings › Modules. `rolling`: only the steps that have
 * started, each rolling in as a new line when it starts (the update's run).
 * `notes`: a line under a step, by its id. `now`: the running step's clock.
 */
export function StepList({ run, rolling = false, notes = {}, now }: { run: { steps: RunStepLike[] }; rolling?: boolean; notes?: Record<string, StepNote>; now?: number }) {
  const steps = run.steps.filter((s) =>
    rolling ? s.status !== 'pending' && s.status !== 'skipped' : s.id !== 'rollback' || (s.status !== 'pending' && s.status !== 'skipped'),
  );
  return (
    <ol className={`${styles.steps} ${rolling ? styles.rolling : ''}`}>
      {steps.map((s) => {
        const note = notes[s.id];
        const time = s.startedAt && s.finishedAt
          ? clock(Date.parse(s.finishedAt) - Date.parse(s.startedAt))
          : s.status === 'running'
            ? s.startedAt && now !== undefined ? clock(now - Date.parse(s.startedAt)) : 'now'
            : '';
        return (
          <li key={s.id} className={styles[`step-${s.status}`]} aria-current={s.status === 'running' ? 'step' : undefined}>
            <span className={styles.mark} aria-hidden="true">{STEP_MARK[s.status]}</span>
            <span className={styles.stepLabel}>{s.label}</span>
            <span className={styles.stepTime}>{time}</span>
            <span className="visually-hidden">{s.status}</span>
            {note && (
              <span className={`${styles.stepNote} ${styles[`note-${note.tone}`]}`}>
                <span className={styles.noteText}>{note.text}</span>
                {note.advice && <span className={styles.noteAdvice}>{note.advice}</span>}
              </span>
            )}
          </li>
        );
      })}
    </ol>
  );
}

/** "waiting for the app: x" → "Waiting for the app: x": capitalised, no full stop added. */
export function detailText(text: string | null | undefined): string {
  const t = (text ?? '').trim().replace(/\.$/, '');
  return t ? t[0]!.toUpperCase() + t.slice(1) : '';
}

/**
 * The line under the running step: the stall when it has not moved
 * ("Stuck 3 min: …", with what to do when it needs the owner), else its
 * sub-state. Never the step's label again (updaters before 0.12.1 start a
 * step with its own label as the sub-state).
 */
export function runningNote(run: UpdateRun, step: RunStepLike, now: number): StepNote | null {
  const stall = run.stall ?? null;
  if (stall) {
    const min = Math.max(1, Math.round((now - Date.parse(stall.since)) / 60_000));
    // Patience-only causes keep the calm tone; the others need the owner.
    return { text: `Stuck ${min} min: ${detailText(stall.message)}`, tone: PATIENT.includes(stall.cause) ? 'live' : 'warn', advice: stall.advice };
  }
  const p = run.progress;
  if (!p || p.step !== step.id) return null;
  if (p.message.trim().toLowerCase() === step.label.trim().toLowerCase()) return null;
  return { text: detailText(p.message), tone: 'live' };
}

/** The run's log, folded away under its last line (which says what it waits for). */
export function RunLog({ log, preview }: { log: UpdateRun['log']; preview?: string | null }) {
  // `preview`: the line shown folded (null: none); by default the last one (Settings › Modules).
  const last = preview === undefined ? log.at(-1) : preview === null ? undefined : { message: preview };
  return (
    <details className={styles.log}>
      <summary>Log{last ? <span className={styles.lastLine}>{last.message}</span> : null}</summary>
      <pre className={styles.logText}>
        {log.map((l) => `${time(l.at)}  ${l.level === 'info' ? '' : `${l.level}: `}${l.message}`).join('\n')}
      </pre>
    </details>
  );
}

/** How long a finished update shows its success before this tab reloads into the new build. */
export const RELOAD_AFTER_UPDATE_MS = 2000;

/** How long a tab that watched the run shows "Updated to X" before a settled run goes (when it does not reload). */
export const SETTLED_SHOW_MS = 5000;

/**
 * The run this tab watched go from running to succeeded: after
 * RELOAD_AFTER_UPDATE_MS, reload into the new build (if the server runs one;
 * a dev bundle never reloads). Only a run seen running here counts, so the
 * reloaded page, which finds the run already finished, stays put.
 */
export function useReloadAfterUpdate(run: UpdateRun | null): { reloading: boolean; showing: string | null } {
  const watched = useRef<string | null>(null);
  const [succeeded, setSucceeded] = useState<string | null>(null);
  const [showing, setShowing] = useState<string | null>(null);
  const [reloading, setReloading] = useState(false);
  const id = run?.id ?? null;
  const status = run?.status ?? null;
  useEffect(() => {
    if (!id) return;
    if (status === 'running') watched.current = id;
    else if (status === 'succeeded' && watched.current === id) {
      watched.current = null;
      setSucceeded(id);
      setShowing(id);
    }
  }, [id, status]);
  useEffect(() => {
    if (!showing) return;
    const t = setTimeout(() => setShowing(null), SETTLED_SHOW_MS);
    return () => clearTimeout(t);
  }, [showing]);
  useEffect(() => {
    if (!succeeded) return;
    let cancelled = false;
    const started = Date.now();
    void reloadIntoNewBuild({
      reload: () => {
        if (cancelled) return;
        setReloading(true);
        setTimeout(() => { if (!cancelled) globalThis.location.reload(); }, Math.max(0, RELOAD_AFTER_UPDATE_MS - (Date.now() - started)));
      },
    });
    return () => { cancelled = true; };
  }, [succeeded]);
  return { reloading, showing };
}

/** The title of the api's 409 while the updater restarts itself (api routes/updater.ts). */
const RESTARTING_TITLE = 'Updater restarting';

/**
 * After the "Updater restarting" 409 and a fresh status: nothing to show when
 * the status carries the marker (the note says it); otherwise (the marker was
 * cleared meanwhile, or an older updater) the 409's own message, so a click
 * is never silent.
 */
export function restartConflictError(fresh: SeenUpdaterView | undefined, detail: string | undefined, now = Date.now()): string | null {
  if (restartingOn(fresh, now)) return null;
  return sentence(detail) || 'The update could not be started.';
}

/** Shown, with the Start button disabled, until the updater answers on the new version. */
function RestartingNote({ restart }: { restart: UpdaterSelfReplace }) {
  return (
    <p className={`${styles.note} ${styles.restarting}`} role="status">
      <span className={styles.spinner} aria-hidden="true" />
      Restarting the updater on {restart.expectedVersion}… Another update can start once it is back, in a minute or so.
    </p>
  );
}

/** Stalls that only ask for patience; the others need the owner. */
const PATIENT: ReadonlyArray<UpdateStall['cause']> = ['slow', 'db_recovering'];

/**
 * The folded log's preview line: none while the run runs (the step's own
 * line says what happens); after it, the last warning or error, unless a
 * step or the head already says it.
 */
export function logPreview(run: UpdateRun, notes: Record<string, StepNote>): string | null {
  if (run.status === 'running') return null;
  const last = [...run.log].reverse().find((l) => l.level !== 'info');
  if (!last) return null;
  const norm = (t: string) => t.trim().replace(/\.$/, '').toLowerCase();
  const shown = [...Object.values(notes).map((n) => n.text), run.reason ?? ''].map(norm).filter(Boolean);
  const line = norm(last.message);
  return shown.some((t) => t.includes(line) || line.includes(t)) ? null : last.message;
}

/** The glyph's tone for a run: the accent while it runs or once it succeeded, warn or danger once it failed. */
export function glyphTone(run: UpdateRun): GlyphTone {
  switch (run.status) {
    case 'running': return 'live';
    case 'succeeded': return 'ok';
    case 'rolled_back':
    case 'failed': return 'warn';
    default: return 'error';
  }
}

/**
 * The run, as the whole of Settings › Updates while it runs (and until Done
 * once it ended): the lava-lamp glyph across the pane, seeded by the version
 * and growing with the run, then the title and the time, the steps rolling
 * in, the log folded away. The section list beside it stays: the rest of
 * the app is usable until the restart.
 */
export function RunView({ run, reloading, restart, onDismiss, now: fixedNow, glyphTime }: {
  run: UpdateRun;
  /** The view could not be refreshed (the app is restarting): the running step says so. */
  disconnected?: boolean;
  reloading: boolean;
  restart: UpdaterSelfReplace | null;
  onDismiss: () => void;
  /** A fixed clock (stories, tests); else the browser's, ticking while the run runs. */
  now?: number;
  /** A fixed lamp clock (stories): the glyph holds still. */
  glyphTime?: number;
}) {
  const running = run.status === 'running';
  const ticking = useNow(running && fixedNow === undefined);
  const now = fixedNow ?? ticking;
  const elapsed = (run.finishedAt ? Date.parse(run.finishedAt) : now) - Date.parse(run.startedAt);
  const { head, notes } = runSummary(run, now);

  return (
    <section className={styles.takeover} aria-live="polite" aria-labelledby="update-run-title">
      <UpdateGlyph
        className={styles.glyph}
        seed={run.target}
        progress={runProgress(run, now)}
        tone={glyphTone(run)}
        moving={running}
        time={glyphTime}
        strength={2.2}
      />
      <div className={styles.run}>
        <header className={styles.runHead}>
          <h2 id="update-run-title" className={styles.runTitle}>
            <span className={head.short ? styles.long : undefined}>{head.title}</span>
            {head.short && <span className={styles.short}>{head.short}</span>}
          </h2>
          <span className={styles.elapsed} title="Elapsed">{clock(elapsed)}</span>
        </header>
        {head.body && <p className={styles.runBody}>{head.body}</p>}
        {reloading && <p className={styles.note}>Loading the new version…</p>}
        {restart && !running && <RestartingNote restart={restart} />}
        <StepList run={run} rolling notes={notes} now={now} />
        {run.backup && <p className={styles.note}>Backup from before the update: <code>{run.backup}</code></p>}
        <RunLog log={run.log} preview={logPreview(run, notes)} />
        {!running && (
          <div className={styles.row}>
            <Button variant="secondary" onClick={onDismiss}>Done</Button>
          </div>
        )}
      </div>
    </section>
  );
}

/** What the run's head says: its tone, its title and, when there is one, the line under it. */
export interface RunHead {
  tone: 'info' | 'ok' | 'warn' | 'error';
  title: string;
  /** a shorter title for a phone, where the long one would wrap to three lines */
  short?: string | undefined;
  body?: string | undefined;
}

/** The run's head and the one line under one step (shared by the run's views). */
export function runSummary(run: UpdateRun, now: number): { head: RunHead; notes: Record<string, StepNote> } {
  const running = run.status === 'running';
  const current = run.steps.find((s) => s.status === 'running');
  // One line under one step: the running step's sub-state (or its stall),
  // or, once the run ended, why the step that failed failed (the last one:
  // a failed roll back's reason names the first failure too).
  const notes: Record<string, StepNote> = {};
  const failedStep = running ? undefined : [...run.steps].reverse().find((s) => s.status === 'failed');
  if (running && current) {
    const note = runningNote(run, current, now);
    if (note) notes[current.id] = note;
  } else if (failedStep && run.reason) {
    notes[failedStep.id] = { text: detailText(run.reason), tone: 'error' };
  }
  // The reason under the step that failed; in the head only when no step carries it.
  const reason = failedStep ? '' : sentence(run.reason);

  let head: RunHead;
  switch (run.status) {
    case 'running':
      head = { tone: 'info', title: `Updating to ${run.target}`, body: run.steps.some((s) => s.status !== 'pending') ? undefined : 'Starting' };
      break;
    case 'succeeded':
      head = { tone: 'ok', title: `Updated to ${run.target}` };
      break;
    case 'rolled_back':
      head = {
        tone: 'warn',
        title: `The update to ${run.target} failed; tagave is back on ${run.rollback?.version ?? run.from}`,
        short: `Back on ${run.rollback?.version ?? run.from}`,
        body: `${reason ? `${reason} ` : ''}${run.rollback?.restoredDatabase ? 'The backup from before the update was restored.' : 'The database was not changed.'}`,
      };
      break;
    case 'failed':
      head = { tone: 'warn', title: `The update to ${run.target} did not start`, short: 'Did not start', body: reason || undefined };
      break;
    case 'rollback_failed':
      head = { tone: 'error', title: `The update to ${run.target} failed, and so did the roll back`, short: 'Roll back failed', body: reason || undefined };
      break;
    case 'interrupted':
    default:
      head = { tone: 'error', title: `The update to ${run.target} was cut off`, short: 'Cut off', body: reason || undefined };
  }
  return { head, notes };
}

/**
 * Whether the card shows the run: not once dismissed here, and not once the
 * api calls it settled (a success the app runs), except for a moment in the
 * tab that watched it finish (`showing`). Every other run stays until Done.
 */
export function showRun(run: UpdateRun, settled: boolean, dismissed: string | null, showing: string | null): boolean {
  if (run.id === dismissed) return false;
  if (settled && run.status === 'succeeded') return showing === run.id;
  return true;
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

/** The run Settings › Updates shows in place of the page (null: none), and what it needs. */
export interface ShownRun {
  run: UpdateRun | null;
  reloading: boolean;
  restart: UpdaterSelfReplace | null;
  dismiss: () => void;
}

/**
 * The run to show, if any (showRun): Settings › Updates turns into it while
 * it runs and until Done; a success the app runs clears itself. A run that
 * just finished changes what runs, so the version table is refreshed.
 */
export function useShownRun(view: SeenUpdaterView | undefined): ShownRun {
  const queryClient = useQueryClient();
  const run = view?.updater?.run ?? null;
  const [dismissed, setDismissed] = useState<string | null>(() => readDismissed());
  const { reloading, showing } = useReloadAfterUpdate(run);
  const finishedId = run && run.status !== 'running' ? run.id : null;
  useEffect(() => {
    if (finishedId) void queryClient.invalidateQueries({ queryKey: ['updates'] });
  }, [finishedId, queryClient]);
  const shown = run && showRun(run, !!view?.runSettled, dismissed, showing) ? run : null;
  return {
    run: shown,
    reloading,
    restart: restartingOn(view),
    dismiss: () => { if (run) { writeDismissed(run.id); setDismissed(run.id); } },
  };
}

/** Settings › Updates without a run on screen: pick a release, confirm it is you, start. */
export function InAppUpdate({ view, current, releases, confirmed, upToDate = false }: InAppUpdateProps) {
  const queryClient = useQueryClient();
  const start = useStartUpdate();
  const [picked, setPicked] = useState<string>(releases[0]?.version ?? '');
  const [stepUp, setStepUp] = useState<{ version: string; methods: StepUpMethod[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const versions = useMemo(() => releases.map((r) => r.version), [releases]);
  const restart = restartingOn(view);

  useEffect(() => {
    if (!versions.includes(picked)) setPicked(versions[0] ?? '');
  }, [versions, picked]);

  const go = async (version: string) => {
    setError(null);
    try {
      await start.mutateAsync(version);
    } catch (err) {
      const e = err as { status?: number; title?: string; detail?: string };
      if (e.status === 409 && e.title === RESTARTING_TITLE) {
        await queryClient.refetchQueries({ queryKey: updaterKey }).catch(() => undefined);
        setError(restartConflictError(queryClient.getQueryData<SeenUpdaterView>(updaterKey), e.detail));
      } else if (e.status === 403 && e.title === 'Step-up required') {
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
          <p>tagave is unavailable for a minute or two. If {picked} fails its health check, it goes back to {current}.</p>
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

  return (
    <div className={styles.idle}>
      {view.updater?.role === 'app' && (
        <p className={styles.note}>Split install: this updates this computer only. Then run <code>install-tagave.sh update</code> on the music computer.</p>
      )}
      {versions.length === 0 ? (
        <p className={styles.note}>{upToDate ? `Up to date · ${current}` : `Running ${current}`}</p>
      ) : (
        <>
          <div className={styles.row}>
            {versions.length > 1 && (
              <Select dense aria-label="Release to update to" value={picked} onChange={(e) => setPicked(e.target.value)} className={styles.select}>
                {versions.map((v, i) => <option key={v} value={v}>{v}{i === 0 ? ' (newest)' : ''}</option>)}
              </Select>
            )}
            <Button disabled={!confirmed || !picked || start.isPending || !!restart} loading={start.isPending} onClick={() => void begin()}>
              Update to {picked}
            </Button>
          </div>
          {!confirmed && <p className={styles.note}>Read the notes first</p>}
        </>
      )}
      {restart && <RestartingNote restart={restart} />}
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
