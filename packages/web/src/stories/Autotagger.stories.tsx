import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import type { AutotaggerModuleView, BandId } from '@tagave/shared';
import { AutotaggerView, type AutotaggerViewProps } from '../pages/review/AutotaggerPanel';
import { AutotaggerSetupView } from '../pages/review/AutotaggerSetup';
import { draftOf, type SetupDraft } from '../pages/review/autotaggerDraft';
import { ProvenanceLine } from '../components/ProvenanceLine';
import type { StartablePopulation, StepId } from '../pages/review/autotaggerSteps';
import { COVER_SRC } from './fixtures';
import {
  ACCEPT_PREVIEW, AGREEMENT, BANDS, BANDS_ACCEPTED, BANDS_CLOSED, BATCH_ACCEPTED, BATCH_DETAIL, BATCH_UNDONE, CHECK, CHECK_STALE, HAND_MATCH, LIBRARY_JEV,
  LIBRARY_LOCAL, LIBRARY_NO_KEY, LIBRARY_NOT_SEEN, MODEL_MATCH, MODELS, MODULE, MODULE_NO_PRICES, MODULE_PRICE_EUR, NO_MODELS, PAYLOAD, RULE_MATCH, RUN_BACKTEST, RUN_DONE, RUN_RUNNING, RUN_WEAK,
  runPaused,
} from './autotaggerFixtures';

const noop = () => undefined;

type ScreenProps = Partial<AutotaggerViewProps> & {
  /** the setup's prices and run stats (the owner's) */
  module?: AutotaggerModuleView;
  /** what the owner has drafted over the saved settings */
  draft?: Partial<SetupDraft>;
  advancedOpen?: boolean;
};

/** Step 1 as the owner sets it up: the draft and Advanced switch in the story. */
function Setup({ p }: { p: ScreenProps }) {
  const library = p.library ?? LIBRARY_LOCAL;
  const [draft, setDraft] = useState<SetupDraft>(() => ({ ...draftOf(library), ...p.draft }));
  const [advancedOpen, setAdvancedOpen] = useState(p.advancedOpen ?? false);
  const [previewOpen, setPreviewOpen] = useState(p.previewOpen ?? false);
  return (
    <AutotaggerSetupView
      library={library}
      module={p.module ?? MODULE}
      models={p.models ?? MODELS}
      draft={draft}
      onDraft={setDraft}
      onSave={noop}
      onKey={noop}
      onPrice={noop}
      onDeletePrice={noop}
      onTrain={noop}
      preview={p.preview ?? null}
      previewOpen={previewOpen}
      onTogglePreview={() => setPreviewOpen((o) => !o)}
      onSeen={noop}
      advancedOpen={advancedOpen}
      onAdvanced={setAdvancedOpen}
    />
  );
}

/** The Autotagger tab with the fixtures; the step, band, population and the past-runs view switch in the story. */
function Screen({ module, draft, advancedOpen, ...props }: ScreenProps) {
  const [step, setStep] = useState<StepId | null>(props.step ?? null);
  const [band, setBand] = useState<BandId>(props.band ?? 'p97');
  const [population, setPopulation] = useState<StartablePopulation>(props.population ?? 'needs_review');
  const [history, setHistory] = useState(props.history ?? false);
  const [openBatch, setOpenBatch] = useState<string | null>(props.batchDetail?.id ?? null);
  const owner = props.owner ?? true;
  return (
    <AutotaggerView
      owner
      agreement={null}
      setup={owner ? <Setup p={{ ...props, ...(module ? { module } : {}), ...(draft ? { draft } : {}), ...(advancedOpen !== undefined ? { advancedOpen } : {}) }} /> : undefined}
      library={LIBRARY_LOCAL}
      models={MODELS}
      run={RUN_DONE}
      runs={[RUN_DONE, RUN_BACKTEST, RUN_WEAK]}
      bands={BANDS}
      check={CHECK}
      coverUrl={COVER_SRC}
      batches={[BATCH_ACCEPTED, BATCH_UNDONE]}
      onAcceptBand={noop}
      onConfirmAccept={noop}
      onCancelAccept={noop}
      onRun={noop}
      onResume={noop}
      onCancel={noop}
      onTrain={noop}
      onVerdict={noop}
      onDraw={noop}
      onUndo={noop}
      onPickRun={noop}
      onTogglePreview={noop}
      onSeen={noop}
      {...props}
      step={step}
      onStep={setStep}
      band={band}
      onBand={setBand}
      population={population}
      onPopulation={setPopulation}
      history={history}
      onHistory={setHistory}
      batchDetail={openBatch === props.batchDetail?.id ? props.batchDetail ?? null : null}
      onOpenBatch={setOpenBatch}
    />
  );
}

