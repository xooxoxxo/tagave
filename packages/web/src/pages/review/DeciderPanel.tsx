/**
 * Library care › Autotagger, steps 1 and 2 and the strip above them:
 * the step strip (Decider · Run · Spot check · Accept), the decider step
 * (the local model with its held-out figures and Train again, or Jev with
 * its key, cap, spend and the payload that must be seen), and the run step
 * (population and Run; while it runs, its state, outcomes, spend and the
 * pause reason, with Resume and Cancel). Pure views: data and callbacks.
 */
import type { ReactNode } from 'react';
import { Button, SegmentedControl, Badge } from '../../components/ui';
import type { AutotaggerLibraryView, LocalModelsView, PayloadPreview, RunView } from '@tagave/shared';
import { PayloadPreviewView } from './PayloadPreview';
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
  /** Jev: the payload one album's run would send (the owner's) */
  preview?: PayloadPreview | null;
  previewOpen?: boolean;
  onTogglePreview?: () => void;
  onSeen?: () => void;
  seenPending?: boolean;
  /** the link to Settings › Modules › Autotagger (the owner's) */
  settings?: ReactNode;
}

const bandName = (band: string, min: number) => (band in BAND_LABEL ? BAND_LABEL[band as keyof typeof BAND_LABEL] : `≥ ${min}`);

export function DeciderStepView({ library, models, owner, training = false, onTrain, preview = null, previewOpen = false, onTogglePreview, onSeen, seenPending = false, settings = null }: DeciderStepViewProps) {
  if (library.config.decider === 'local') {
    const active = models?.active ?? null;
    return (
      <section className={styles.section} aria-label="Decider">
        <div className={styles.sectionHead}>
          <h3 className={styles.sectionTitle}>On this machine</h3>
          <div className={styles.actions}>
            {settings}
            {owner && <Button size="sm" variant="secondary" loading={training} onClick={onTrain}>{active ? 'Train again' : 'Train'}</Button>}
          </div>
        </div>
        {active ? (
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
                      <td>{b.errorRate === null ? '—' : percent(b.errorRate)}</td>
                      <td>{percent(b.errorUpper)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        ) : (
          <Values rows={[['Model', 'None'], ['Blocked by', 'No model']]} />
        )}
      </section>
    );
  }
  const seen = !!library.config.payloadSeenAt;
  const cap = library.config.monthlyCap;
  return (
    <section className={styles.section} aria-label="Decider">
      <div className={styles.sectionHead}>
        <h3 className={styles.sectionTitle}>Jev</h3>
        <div className={styles.actions}>{settings}</div>
      </div>
      <Values
        rows={[
          ['Key', library.keySet ? (library.keyHint ? `Set · ••••${library.keyHint}` : 'Set') : 'Not set'],
          ['Model', library.config.model],
          ['Monthly cap', cap === null ? 'No cap' : money(cap, library.currency)],
          ['Spent', money(library.spentThisMonth, library.currency)],
          ['Payload', seen ? 'Seen' : 'Not seen'],
        ]}
      />
      {owner && library.keySet && (
        <div className={styles.actions}>
          <Button size="sm" variant="secondary" aria-expanded={previewOpen} onClick={onTogglePreview}>Payload</Button>
          {previewOpen && preview && <Button size="sm" variant={seen ? 'secondary' : 'primary'} loading={seenPending} disabled={seen} onClick={onSeen}>{seen ? 'Seen ✓' : 'Seen'}</Button>}
        </div>
      )}
      {previewOpen && preview && <PayloadPreviewView preview={preview} />}
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
    rows.push(['Projected', run.projected === null ? '—' : money(run.projected, run.currency)]);
  }
  rows.push(['Started', shortDate(run.createdAt)]);
  return rows;
}

export function RunStepView({ run, owner, ready, population, onPopulation, onRun, onResume, onCancel, pending = {}, error = null }: RunStepViewProps) {
  const active = activeRun(run);
  return (
    <section className={styles.section} aria-label="Run">
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
