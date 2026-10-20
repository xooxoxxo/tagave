/**
 * PREVIEWS (rr41, phase 1): two directions for the update's run, built on
 * the run's real data (runSummary, StepList, RunLog) and the short albums'
 * ripple contours (UpdateGlyph).
 *
 * A "Takeover": the owner's tab turns into a full-pane view while the run
 * runs (TakeoverView); everyone else gets a slim strip (UpdateStrip), and
 * while the app is down a full-screen glyph (UpdateDownScreen).
 * B "Card": the run stays in Settings › Updates as a hero card with the glyph
 * as its art (UpdateHeroCard); everyone else gets only the down screen.
 */
import type { ReactNode } from 'react';
import type { UpdateRun } from '@tagave/shared';
import { Button } from '../ui';
import { RunLog, StepList, clock, logPreview, runSummary } from '../InAppUpdate';
import { UpdateGlyph, type GlyphTone } from './UpdateGlyph';
import { runProgress } from './glyphPaint';
import styles from './UpdateViews.module.css';

export function glyphTone(run: UpdateRun): GlyphTone {
  switch (run.status) {
    case 'running': return 'live';
    case 'succeeded': return 'ok';
    case 'rolled_back':
    case 'failed': return 'warn';
    default: return 'error';
  }
}

interface RunViewProps {
  run: UpdateRun;
  now: number;
  onDismiss: () => void;
  /** a fixed glyph phase (stories) */
  phase?: number | undefined;
}

function elapsedOf(run: UpdateRun, now: number): string {
  return clock((run.finishedAt ? Date.parse(run.finishedAt) : now) - Date.parse(run.startedAt));
}

/** A: the owner's pane while the run runs (and until Done once it ended). */
export function TakeoverView({ run, now, onDismiss, phase }: RunViewProps) {
  const { head, notes } = runSummary(run, now);
  const running = run.status === 'running';
  return (
    <section className={styles.takeover} aria-live="polite" aria-labelledby="update-title">
      <UpdateGlyph
        className={styles.takeoverGlyph}
        seed={run.target}
        progress={runProgress(run, now)}
        tone={glyphTone(run)}
        moving={running}
        phase={phase}
        strength={2.2}
      />
      <div className={styles.takeoverColumn}>
        <header className={styles.takeoverHead}>
          <h1 id="update-title" className={styles.takeoverTitle}>{head.title}</h1>
          <span className={styles.elapsed} title="Elapsed">{elapsedOf(run, now)}</span>
        </header>
        {head.body && <p className={styles.body}>{head.body}</p>}
        <StepList run={run} rolling notes={notes} now={now} />
        <RunLog log={run.log} preview={logPreview(run, notes)} />
        {!running && (
          <div className={styles.actions}>
            <Button variant="secondary" onClick={onDismiss}>Done</Button>
          </div>
        )}
      </div>
    </section>
  );
}

/** A: everyone else while the app still serves: a slim strip over the page, the glyph as its ground. */
export function UpdateStrip({ target, progress, phase }: { target: string; progress: number; phase?: number | undefined }) {
  return (
    <div className={styles.strip} role="status">
      <UpdateGlyph className={styles.stripGlyph} seed={target} progress={Math.max(0.6, progress)} phase={phase} strength={1.6} step={3} />
      <span className={styles.stripText}>Updating · back in a minute</span>
    </div>
  );
}

/**
 * Both: everyone else while the app is down (restart). The page is still
 * loaded, so this is an overlay over it, not a navigation: the player keeps
 * its row (`player`) and plays what it has loaded. It lifts when the app
 * answers again.
 */
export function UpdateDownScreen({ target, progress, phase, player }: { target: string; progress: number; phase?: number | undefined; player?: ReactNode }) {
  return (
    <div className={styles.down} role="status" aria-live="polite">
      <UpdateGlyph className={styles.downGlyph} seed={target} progress={progress} phase={phase} strength={1.35} />
      <div className={styles.downText}>
        <p className={styles.downTitle}>Updating</p>
        <p className={styles.downVersion}>{target}</p>
      </div>
      {player && <div className={styles.downPlayer}>{player}</div>}
    </div>
  );
}

/** B: the run in Settings › Updates as a hero card, the glyph as its art. */
export function UpdateHeroCard({ run, now, onDismiss, phase }: RunViewProps) {
  const { head, notes } = runSummary(run, now);
  const running = run.status === 'running';
  return (
    <section className={styles.card} aria-live="polite" aria-labelledby="update-card-title">
      <div className={styles.cardArt}>
        <UpdateGlyph
          className={styles.cardGlyph}
          seed={run.target}
          progress={runProgress(run, now)}
          tone={glyphTone(run)}
          moving={running}
          phase={phase}
          strength={1.6}
        />
        <span className={styles.cardVersion} aria-hidden="true">{run.target}</span>
      </div>
      <div className={styles.cardBody}>
        <header className={styles.cardHead}>
          <h3 id="update-card-title" className={styles.cardTitle}>{head.title}</h3>
          <span className={styles.elapsed} title="Elapsed">{elapsedOf(run, now)}</span>
        </header>
        {head.body && <p className={styles.body}>{head.body}</p>}
        <StepList run={run} rolling notes={notes} now={now} />
        <RunLog log={run.log} preview={logPreview(run, notes)} />
        {!running && (
          <div className={styles.actions}>
            <Button size="sm" variant="secondary" onClick={onDismiss}>Done</Button>
          </div>
        )}
      </div>
    </section>
  );
}