const meta = {
  title: 'Library care/Autotagger',
  component: Screen,
  parameters: {
    docs: {
      description: {
        component: 'Library care › Autotagger (layout B · Steps): Decider, Run, Spot check and Accept across the top, the open step below. The spot check is a large card beside the Gates panel; Past runs and batches sit behind a link. Pure view with fixtures; AutotaggerPanel wires it to the api.',
      },
    },
  },
  decorators: [(Story) => <div style={{ maxWidth: 1100, padding: 16 }}><Story /></div>],
} satisfies Meta<typeof Screen>;
export default meta;
type Story = StoryObj<typeof meta>;

/** tags inline on each story: the indexer reads them statically */
const phone: Pick<Story, 'globals'> = { globals: { viewport: { value: 'phone' } } };

/** The main event: a pending check of the 97% band beside the gates (99% open). */
export const SpotCheck: Story = {};
export const SpotCheckStale: Story = { args: { check: CHECK_STALE } };
/** No check waiting in the band: Check 25. */
export const SpotCheckDone: Story = { args: { band: 'p95', check: null } };
/** Nothing checked far enough: every gate shut, no Go to Accept. */
export const GatesClosed: Story = { args: { bands: BANDS_CLOSED, band: 'p99' } };
/** An editor: the same card and gates, no Go to Accept. */
export const Editor: Story = { args: { owner: false } };

export const DeciderLocal: Story = { args: { step: 'decider' } };
export const DeciderNoModel: Story = { args: { step: 'decider', models: NO_MODELS, run: null, runs: [], bands: null } };
export const DeciderNoKey: Story = { args: { step: 'decider', library: LIBRARY_NO_KEY, run: null, runs: [], bands: null } };
export const DeciderPayloadNotSeen: Story = { args: { step: 'decider', library: LIBRARY_NOT_SEEN, run: null, runs: [], bands: null, preview: PAYLOAD, previewOpen: true } };
export const DeciderJev: Story = { args: { step: 'decider', library: LIBRARY_JEV } };

export const RunNew: Story = { args: { step: 'run', run: null, runs: [], bands: null } };
export const RunBlocked: Story = { args: { step: 'run', library: LIBRARY_NOT_SEEN, run: null, runs: [], bands: null } };
export const Running: Story = { args: { library: LIBRARY_JEV, run: RUN_RUNNING, runs: [RUN_RUNNING], bands: null } };
export const PausedModuleOff: Story = { args: { library: LIBRARY_JEV, run: runPaused('module_off'), bands: null } };
export const PausedNoKey: Story = { args: { library: LIBRARY_JEV, run: runPaused('no_key'), bands: null } };
export const PausedNoCap: Story = { args: { library: LIBRARY_JEV, run: runPaused('no_cap'), bands: null } };
export const PausedNoPrice: Story = { args: { library: LIBRARY_JEV, run: runPaused('no_price'), bands: null } };
export const PausedCapReached: Story = { args: { library: LIBRARY_JEV, run: runPaused('cap_reached'), bands: null } };
export const PausedKeyRefused: Story = { args: { library: LIBRARY_JEV, run: runPaused('key_refused'), bands: null } };
export const PausedQuestionChanged: Story = { args: { library: LIBRARY_JEV, run: runPaused('spec_changed'), bands: null } };
export const RunDone: Story = { args: { step: 'run' } };

/** Step 4 with p99 open: Accept band for the owner, Check 25 on the closed bands. */
export const AcceptOpen: Story = { args: { step: 'accept' } };
export const AcceptAfterBatch: Story = { args: { step: 'accept', bands: BANDS_ACCEPTED } };
export const AcceptBacktest: Story = { args: { step: 'accept', run: RUN_BACKTEST } };
/** The accept dialog: the batch, what cannot be undone, the nights and Drain faster. */
export const AcceptDialog: Story = { tags: ['shot-viewport'], args: { step: 'accept', accept: ACCEPT_PREVIEW, onDrainFaster: noop } };

