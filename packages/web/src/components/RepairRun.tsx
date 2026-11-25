/**
 * Settings › Updates › Repair: the updater checks every part of tagave and
 * fixes what it safely can. The run takes the pane like an update run
 * (InAppUpdate's takeover): the headline the updater wrote as the title, the
 * steps, the log folded away, and what was done behind "?". While it waits
 * for the music share nothing spins or moves: the updater checks the share
 * again on its own, and the "?" says when it last did.
 */
import { useState } from 'react';
import { useStartRepair } from '../hooks/useUpdater';
import type { UpdaterStatus } from '@tagave/shared';
// the repair types are not in the package's index yet: the updater subpath has them
import type { RepairRun as RepairRunData } from '@tagave/shared/updater';
import { Button, HelpToggle, sentence } from './ui';
import { RunLog, StepList, clock, detailText, runningNote, useNow, type RunStepLike, type StepNote } from './InAppUpdate';
import { UpdateGlyph, type GlyphTone } from './update/UpdateGlyph';
import styles from './InAppUpdate.module.css';
import own from './RepairRun.module.css';

/** The update run statuses after which a part may still not run. */
const NEEDS_REPAIR_AFTER = ['held', 'rollback_failed'];

/**
 * Whether Settings › Updates offers Repair: a part does not run, the last
 * update ended held or with a failed roll back, or a repair waits for the
 * music share.
 */
export function showRepair(status: UpdaterStatus | null): boolean {
  if (!status) return false;
  if (status.parts?.some((p) => p.state !== 'running')) return true;
  if (status.run && NEEDS_REPAIR_AFTER.includes(status.run.status)) return true;
  return status.repair?.status === 'waiting';
}

/** "Checked now" under a minute, then "Checked 2 min ago", "Checked 3 h ago". */
export function checkedLine(checkedAt: string, now: number): string {
  const s = Math.max(0, Math.round((now - Date.parse(checkedAt)) / 1000));
  if (s < 60) return 'Checked now';
  if (s < 3600) return `Checked ${Math.floor(s / 60)} min ago`;
  return `Checked ${Math.floor(s / 3600)} h ago`;
}

function tone(run: RepairRunData): GlyphTone {
  switch (run.status) {
    case 'running': return 'live';
    case 'repaired': return 'ok';
    case 'failed': return 'error';
    default: return 'warn';
  }
}

/** The title when the updater sent no headline (an older updater, or a run that just started). */
function fallbackTitle(run: RepairRunData): string {
  switch (run.status) {
    case 'running': return 'Repairing tagave';
    case 'repaired': return 'Repaired.';
    case 'waiting': return 'Waiting for the music share.';
    case 'needs_you': return sentence(run.reason) || 'tagave needs you to fix something, then press Repair.';
    default: return sentence(run.reason) || 'The repair could not finish.';
  }
}

/** How far the glyph has grown: the share of steps that ended. */
function progressOf(run: RepairRunData): number {
  if (run.status === 'repaired') return 1;
  const ended = run.steps.filter((s) => s.status === 'done' || s.status === 'skipped' || s.status === 'failed').length;
  return run.steps.length ? ended / run.steps.length : 0;
}

