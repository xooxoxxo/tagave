/**
 * Library care › Autotagger, the words and the four steps (Decider, Run,
 * Spot check, Accept) worked out from what the api answers, so the views
 * only lay them out. Labels and values, no sentences.
 */
import type { AutotaggerLibraryView, BandId, BandRow, LocalModelsView, Population, RunView } from '@tagave/shared';

export const BAND_LABEL: Record<BandId, string> = { p99: '99%', p97: '97%', p95: '95%', p90: '90%' };

export const POPULATION_LABEL: Record<Population, string> = {
  needs_review: 'In review',
  weak: 'Weak, unidentified',
  backtest: 'Backtest',
  measure: 'Measure',
};

/** The populations a run can start with here (the measurement runs from the command line). */
export const STARTABLE_POPULATIONS = ['needs_review', 'weak', 'backtest'] as const;
export type StartablePopulation = (typeof STARTABLE_POPULATIONS)[number];

/** Why a run paused (decider_runs.pause_reason), as a label. */
export const PAUSE_LABEL: Record<string, string> = {
  module_off: 'Module off',
  no_key: 'No key',
  no_cap: 'No cap',
  no_price: 'No price',
  cap_reached: 'Cap reached',
  key_refused: 'Key refused',
  spec_changed: 'Question changed',
  currency_mismatch: 'Currency differs',
  model_changed: 'Model changed',
  payload_not_seen: 'Payload not seen',
  no_model: 'No model',
  stopped: 'Stopped',
};

export const pauseLabel = (reason: string | null): string => (reason ? PAUSE_LABEL[reason] ?? reason : 'Paused');

export const RUN_STATE_LABEL: Record<string, string> = {
  queued: 'Queued',
  running: 'Running',
  paused: 'Paused',
  done: 'Done',
  cancelled: 'Cancelled',
  failed: 'Failed',
};

export const runStateLabel = (state: string): string => RUN_STATE_LABEL[state] ?? state;

/** A decision's outcome (decider_decisions.outcome), as a label. */
export const OUTCOME_LABEL: Record<string, string> = {
  pick: 'Picked',
  none: 'No pick',
  too_large: 'Too large',
  no_candidates: 'No candidates',
  rejected: 'Refused',
  error: 'Error',
};

export const BATCH_STATE_LABEL: Record<string, string> = {
  queued: 'Waiting',
  accepting: 'Accepting',
  accepted: 'Accepted',
  undoing: 'Undoing',
  undone: 'Undone',
  failed: 'Failed',
};

const nf = new Intl.NumberFormat('en-GB');
export const count = (n: number): string => nf.format(n);

