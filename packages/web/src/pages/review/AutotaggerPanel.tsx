/**
 * Library care › Autotagger (layout B · Steps): four steps across the top —
 * Decider, Run, Spot check, Accept — each a tile with its label and value
 * (done ✓, waiting, blocked by …); the current one is open below. The spot
 * check is the main event: a large card beside the Gates panel. Past runs
 * and batches sit behind a link; choosing a run there makes it the run of
 * steps 2 to 4.
 *
 * Shown while the module is on to anyone who may edit the library; what
 * only the owner does (run, resume, cancel, train, payload seen, accept)
 * is hidden from the others. `AutotaggerView` is the pure layout (stories
 * and tests); `AutotaggerPanel` wires it to the api.
 */
import { useMemo, useState, type ReactNode } from 'react';
import type {
  AcceptPreview, AutotaggerLibraryView, BandId, BandRow, BatchDetail, BatchSummary, LocalModelsView, PayloadPreview, RunView, SpotCheckItem,
} from '@tagave/shared';
import { DEFAULT_AUTOTAGGER_CONFIG } from '@tagave/shared';
import { Button, LinkButton, confirmDialog } from '../../components/ui';
import { useCan, useCurrentLibrary } from '../../hooks';
import { useModuleOn } from '../../hooks/useFacets';
import {
  useAcceptBand, useAcceptPreview, useAutotaggerLibrary, useBands, useCancelRun, useDrawSpotChecks, useLocalModels, useMarkPayloadSeen, usePayloadPreview,
  useResumeRun, useRuns, useSpotCheckVerdict, useSpotChecks, useStartRun, useTrainLocal,
} from '../../hooks/useAutotagger';
import { fasterPace, useBatch, useBatches, useSetEnrichPace, useUndoBatch } from '../../hooks/useBatches';
import { DeciderStepView, RunStepView, StepStripView } from './DeciderPanel';
import { SpotCheckCardView, type Verdict } from './SpotCheckView';
import { BandTableView, GatesPanelView } from './BandTable';
import { AcceptBandDialogView } from './AcceptBandDialog';
import { BatchListView, RunListView } from './BatchList';
import { Values } from './autotaggerParts';
import { acceptableRun, deciderReady, defaultStep, stepTiles, type StartablePopulation, type StepId } from './autotaggerSteps';
import styles from './autotagger.module.css';

export interface AutotaggerViewProps {
  owner: boolean;
  /** the module is on */
  enabled: boolean;
  library: AutotaggerLibraryView | null;
  models: LocalModelsView | null;
  /** the run of steps 2 to 4 */
  run: RunView | null;
  runs: RunView[];
  bands: BandRow[] | null;
  band: BandId;
  onBand: (band: BandId) => void;
  /** the spot check on the card: the band's first pending one */
  check: SpotCheckItem | null;
  coverUrl?: string | null;
  /** the step the viewer opened; null: the one the state points at */
  step: StepId | null;
  onStep: (step: StepId) => void;
  history: boolean;
  onHistory: (open: boolean) => void;
  population: StartablePopulation;
  onPopulation: (p: StartablePopulation) => void;
  preview?: PayloadPreview | null;
  previewOpen?: boolean;
  onTogglePreview?: () => void;
  onSeen?: () => void;
  batches: BatchSummary[];
  batchDetail?: BatchDetail | null;
  onOpenBatch?: (batchId: string | null) => void;
  /** the accept dialog, open while there is a preview */
  accept?: AcceptPreview | null;
  onAcceptBand: (band: BandId) => void;
  onConfirmAccept: () => void;
  onCancelAccept: () => void;
  onDrainFaster?: (() => void) | null;
  onRun: () => void;
  onResume: () => void;
  onCancel: () => void;
  onTrain: () => void;
  onVerdict: (verdict: Verdict) => void;
  onDraw: (band: BandId) => void;
  onUndo: (batchId: string) => void;
  onPickRun: (runId: string) => void;
  pending?: {
    run?: boolean; resume?: boolean; cancel?: boolean; train?: boolean; verdict?: boolean; draw?: BandId | null; accept?: boolean; seen?: boolean;
    undo?: string | null; drain?: boolean;
  };
  error?: string | null;
  /** the link to Settings › Modules › Autotagger (the owner's) */
  settings?: ReactNode;
  /** listen for C, W and U (off when a story shows more than one screen) */
  keys?: boolean;
}

