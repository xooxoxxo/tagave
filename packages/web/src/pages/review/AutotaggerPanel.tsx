/**
 * Library care › Autotagger (layout B · Steps): four steps across the top —
 * Decider, Run, Spot check, Accept — each a tile with its label and value
 * (done ✓, waiting, blocked by …); the current one is open below. The spot
 * check is the main event: a large card beside the Gates panel. Past runs
 * and batches sit behind a link; choosing a run there makes it the run of
 * steps 2 to 4.
 *
 * Step 1 is the owner's setup (AutotaggerSetup: the decider, its block, the
 * spot-check gate, Advanced, one Save); anyone else reads it. Step 2 holds
 * the owner's run stats, step 3 the decider's agreement under the gates.
 *
 * Shown only while the module is on (the modules rule: the tab has no Off
 * view; a link to it while off is sent on by Library care's tab gate), to
 * anyone who may edit the library; what only the owner does (set up, run,
 * resume, cancel, train, payload seen, accept) is hidden from the others.
 * `AutotaggerView` is the pure layout (stories and tests); `AutotaggerPanel`
 * wires it to the api.
 */
import { useMemo, useState, type ReactNode } from 'react';
import type {
  AcceptPreview, AgreementView as Agreement, AutotaggerLibraryView, AutotaggerModuleView, BandId, BandRow, BatchDetail, BatchSummary, DeciderPrice, LocalModelsView,
  RunView, SpotCheckItem,
} from '@tagave/shared';
import { DEFAULT_AUTOTAGGER_CONFIG } from '@tagave/shared';
import { Button, askFirst, confirmDialog } from '../../components/ui';
import { useStepUpAction } from '../../components/users/useStepUpAction';
import { useCan, useCurrentLibrary } from '../../hooks';
import { useModuleOn } from '../../hooks/useFacets';
import {
  useAcceptBand, useAcceptPreview, useAgreement, useAutotaggerLibrary, useAutotaggerModule, useBands, useCancelRun, useDeleteDeciderPrice, useDrawSpotChecks,
  useLocalModels, useMarkPayloadSeen, usePatchAutotaggerConfig, usePayloadPreview, useResumeRun, useRuns, useSetAutotaggerKey, useSetDeciderPrice,
  useSpotCheckVerdict, useSpotChecks, useStartRun, useTrainLocal,
} from '../../hooks/useAutotagger';
import { fasterPace, useBatch, useBatches, useSetEnrichPace, useUndoBatch } from '../../hooks/useBatches';
import { DeciderStepView, RunStepView, StepStripView } from './DeciderPanel';
import { SpotCheckCardView, type Verdict } from './SpotCheckView';
import { BandTableView, GatesPanelView } from './BandTable';
import { AcceptBandDialogView } from './AcceptBandDialog';
import { AgreementView } from './AgreementTables';
import { AutotaggerSetupView } from './AutotaggerSetup';
import { draftOf, patchOf, rebase, setupError, stillBad, type SetupDraft } from './autotaggerDraft';
import { BatchListView, RunListView } from './BatchList';
import { Values } from './autotaggerParts';
import { acceptableRun, deciderReady, defaultStep, stepTiles, type StartablePopulation, type StepId } from './autotaggerSteps';
import styles from './autotagger.module.css';

