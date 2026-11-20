/**
 * Library care › Autotagger, steps 1 and 2 and the strip above them:
 * the step strip (Decider · Run · Spot check · Accept), the decider step
 * as read (the local model with its held-out figures and Train again, or
 * Jev with its key, cap, spend and whether the payload was seen; the
 * owner's step 1 is the setup, AutotaggerSetup, where the payload is shown), and the run step (the
 * owner's run stats; population and Run; while it runs, its state,
 * outcomes, spend and the pause reason, with Resume and Cancel). Pure
 * views: data and callbacks.
 */
import type { ReactNode } from 'react';
import { Button, SegmentedControl, Badge } from '../../components/ui';
import type { AutotaggerLibraryView, LocalModelsView, RunView } from '@tagave/shared';
import { Values } from './autotaggerParts';
import {
  BAND_LABEL, OUTCOME_LABEL, POPULATION_LABEL, STARTABLE_POPULATIONS, count, decided, modelName, money, pauseLabel, percent, runStateLabel, shortDate,
  type StartablePopulation, type StepId, type StepTile,
} from './autotaggerSteps';
import styles from './autotagger.module.css';

/* ---------- the strip ---------- */

export function StepStripView({ tiles, current, onStep }: { tiles: StepTile[]; current: StepId; onStep: (id: StepId) => void }) {
  return (
    <ol className={styles.steps} aria-label="Steps">
      {tiles.map((t) => (
        <li key={t.id}>
          <button
            type="button"
            className={styles.step}
            data-status={t.status}
            aria-current={t.id === current ? 'step' : undefined}
            onClick={() => onStep(t.id)}
          >
            <span className={styles.stepTitle}>{t.title}</span>
            <span className={styles.stepValue}>{t.value}</span>
            {t.sub && <span className={styles.stepSub}>{t.sub}</span>}
          </button>
        </li>
      ))}
    </ol>
  );
}

/* ---------- 1 · Decider ---------- */

export interface DeciderStepViewProps {
  library: AutotaggerLibraryView;
  models: LocalModelsView | null;
  owner: boolean;
  training?: boolean;
  onTrain: () => void;
}

const bandName = (band: string, min: number) => (band in BAND_LABEL ? BAND_LABEL[band as keyof typeof BAND_LABEL] : `≥ ${min}`);