export function AutotaggerView(p: AutotaggerViewProps) {
  const pending = p.pending ?? {};
  const maxErrorRate = p.library?.config.maxErrorRate ?? DEFAULT_AUTOTAGGER_CONFIG.maxErrorRate;
  const tiles = stepTiles({ library: p.library, models: p.models, run: p.run, bands: p.bands, band: p.band });
  const step = p.step ?? defaultStep(tiles);
  const ready = deciderReady({ library: p.library, models: p.models });
  const done = p.run?.state === 'done';
  const accepting = acceptableRun(p.run);

  if (!p.enabled) {
    return (
      <div className={styles.panel}>
        <Values rows={[['Autotagger', 'Off']]} />
        {p.settings}
      </div>
    );
  }
  if (!p.library) return <div className={styles.panel}><p className={styles.muted}>Loading…</p></div>;

  if (p.history) {
    return (
      <div className={styles.panel}>
        <div className={styles.sectionHead}>
          <h3 className={styles.sectionTitle}>Past runs</h3>
          <Button size="sm" variant="quiet" onClick={() => p.onHistory(false)}>Back to steps</Button>
        </div>
        <RunListView runs={p.runs} currentId={p.run?.id ?? null} onPick={(id) => { p.onPickRun(id); p.onHistory(false); }} />
        <h3 className={styles.sectionTitle}>Batches</h3>
        <BatchListView items={p.batches} detail={p.batchDetail ?? null} {...(p.onOpenBatch ? { onOpen: p.onOpenBatch } : {})} onUndo={p.onUndo} owner={p.owner} undoing={pending.undo ?? null} />
      </div>
    );
  }

  const pastLink = <Button size="sm" variant="quiet" onClick={() => p.onHistory(true)}>Past runs and batches</Button>;

  let body: ReactNode;
  switch (step) {
    case 'decider':
      body = (
        <DeciderStepView
          library={p.library}
          models={p.models}
          owner={p.owner}
          training={!!pending.train}
          onTrain={p.onTrain}
          preview={p.preview ?? null}
          previewOpen={!!p.previewOpen}
          {...(p.onTogglePreview ? { onTogglePreview: p.onTogglePreview } : {})}
          {...(p.onSeen ? { onSeen: p.onSeen } : {})}
          seenPending={!!pending.seen}
          settings={p.settings}
        />
      );
      break;
    case 'run':
      body = (
        <RunStepView
          run={p.run}
          owner={p.owner}
          ready={ready}
          population={p.population}
          onPopulation={p.onPopulation}
          onRun={p.onRun}
          onResume={p.onResume}
          onCancel={p.onCancel}
          pending={{ run: !!pending.run, resume: !!pending.resume, cancel: !!pending.cancel }}
        />
      );
      break;
    case 'check':
      body = done && p.bands ? (
        <div className={styles.stage}>
          <SpotCheckCardView
            band={p.band}
            bands={p.bands}
            onBand={p.onBand}
            item={p.check}
            coverUrl={p.coverUrl ?? null}
            onVerdict={p.onVerdict}
            onDraw={() => p.onDraw(p.band)}
            pending={!!pending.verdict}
            drawing={pending.draw === p.band}
            keys={p.keys ?? true}
          />
          <div className={styles.side}>
            <GatesPanelView rows={p.bands} maxErrorRate={maxErrorRate} canAccept={p.owner && accepting} onGoToAccept={() => p.onStep('accept')} />
            {pastLink}
          </div>
        </div>
      ) : <Values rows={[['Spot check', 'Run first']]} />;
      break;
    default:
      body = done && p.bands ? (
        accepting
          ? <BandTableView rows={p.bands} canAccept={p.owner} onDraw={p.onDraw} onAccept={p.onAcceptBand} drawing={pending.draw ?? null} />
          : <Values rows={[['Accept', 'Never'], ['Population', p.run ? p.run.population === 'backtest' ? 'Backtest' : 'Measure' : '—']]} />
      ) : <Values rows={[['Accept', 'Run first']]} />;
  }

  return (
    <div className={styles.panel}>
      <StepStripView tiles={tiles} current={step} onStep={p.onStep} />
      {body}
      {step !== 'check' && <div className={styles.actions}>{pastLink}</div>}
      {p.error && <p className={styles.error} role="alert">{p.error}</p>}
      {p.accept && (
        <AcceptBandDialogView
          preview={p.accept}
          onConfirm={p.onConfirmAccept}
          onCancel={p.onCancelAccept}
          onDrainFaster={p.onDrainFaster ?? null}
          confirming={!!pending.accept}
          draining={!!pending.drain}
        />
      )}
    </div>
  );
}

const detailOf = (err: unknown): string | null => {
  if (!err) return null;
  const e = err as { detail?: string; title?: string };
  return e.detail ?? e.title ?? 'Failed';
};