/** 12.5 USD → '$12.50'; an unknown currency keeps its code. */
export function money(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat('en-GB', { style: 'currency', currency, currencyDisplay: 'narrowSymbol', minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${currency}`;
  }
}

/** 0.0123 → '1.2%' */
export const percent = (rate: number, digits = 1): string => `${(rate * 100).toFixed(digits)}%`;

export function shortDate(iso: string): string {
  return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'UTC' }).format(new Date(iso));
}

/** Picks decided per outcome, total. */
export const decided = (run: Pick<RunView, 'outcomes'>): number => Object.values(run.outcomes).reduce((a, b) => a + b, 0);

/** Can a run's band be accepted at all: done, over albums in review or weak ones. */
export const acceptableRun = (run: Pick<RunView, 'state' | 'population'> | null): boolean =>
  !!run && run.state === 'done' && (run.population === 'needs_review' || run.population === 'weak');

/** A band's gate as a label: Open, Needs <n> more, Closed (cannot be reached), or — before any check. */
export function gateLabel(b: Pick<BandRow, 'allowed' | 'stillNeeded' | 'drawn' | 'picks'>): { label: string; tone: 'success' | 'warning' | 'neutral' } {
  if (b.picks === 0) return { label: '—', tone: 'neutral' };
  if (b.allowed) return { label: 'Open', tone: 'success' };
  if (b.drawn === 0) return { label: '—', tone: 'neutral' };
  if (b.stillNeeded === null) return { label: 'Closed', tone: 'neutral' };
  return { label: `Needs ${count(b.stillNeeded)} more`, tone: 'warning' };
}

/** Albums an open band would still accept. */
export const openAlbums = (b: Pick<BandRow, 'allowed' | 'picks' | 'accepted'>): number => (b.allowed ? Math.max(0, b.picks - b.accepted) : 0);

export type StepId = 'decider' | 'run' | 'check' | 'accept';
export const STEP_IDS: readonly StepId[] = ['decider', 'run', 'check', 'accept'];
export const STEP_TITLE: Record<StepId, string> = { decider: '1 · Decider', run: '2 · Run', check: '3 · Spot check', accept: '4 · Accept' };

export interface StepTile {
  id: StepId;
  title: string;
  /** done ✓, waiting, or blocked by … */
  status: 'done' | 'waiting' | 'blocked';
  value: string;
  sub: string | null;
}

export interface StepsInput {
  library: Pick<AutotaggerLibraryView, 'keySet' | 'config'> | null;
  models: LocalModelsView | null;
  run: RunView | null;
  bands: BandRow[] | null;
  /** the band the spot check is on */
  band: BandId;
}

/** The local decider's active model as 'Model v3' (its place among the stored ones, oldest first). */
export function modelName(models: LocalModelsView | null): string | null {
  if (!models?.active) return null;
  const at = models.models.findIndex((m) => m.id === models.active!.id);
  return at < 0 ? `Model ${models.active.version}` : `Model v${models.models.length - at}`;
}

/** Whether the decider can run now, and if not, what blocks it. */
export function deciderReady(input: Pick<StepsInput, 'library' | 'models'>): { ready: boolean; blocker: string | null } {
  const { library, models } = input;
  if (!library) return { ready: false, blocker: null };
  if (library.config.decider === 'local') return models?.active ? { ready: true, blocker: null } : { ready: false, blocker: 'No model' };
  if (!library.keySet) return { ready: false, blocker: 'No key' };
  if (!library.config.payloadSeenAt) return { ready: false, blocker: 'Payload not seen' };
  if (library.config.monthlyCap === null) return { ready: false, blocker: 'No cap' };
  return { ready: true, blocker: null };
}

/** The four tiles of the step strip. */
export function stepTiles(input: StepsInput): StepTile[] {
  const { library, models, run, bands, band } = input;
  const ready = deciderReady(input);
  const local = library?.config.decider !== 'jev';

  const decider: StepTile = ready.ready
    ? local
      ? { id: 'decider', title: STEP_TITLE.decider, status: 'done', value: `${modelName(models)} ✓`, sub: `${count(models!.active!.counts.albums)} decisions` }
      : { id: 'decider', title: STEP_TITLE.decider, status: 'done', value: 'Jev ✓', sub: library!.config.model }
    : { id: 'decider', title: STEP_TITLE.decider, status: 'blocked', value: ready.blocker ?? '…', sub: local ? 'On this machine' : 'Jev' };

  let runTile: StepTile;
  if (!run) runTile = { id: 'run', title: STEP_TITLE.run, status: ready.ready ? 'waiting' : 'blocked', value: 'No run', sub: ready.ready ? null : ready.blocker };
  else if (run.state === 'done') {
    runTile = { id: 'run', title: STEP_TITLE.run, status: 'done', value: `${count(run.albums)} albums ✓`, sub: `${count(run.outcomes.pick ?? 0)} picked` };
  } else if (run.state === 'paused') {
    runTile = { id: 'run', title: STEP_TITLE.run, status: 'blocked', value: 'Paused', sub: pauseLabel(run.pauseReason) };
  } else if (run.state === 'queued' || run.state === 'running') {
    runTile = { id: 'run', title: STEP_TITLE.run, status: 'waiting', value: runStateLabel(run.state), sub: `${count(decided(run))} of ${count(run.albums)}` };
  } else {
    runTile = { id: 'run', title: STEP_TITLE.run, status: 'blocked', value: runStateLabel(run.state), sub: POPULATION_LABEL[run.population] };
  }

  const accepting = acceptableRun(run);
  const row = bands?.find((b) => b.band === band) ?? null;
  let check: StepTile;
  if (!run || run.state !== 'done') check = { id: 'check', title: STEP_TITLE.check, status: 'blocked', value: 'Run first', sub: null };
  else if (!row || row.picks === 0) check = { id: 'check', title: STEP_TITLE.check, status: 'waiting', value: `${BAND_LABEL[band]} band`, sub: 'No picks' };
  else {
    check = {
      id: 'check', title: STEP_TITLE.check, status: 'waiting', value: `${BAND_LABEL[band]} band`,
      sub: `${count(row.drawn - row.pending)} of ${count(row.drawn)} checked`,
    };
  }

  const open = (bands ?? []).filter((b) => b.allowed && openAlbums(b) > 0);
  const albums = open.reduce((n, b) => n + openAlbums(b), 0);
  const accepted = (bands ?? []).reduce((n, b) => n + b.accepted, 0);
  let accept: StepTile;
  if (!run || run.state !== 'done') accept = { id: 'accept', title: STEP_TITLE.accept, status: 'blocked', value: 'Run first', sub: null };
  else if (!accepting) accept = { id: 'accept', title: STEP_TITLE.accept, status: 'blocked', value: POPULATION_LABEL[run.population], sub: 'Never accepted' };
  else if (open.length > 0) accept = { id: 'accept', title: STEP_TITLE.accept, status: 'waiting', value: `${open.length} ${open.length === 1 ? 'band' : 'bands'} ready`, sub: `${count(albums)} albums` };
  else if (accepted > 0) accept = { id: 'accept', title: STEP_TITLE.accept, status: 'done', value: `${count(accepted)} accepted ✓`, sub: null };
  else accept = { id: 'accept', title: STEP_TITLE.accept, status: 'blocked', value: 'No band open', sub: null };

  return [decider, runTile, check, accept];
}

/** The step open when the viewer has not chosen one: the first not done, the spot check once a run is done. */
export function defaultStep(tiles: StepTile[]): StepId {
  const [decider, run] = tiles;
  if (run?.status === 'done') return 'check';
  if (run && run.value !== 'No run') return 'run';
  if (decider?.status !== 'done') return 'decider';
  return 'run';
}

/** A spot check's verdict key: C, W, U (any case, no modifier). */
export function verdictForKey(e: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'altKey'>): 'correct' | 'wrong' | 'unsure' | null {
  if (e.ctrlKey || e.metaKey || e.altKey) return null;
  switch (e.key.toLowerCase()) {
    case 'c': return 'correct';
    case 'w': return 'wrong';
    case 'u': return 'unsure';
    default: return null;
  }
}

/** The gate meter: the bound against the max-error line, both as a share of the meter (the line sits at a third). */
export function meter(upper: number, maxErrorRate: number): { fill: number; line: number } {
  const scale = maxErrorRate * 3;
  return { fill: Math.max(0, Math.min(1, upper / scale)), line: 1 / 3 };
}