export interface AutotaggerViewProps {
  owner: boolean;
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
    run?: boolean; resume?: boolean; cancel?: boolean; train?: boolean; verdict?: boolean; draw?: BandId | null; accept?: boolean;
    undo?: string | null; drain?: boolean;
  };
  error?: string | null;
  /** step 1 as the owner sets it up (AutotaggerSetupView); without it, step 1 is read only */
  setup?: ReactNode;
  /** the module's runs and decisions, step 2 (the owner's) */
  stats?: AutotaggerModuleView | null;
  /** the decider's agreement with the owner, step 3 */
  agreement: Agreement | null;
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
      body = p.setup ?? (
        <DeciderStepView
          library={p.library}
          models={p.models}
          owner={p.owner}
          training={!!pending.train}
          onTrain={p.onTrain}
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
          stats={p.stats ?? null}
          spentOther={p.stats ? p.library.spentOther : []}
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
            {p.agreement && <AgreementView agreement={p.agreement} />}
            {pastLink}
          </div>
        </div>
      ) : (
        <>
          <Values rows={[['Spot check', 'Run first']]} />
          {p.agreement && <AgreementView agreement={p.agreement} />}
        </>
      );
      break;
    default:
      body = done && p.bands ? (
        accepting
          ? <BandTableView rows={p.bands} canAccept={p.owner} onDraw={p.onDraw} onAccept={p.onAcceptBand} drawing={pending.draw ?? null} />
          : <Values rows={[['Accept', 'Never'], ['Population', p.run?.population === 'backtest' ? 'Backtest' : 'Measure']]} />
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


/** An API error's detail, as the setup shows it. */
const setupErrorOf = (err: unknown): string => {
  const e = err as { detail?: string; title?: string } | null;
  return setupError(e?.detail ?? e?.title);
};

/** The Autotagger tab of Library care, wired to the api; nothing while the module is off. */
export function AutotaggerPanel() {
  const { libraryId } = useCurrentLibrary();
  const owner = useCan('system.manage');
  const enabled = useModuleOn('autotagger') === true;
  const library = useAutotaggerLibrary(libraryId, enabled);
  const models = useLocalModels(libraryId, enabled);
  const runs = useRuns(libraryId, enabled);
  const batches = useBatches(libraryId, enabled);
  // GET /settings/autotagger is system.manage: an editor never asks for it
  const mod = useAutotaggerModule(owner && enabled);
  const agreement = useAgreement(libraryId, enabled);

  const [step, setStep] = useState<StepId | null>(null);
  const [band, setBand] = useState<BandId>('p99');
  const [population, setPopulation] = useState<StartablePopulation>('needs_review');
  const [history, setHistory] = useState(false);
  const [runId, setRunId] = useState<string | null>(null);
  const [openBatch, setOpenBatch] = useState<string | null>(null);
  const [acceptBand, setAcceptBand] = useState<BandId | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [answered, setAnswered] = useState<ReadonlySet<string>>(() => new Set());

  // the setup's draft: from the saved settings, rebased when they change under it (a key Set keeps Jev chosen)
  const saved = library.data ?? null;
  const [draft, setDraft] = useState<SetupDraft | null>(() => (saved ? draftOf(saved) : null));
  const [base, setBase] = useState<AutotaggerLibraryView | null>(saved);
  // the field Save flagged: cleared once that field changes, by the person or by a rebase
  const [bad, setBad] = useState<keyof SetupDraft | null>(null);
  if (saved !== base) {
    const next = saved ? (draft && base ? rebase(draft, base, saved) : draftOf(saved)) : null;
    setBase(saved);
    setDraft(next);
    setBad(stillBad(bad, draft, next));
  }
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [setupErr, setSetupErr] = useState<string | null>(null);
  const [savedNow, setSavedNow] = useState(false);

  const items = runs.data?.items ?? [];
  const run = (runId ? items.find((r) => r.id === runId) : items[0]) ?? null;
  const done = run?.state === 'done' ? run.id : null;
  const bands = useBands(libraryId, done);
  const checks = useSpotChecks(libraryId, done, band);
  const check = useMemo(() => checks.data?.find((c) => !answered.has(c.id)) ?? null, [checks.data, answered]);
  // the request the saved settings make, while Jev is drafted and a key is stored
  const preview = usePayloadPreview(libraryId, owner && enabled && draft?.decider === 'jev' && !!saved?.keySet);
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
  const patch = usePatchAutotaggerConfig(libraryId);
  const setKey = useSetAutotaggerKey(libraryId);
  const setPrice = useSetDeciderPrice();
  const deletePrice = useDeleteDeciderPrice();
  const { run: stepUp, dialog } = useStepUpAction();

  if (!enabled) return null;

  const error = detailOf(start.error ?? resume.error ?? cancel.error ?? train.error ?? seen.error ?? draw.error ?? verdict.error ?? accept.error ?? undo.error ?? pace.error);
  const faster = acceptPreview.data ? fasterPace(acceptPreview.data.drain.limit) : null;

  const onUndo = async (batchId: string) => {
    const b = (batches.data?.items ?? []).find((x) => x.id === batchId);
    const cannot = batch.data?.id === batchId ? batch.data.cannotUndo : null;
    const ok = await confirmDialog({
      title: 'Undo this batch?',
      message: (
        <>
          {b && <p>{`Albums · ${b.counts.accepted}`}</p>}
          {cannot && <p>{`Cannot be undone · ${cannot.join(', ')}`}</p>}
        </>
      ),
      confirmLabel: 'Undo',
    });
    if (ok) undo.mutate(batchId);
  };

  /** Save: the one PATCH of what the draft changed (no step-up), or the field that is wrong. */
  const onSave = async () => {
    if (!saved || !draft) return;
    const r = patchOf(draft, saved);
    if ('field' in r) { setBad(r.field); return; }
    setBad(null);
    setSetupErr(null);
    if (Object.keys(r.patch).length === 0) return;
    try {
      const next = await patch.mutateAsync(r.patch);
      setDraft(draftOf(next));
      setSavedNow(true);
    } catch (e) {
      setSetupErr(setupErrorOf(e));
    }
  };
  /** The key (fresh step-up), Set, Replace or Forget; the draft is rebased, not reset. */
  const onKey = async (key: string | null) => {
    if (key === null && !(await askFirst('forgetJevKey'))) return;
    setSetupErr(null);
    setSavedNow(false);
    try {
      await stepUp(key === null ? 'Forgetting the key' : 'Setting the key', () => setKey.mutateAsync(key));
    } catch (e) {
      setSetupErr(setupErrorOf(e));
    }
  };
  /** A price, Add or Remove: its own instant action, never Save's and never the draft's. */
  const priceAction = async (fn: () => Promise<unknown>) => {
    setSetupErr(null);
    setSavedNow(false);
    try {
      await fn();
    } catch (e) {
      setSetupErr(setupErrorOf(e));
    }
  };

  const setup = !owner || mod.isError ? undefined : saved && draft && mod.data ? (
    <AutotaggerSetupView
      library={saved}
      module={mod.data}
      models={models.data ?? null}
      draft={draft}
      onDraft={(d) => { setBad(stillBad(bad, draft, d)); setDraft(d); setSavedNow(false); }}
      bad={bad}
      onSave={() => void onSave()}
      onKey={(k) => void onKey(k)}
      onPrice={(p: DeciderPrice) => void priceAction(() => setPrice.mutateAsync(p))}
      onDeletePrice={(model) => void priceAction(() => deletePrice.mutateAsync(model))}
      onTrain={() => train.mutate()}
      preview={preview.data ?? null}
      previewOpen={previewOpen}
      onTogglePreview={() => setPreviewOpen((o) => !o)}
      onSeen={() => seen.mutate()}
      advancedOpen={advancedOpen}
      onAdvanced={setAdvancedOpen}
      pending={{ save: patch.isPending, key: setKey.isPending, price: setPrice.isPending || deletePrice.isPending, train: train.isPending, seen: seen.isPending }}
      state={savedNow ? 'saved' : null}
      error={setupErr}
    />
  ) : <p className={styles.muted}>Loading…</p>;

  return (
    <>
      <AutotaggerView
        owner={owner}
        library={saved}
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
        onCancel={() => void (async () => { if (run && (await askFirst('cancelRun'))) cancel.mutate(run.id); })()}
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
          draw: draw.isPending ? draw.variables?.band ?? null : null, accept: accept.isPending,
          undo: undo.isPending ? undo.variables ?? null : null, drain: pace.isPending,
        }}
        error={error}
        setup={setup}
        stats={owner ? mod.data ?? null : null}
        agreement={agreement.data ?? null}
      />
      {dialog}
    </>
  );
}