/** The Autotagger tab of Library care, wired to the api. */
export function AutotaggerPanel() {
  const { libraryId } = useCurrentLibrary();
  const owner = useCan('system.manage');
  const enabled = useModuleOn('autotagger') === true;
  const library = useAutotaggerLibrary(libraryId, enabled);
  const models = useLocalModels(libraryId, enabled);
  const runs = useRuns(libraryId, enabled);
  const batches = useBatches(libraryId, enabled);

  const [step, setStep] = useState<StepId | null>(null);
  const [band, setBand] = useState<BandId>('p99');
  const [population, setPopulation] = useState<StartablePopulation>('needs_review');
  const [history, setHistory] = useState(false);
  const [runId, setRunId] = useState<string | null>(null);
  const [openBatch, setOpenBatch] = useState<string | null>(null);
  const [acceptBand, setAcceptBand] = useState<BandId | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [answered, setAnswered] = useState<ReadonlySet<string>>(() => new Set());

  const items = runs.data?.items ?? [];
  const run = (runId ? items.find((r) => r.id === runId) : items[0]) ?? null;
  const done = run?.state === 'done' ? run.id : null;
  const bands = useBands(libraryId, done);
  const checks = useSpotChecks(libraryId, done, band);
  const check = useMemo(() => checks.data?.find((c) => !answered.has(c.id)) ?? null, [checks.data, answered]);
  const jev = library.data?.config.decider === 'jev';
  const preview = usePayloadPreview(libraryId, owner && enabled && jev && previewOpen && !!library.data?.keySet);
  const acceptPreview = useAcceptPreview(libraryId, done, owner ? acceptBand : null);
  const batch = useBatch(libraryId, openBatch);

  const start = useStartRun(libraryId);
  const resume = useResumeRun(libraryId);
  const cancel = useCancelRun(libraryId);
  const train = useTrainLocal(libraryId);
  const seen = useMarkPayloadSeen(libraryId);
  const draw = useDrawSpotChecks(libraryId, done);
  const verdict = useSpotCheckVerdict(libraryId, done);
  const accept = useAcceptBand(libraryId, done);
  const undo = useUndoBatch(libraryId);
  const pace = useSetEnrichPace(libraryId);

  const error = detailOf(start.error ?? resume.error ?? cancel.error ?? train.error ?? seen.error ?? draw.error ?? verdict.error ?? accept.error ?? undo.error ?? pace.error);
  const faster = acceptPreview.data ? fasterPace(acceptPreview.data.drain.limit) : null;

  const onUndo = async (batchId: string) => {
    const b = (batches.data?.items ?? []).find((x) => x.id === batchId);
    const cannot = batch.data?.id === batchId ? batch.data.cannotUndo : null;
    const ok = await confirmDialog({
      title: 'Undo this batch?',
      message: (
        <>
          <p>{`Albums · ${b ? b.counts.accepted : '—'}`}</p>
          {cannot && <p>{`Cannot be undone · ${cannot.join(', ')}`}</p>}
        </>
      ),
      confirmLabel: 'Undo',
    });
    if (ok) undo.mutate(batchId);
  };

  return (
    <>
      <AutotaggerView
        owner={owner}
        enabled={enabled}
        library={library.data ?? null}
        models={models.data ?? null}
        run={run}
        runs={items}
        bands={bands.data ?? null}
        band={band}
        onBand={(b) => { setBand(b); setStep('check'); }}
        check={check}
        coverUrl={check ? `/api/v1/images/album/${check.album.id}` : null}
        step={step}
        onStep={setStep}
        history={history}
        onHistory={setHistory}
        population={population}
        onPopulation={setPopulation}
        preview={preview.data ?? null}
        previewOpen={previewOpen}
        onTogglePreview={() => setPreviewOpen((o) => !o)}
        onSeen={() => seen.mutate()}
        batches={batches.data?.items ?? []}
        batchDetail={batch.data ?? null}
        onOpenBatch={setOpenBatch}
        accept={acceptBand ? acceptPreview.data ?? null : null}
        onAcceptBand={setAcceptBand}
        onConfirmAccept={() => { if (acceptBand) accept.mutate(acceptBand, { onSuccess: () => setAcceptBand(null) }); }}
        onCancelAccept={() => setAcceptBand(null)}
        onDrainFaster={owner && faster ? () => pace.mutate(faster) : null}
        onRun={() => start.mutate({ population }, { onSuccess: (r) => { setRunId(r.id); setStep('run'); } })}
        onResume={() => { if (run) resume.mutate(run.id); }}
        onCancel={() => { if (run) cancel.mutate(run.id); }}
        onTrain={() => train.mutate()}
        onVerdict={(v) => {
          if (!check) return;
          const id = check.id;
          setAnswered((s) => new Set(s).add(id));
          verdict.mutate({ checkId: id, band: check.band, verdict: v }, {
            onError: () => setAnswered((s) => { const n = new Set(s); n.delete(id); return n; }),
          });
        }}
        onDraw={(b) => draw.mutate({ band: b, count: 25 })}
        onUndo={(id) => void onUndo(id)}
        onPickRun={(id) => { setRunId(id); setStep(null); setAnswered(new Set()); }}
        pending={{
          run: start.isPending, resume: resume.isPending, cancel: cancel.isPending, train: train.isPending, verdict: false,
          draw: draw.isPending ? draw.variables?.band ?? null : null, accept: accept.isPending, seen: seen.isPending,
          undo: undo.isPending ? undo.variables ?? null : null, drain: pace.isPending,
        }}
        error={error}
        settings={owner ? <LinkButton to="/settings/modules/$module" params={{ module: 'autotagger' }} variant="quiet" size="sm">Settings</LinkButton> : null}
      />
    </>
  );
}