/** The local model: its figures and its held-out bands, or that there is none yet. */
export function LocalModelBlock({ models }: { models: LocalModelsView | null }) {
  const active = models?.active ?? null;
  if (!active) return <Values rows={[['Model', 'None'], ['Blocked by', 'No model']]} />;
  return (
    <>
      <Values
        label="Active model"
        rows={[
          ['Model', modelName(models)],
          ['Version', active.version],
          ['Trained', shortDate(active.createdAt)],
          ['Decisions', count(active.counts.albums)],
          ['Yours', count(active.counts.owner)],
          ['Automatic', count(active.counts.auto)],
          ['Top pick right', percent(active.metrics.topPickRight.rate)],
        ]}
      />
      <div className={styles.figuresWrap}>
        <table className={styles.figures} aria-label="Held out">
          <thead><tr><th scope="col">Band</th><th scope="col">Decided</th><th scope="col">Coverage</th><th scope="col">Error rate</th><th scope="col">Upper bound</th></tr></thead>
          <tbody>
            {active.metrics.bands.map((b) => (
              <tr key={b.band}>
                <td>{bandName(b.band, b.min)}</td>
                <td>{count(b.decided)}</td>
                <td>{percent(b.coverage)}</td>
                <td>{b.errorRate === null ? '' : percent(b.errorRate)}</td>
                <td>{percent(b.errorUpper)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

export function DeciderStepView({ library, models, owner, training = false, onTrain }: DeciderStepViewProps) {
  if (library.config.decider === 'local') {
    const active = models?.active ?? null;
    return (
      <section className={styles.section} aria-label="Decider">
        <div className={styles.sectionHead}>
          <h3 className={styles.sectionTitle}>On this machine</h3>
          <div className={styles.actions}>
            {owner && <Button size="sm" variant="secondary" loading={training} onClick={onTrain}>{active ? 'Train again' : 'Train'}</Button>}
          </div>
        </div>
        <LocalModelBlock models={models} />
      </section>
    );
  }
  const seen = !!library.config.payloadSeenAt;
  const cap = library.config.monthlyCap;
  return (
    <section className={styles.section} aria-label="Decider">
      <div className={styles.sectionHead}>
        <h3 className={styles.sectionTitle}>Jev</h3>
      </div>
      <Values
        rows={[
          ['Jev key', library.keySet ? (owner && library.keyHint ? `Set · ••••${library.keyHint}` : 'Set') : 'Not set'],
          ['Model', library.config.model],
          ['Monthly cap', cap === null ? 'No cap' : money(cap, library.currency)],
          ['Spent', money(library.spentThisMonth, library.currency)],
          ['Payload', seen ? 'Seen' : 'Not seen'],
        ]}
      />
    </section>
  );
}

/* ---------- 2 · Run ---------- */

export interface RunStepViewProps {
  run: RunView | null;
  owner: boolean;
  /** the decider can run now; when not, what blocks it */
  ready: { ready: boolean; blocker: string | null };
  population: StartablePopulation;
  onPopulation: (p: StartablePopulation) => void;
  onRun: () => void;
  onResume: () => void;
  onCancel: () => void;
  pending?: { run?: boolean; resume?: boolean; cancel?: boolean };
  error?: string | null;
  /** the module's runs and decisions (the owner's: GET /settings/autotagger is system.manage) */
  stats?: { runs: number; decisions: number } | null;
  /** this month's spend in another currency than the cap's */
  spentOther?: Array<{ currency: string; amount: number }>;
}

const activeRun = (run: RunView | null) => !!run && (run.state === 'queued' || run.state === 'running' || run.state === 'paused');

/** A run's figures: state, albums decided, outcomes, spend. */
export function runRows(run: RunView): Array<[string, ReactNode]> {
  const paid = run.deciderId !== 'local';
  const rows: Array<[string, ReactNode]> = [
    ['State', run.state === 'paused' ? <Badge tone="warning">{`Paused · ${pauseLabel(run.pauseReason)}`}</Badge> : runStateLabel(run.state)],
    ['Population', POPULATION_LABEL[run.population]],
    ['Decider', run.modelLabel],
    ['Albums', run.state === 'done' ? count(run.albums) : `${count(decided(run))} of ${count(run.albums)}`],
  ];
  for (const [outcome, n] of Object.entries(run.outcomes)) if (n > 0) rows.push([OUTCOME_LABEL[outcome] ?? outcome, count(n)]);
  if (paid) {
    rows.push(['Spent', money(run.spent, run.currency)]);
    if (run.projected !== null) rows.push(['Projected', money(run.projected, run.currency)]);
  }
  rows.push(['Started', shortDate(run.createdAt)]);
  return rows;
}

export function RunStepView({ run, owner, ready, population, onPopulation, onRun, onResume, onCancel, pending = {}, error = null, stats = null, spentOther = [] }: RunStepViewProps) {
  const active = activeRun(run);
  return (
    <section className={styles.section} aria-label="Run">
      {stats && (
        <Values
          rows={[
            ['Runs', count(stats.runs)],
            ['Decisions', count(stats.decisions)],
            ...spentOther.map((x) => [`Spent · ${x.currency}`, money(x.amount, x.currency)] as [string, string]),
          ]}
        />
      )}
      {run && (
        <>
          <div className={styles.sectionHead}>
            <h3 className={styles.sectionTitle}>{active ? 'This run' : 'Last run'}</h3>
            {owner && active && (
              <div className={styles.actions}>
                {run.state === 'paused' && <Button size="sm" variant="primary" loading={!!pending.resume} onClick={onResume}>Resume</Button>}
                <Button size="sm" variant="quiet-danger" loading={!!pending.cancel} onClick={onCancel}>Cancel</Button>
              </div>
            )}
          </div>
          <Values label="Run" rows={runRows(run)} />
        </>
      )}
      {owner && !active && (
        <>
          <div className={styles.sectionHead}>
            <h3 className={styles.sectionTitle}>New run</h3>
          </div>
          <SegmentedControl
            label="Population"
            value={population}
            onChange={onPopulation}
            options={STARTABLE_POPULATIONS.map((p) => ({ value: p, label: POPULATION_LABEL[p] }))}
          />
          <div className={styles.actions}>
            <Button variant="primary" disabled={!ready.ready} loading={!!pending.run} onClick={onRun}>Run</Button>
            {!ready.ready && ready.blocker && <span className={styles.muted}>Blocked by · {ready.blocker}</span>}
          </div>
        </>
      )}
      {!owner && !run && <Values rows={[['Run', 'None']]} />}
      {error && <p className={styles.error} role="alert">{error}</p>}
    </section>
  );
}