/** Past runs and batches: an undone rule batch open, with albums left as they were. */
export const PastRunsAndBatches: Story = { args: { history: true, batchDetail: BATCH_DETAIL } };

export const PhoneSpotCheck: Story = { ...phone, tags: ['phone', 'shot-full'] };
export const PhoneGatesOpen: Story = { ...phone, tags: ['phone', 'shot-full'], args: { step: 'accept' } };
export const PhoneRunning: Story = { ...phone, tags: ['phone', 'shot-full'], args: { library: LIBRARY_JEV, run: runPaused('cap_reached'), bands: null } };
export const PhoneAcceptDialog: Story = { tags: ['phone'], globals: { viewport: { value: 'phone' } }, args: { step: 'accept', accept: ACCEPT_PREVIEW, onDrainFaster: noop } };
export const PhoneBatches: Story = { ...phone, tags: ['phone', 'shot-full'], args: { history: true, batchDetail: BATCH_DETAIL } };

/** Step 1, the owner's setup: the decider, its block, the spot-check gate, Advanced, one Save. */
export const SetupLocal: Story = { tags: ['no-shot'], args: { step: 'decider', run: null, runs: [], bands: null } };
/** Jev with its key set and the payload seen. */
export const SetupJev: Story = { tags: ['no-shot'], args: { step: 'decider', library: LIBRARY_JEV } };
/** Jev drafted over a saved local library with no key: Save waits for the key. */
export const SetupJevNoKey: Story = { tags: ['no-shot'], args: { step: 'decider', run: null, runs: [], bands: null, draft: { decider: 'jev' } } };
/** A model with no price: Price needed in the Jev block. */
export const SetupPriceNeeded: Story = { tags: ['no-shot'], args: { step: 'decider', library: LIBRARY_JEV, module: MODULE_NO_PRICES } };
/** The only price in another currency than the cap's. */
export const SetupPriceOtherCurrency: Story = { tags: ['no-shot'], args: { step: 'decider', library: LIBRARY_JEV, module: MODULE_PRICE_EUR } };
export const SetupAdvanced: Story = { tags: ['no-shot'], args: { step: 'decider', library: LIBRARY_JEV, advancedOpen: true } };
export const SetupPayloadNotSeen: Story = { tags: ['no-shot'], args: { step: 'decider', library: LIBRARY_NOT_SEEN, run: null, runs: [], bands: null, preview: PAYLOAD, previewOpen: true } };
/** An editor's step 1: the decider as read, the key Set without its hint, no form. */
export const EditorDecider: Story = { tags: ['no-shot'], args: { owner: false, step: 'decider', library: LIBRARY_JEV } };
/** Step 2 with the owner's run stats above the last run. */
export const RunWithStats: Story = { tags: ['no-shot'], args: { step: 'run', stats: MODULE } };
/** Step 3: Agreement under the gates. */
export const SpotCheckAgreement: Story = { tags: ['no-shot'], args: { agreement: AGREEMENT } };

export const PhoneSetupLocal: Story = { ...phone, tags: ['phone', 'shot-full', 'no-shot'], args: { step: 'decider', run: null, runs: [], bands: null } };
export const PhoneSetupJev: Story = { ...phone, tags: ['phone', 'shot-full', 'no-shot'], args: { step: 'decider', library: LIBRARY_JEV } };
export const PhoneSetupJevNoKey: Story = { ...phone, tags: ['phone', 'shot-full', 'no-shot'], args: { step: 'decider', run: null, runs: [], bands: null, draft: { decider: 'jev' } } };
export const PhoneSpotCheckAgreement: Story = { ...phone, tags: ['phone', 'shot-full', 'no-shot'], args: { agreement: AGREEMENT } };

/** The album page's line: who decided the match. */
export const Provenance: Story = {
  render: () => (
    <dl style={{ display: 'grid', gap: 8, margin: 0 }}>
      <div><dt>Model</dt><dd style={{ margin: 0 }}><ProvenanceLine match={MODEL_MATCH} locale="en-GB" /></dd></div>
      <div><dt>Rule</dt><dd style={{ margin: 0 }}><ProvenanceLine match={RULE_MATCH} locale="en-GB" /></dd></div>
      <div><dt>Person</dt><dd style={{ margin: 0 }}><ProvenanceLine match={HAND_MATCH} /></dd></div>
    </dl>
  ),
};