/** The repair as the whole of Settings › Updates while it runs, and until Done once it ended. */
export function RepairRunView({ run, onDismiss, now: fixedNow, glyphTime }: {
  run: RepairRunData;
  onDismiss: () => void;
  /** A fixed clock (stories, tests); else the browser's, ticking while the run runs. */
  now?: number;
  /** A fixed lamp clock (stories): the glyph holds still. */
  glyphTime?: number;
}) {
  const running = run.status === 'running';
  const waiting = run.status === 'waiting';
  const ticking = useNow(running && fixedNow === undefined);
  const now = fixedNow ?? ticking;
  const end = run.finishedAt ? Date.parse(run.finishedAt) : running ? now : null;

  // Waiting is not work in progress: the step it waits on is listed, but not as running.
  const steps: RunStepLike[] = waiting
    ? run.steps.map((s) => (s.status === 'running' ? { ...s, status: 'pending' } : s))
    : run.steps;
  const notes: Record<string, StepNote> = {};
  const current = running ? run.steps.find((s) => s.status === 'running') : undefined;
  const failedStep = running ? undefined : [...run.steps].reverse().find((s) => s.status === 'failed');
  if (current) {
    const note = runningNote(run, current, now);
    if (note) notes[current.id] = note;
  } else if (failedStep && run.reason && sentence(run.reason) !== run.headline) {
    notes[failedStep.id] = { text: detailText(run.reason), tone: 'error' };
  }

  const help = [...run.details, ...(waiting && run.checkedAt ? [checkedLine(run.checkedAt, now)] : [])];

  return (
    <section className={styles.takeover} aria-live="polite" aria-labelledby="repair-run-title" data-update-takeover="">
      <UpdateGlyph
        className={styles.glyph}
        seed="repair"
        progress={progressOf(run)}
        tone={tone(run)}
        moving={running}
        time={glyphTime}
        strength={2.2}
      />
      <div className={styles.run}>
        <header className={styles.runHead}>
          <div className={own.head}>
            <h2 id="repair-run-title" className={styles.runTitle}>{run.headline ?? fallbackTitle(run)}</h2>
            {help.length > 0 && (
              <HelpToggle label="Repair details">
                <ul className={own.details}>
                  {help.map((line, i) => <li key={i}>{line}</li>)}
                </ul>
              </HelpToggle>
            )}
          </div>
          {end !== null && <span className={styles.elapsed} title="Elapsed">{clock(end - Date.parse(run.startedAt))}</span>}
        </header>
        <StepList run={{ steps }} rolling={running} notes={notes} now={now} />
        <RunLog log={run.log} {...(running ? { preview: null } : {})} />
        {!running && (
          <div className={styles.row}>
            <Button variant="secondary" onClick={onDismiss}>Done</Button>
          </div>
        )}
      </div>
    </section>
  );
}

const DISMISSED_KEY = 'tagave-repair-run-dismissed';

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

/** The repair Settings › Updates shows in place of the page (null: none), until Done. */
export function useShownRepair(repair: RepairRunData | null | undefined): { run: RepairRunData | null; dismiss: () => void; reopen: () => void } {
  const [dismissed, setDismissed] = useState<string | null>(() => readDismissed());
  const run = repair && repair.id !== dismissed ? repair : null;
  return {
    run,
    dismiss: () => { if (repair) { writeDismissed(repair.id); setDismissed(repair.id); } },
    reopen: () => { writeDismissed(''); setDismissed(null); },
  };
}

/** One line in the "Running now" head's "?": shown whether or not the button is. */
export const REPAIR_HELP = 'Repair checks every part of tagave and fixes what it safely can.';

/**
 * Repair, in Running now. A repair that runs or waits for the share is
 * shown again rather than started a second time; otherwise it starts one
 * (`onShow` then brings its view up).
 */
export function RepairButton({ repair, onShow }: { repair: RepairRunData | null | undefined; onShow: () => void }) {
  const start = useStartRepair();
  const [error, setError] = useState<string | null>(null);
  const go = async () => {
    setError(null);
    if (repair?.status === 'running' || repair?.status === 'waiting') {
      onShow();
      return;
    }
    try {
      await start.mutateAsync();
      onShow();
    } catch (err) {
      const e = err as { title?: string; detail?: string };
      setError(sentence(e.detail ?? e.title) || 'The repair could not be started.');
    }
  };
  return (
    <div className={own.action}>
      <Button variant="secondary" disabled={start.isPending} loading={start.isPending} onClick={() => void go()}>Repair</Button>
      {error && <p className={styles.error} role="alert">{error}</p>}
    </div>
  );
}
