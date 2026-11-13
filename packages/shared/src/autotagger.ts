/**
 * The autotagger module's settings (per library) and price rows, as the api
 * accepts and returns them. @tagave/db keeps its own copy of the config shape
 * and defaults (it depends on no other tagave package); a worker test checks
 * that the two agree.
 */
import { z } from 'zod';

export interface AutotaggerConfig {
  /** which decider a new run uses: the local model trained on the owner's decisions (default), or Jev (needs a key) */
  decider: DeciderChoice;
  /** the model the decider asks for; the dated model it answers with is pinned per run */
  model: string;
  /** spend cap per calendar month, in `currency`; null: no cap */
  monthlyCap: number | null;
  currency: string;
  /**
   * the spot-check gate: a band can be accepted as a batch only when the 95%
   * upper bound on its error rate is at or under this (0.01 = 1%); it never
   * pauses a run
   */
  maxErrorRate: number;
  /** a request larger than this is not sent; null: the decider's own limit */
  maxRequestBytes: number | null;
  /** when the owner last saw the request payload preview, and who did */
  payloadSeenAt: string | null;
  payloadSeenBy: string | null;
}

/** The deciders a library can run: 'local' (free, on this machine) or 'jev' (TypeSafe's, paid, needs a key). */
export const DECIDER_CHOICES = ['local', 'jev'] as const;
export type DeciderChoice = (typeof DECIDER_CHOICES)[number];

export const DEFAULT_AUTOTAGGER_CONFIG: AutotaggerConfig = {
  decider: 'local',
  model: 'jev-latest',
  monthlyCap: null,
  currency: 'USD',
  maxErrorRate: 0.01,
  maxRequestBytes: null,
  payloadSeenAt: null,
  payloadSeenBy: null,
};

const MODEL_RE = /^[a-z0-9][a-z0-9._-]{0,79}$/;
const CURRENCY_RE = /^[A-Z]{3}$/;

/** What the owner may change; unknown keys are refused. */
export const autotaggerConfigPatchSchema = z
  .object({
    decider: z.enum(DECIDER_CHOICES),
    model: z.string().regex(MODEL_RE),
    monthlyCap: z.number().min(0).max(100_000).nullable(),
    currency: z.string().regex(CURRENCY_RE),
    maxErrorRate: z.number().min(0.001).max(0.2),
    maxRequestBytes: z.number().int().min(1024).max(10_000_000).nullable(),
  })
  .partial()
  .strict();

export type AutotaggerConfigPatch = z.infer<typeof autotaggerConfigPatchSchema>;

/** One price row: model '*' prices every model of the decider. */
export const deciderPriceSchema = z
  .object({
    model: z.union([z.literal('*'), z.string().regex(MODEL_RE)]),
    perMillionInput: z.number().min(0),
    currency: z.string().regex(CURRENCY_RE),
  })
  .strict();

export type DeciderPrice = z.infer<typeof deciderPriceSchema>;

/** Which albums a run decides (decider_runs.population). */
export type Population = 'needs_review' | 'weak' | 'backtest' | 'measure';
export const POPULATIONS: readonly Population[] = ['needs_review', 'weak', 'backtest', 'measure'];

/** Settings › Modules › Autotagger. */
export interface AutotaggerModuleView {
  enabled: boolean;
  runs: number;
  decisions: number;
  prices: DeciderPrice[];
}

/**
 * One library's autotagger settings. `keyHint` (the last four characters of
 * the API key) and `config.payloadSeenBy` are for the owner only; everyone
 * else gets null.
 */
export interface AutotaggerLibraryView {
  enabled: boolean;
  keySet: boolean;
  keyHint: string | null;
  config: AutotaggerConfig;
  /** what this calendar month's calls cost (UTC), in `currency` */
  spentThisMonth: number;
  /** this month's calls in any other currency (after the currency was changed); usually empty */
  spentOther: Array<{ currency: string; amount: number }>;
  currency: string;
}

export const autotaggerModuleSchema = z.object({ enabled: z.boolean() }).strict();

/** The API key, or null to forget it. */
export const autotaggerKeySchema = z
  .object({ key: z.string().min(16).max(512).regex(/^\S+$/).nullable() })
  .strict();

/** The decider the module runs (decider_prices.decider_id, decider_runs.decider_id). */
export const AUTOTAGGER_DECIDER_ID = 'jev';

/** The populations a run can be started with from the api (the measurement runs from the command line). */
export const startRunSchema = z
  .object({ population: z.enum(['needs_review', 'weak', 'backtest']) })
  .strict();

export type StartRun = z.infer<typeof startRunSchema>;

/**
 * The Jev request as the payload preview shows it (@tagave/core JevRequest,
 * which the api checks fits this shape).
 */
export interface JevRequestView {
  model: string;
  state: { task: string; local: Record<string, unknown>; tracklists: Record<string, unknown> };
  questions: Record<string, { type: string; instructions: string; criteria: { true: string; false: string } }>;
}

/** The exact request one album's run would send, for the owner to see before the first run. */
export interface PayloadPreview {
  albumId: string;
  title: string | null;
  artist: string | null;
  /** UTF-8 bytes of the request's JSON */
  bytes: number;
  /** tracklist groups shown */
  groups: number;
  request: JevRequestView;
}

/** One decider run (Library care › Review › Decide with Jev). */
export interface RunView {
  id: string;
  /** 'local' or 'jev' */
  deciderId: string;
  population: Population;
  state: string;
  pauseReason: string | null;
  message: string | null;
  modelLabel: string;
  createdAt: string;
  startedBy: string | null;
  /** albums in the run: its population while it can go on, the albums it decided once it ended */
  albums: number;
  /** albums decided so far, per outcome */
  outcomes: Record<string, number>;
  /** what the run's calls cost, in `currency` (the library settings' currency) */
  spent: number;
  /** what its calls cost in any other currency (after the currency was changed); usually empty */
  spentOther: Array<{ currency: string; amount: number }>;
  currency: string;
  /** albums × the library's mean cost per answered call in `currency`; null before any call */
  projected: number | null;
}

/** One band's agreement between the decider and the owner (p99, p97, p95, p90, or 'none'). */
export interface AgreementRow { band: string | 'none'; decided: number; agree: number; disagree: number; noDecision: number }

/**
 * How often the decider agreed with the owner; it informs, never gates.
 * `backtest`: the latest done backtest run against the owner's past
 * decisions (null before one). `queue`: the owner's review-queue decisions
 * after a needs_review run's.
 */
export interface AgreementView { backtest: { runId: string; rows: AgreementRow[] } | null; queue: AgreementRow[] }

/** The decider's probability bands, most sure first (@tagave/core JEV_SPEC.bands, which the api checks agree). */
export const BAND_IDS = ['p99', 'p97', 'p95', 'p90'] as const;
export type BandId = (typeof BAND_IDS)[number];

/** A spot check's verdict: 'pending' until the owner gives one. */
export const SPOT_CHECK_VERDICTS = ['pending', 'correct', 'wrong', 'unsure'] as const;
export type SpotCheckVerdictView = (typeof SPOT_CHECK_VERDICTS)[number];

/** Draw more random spot checks of one band of a run. */
export const drawSpotChecksSchema = z
  .object({ band: z.enum(BAND_IDS), count: z.number().int().min(1).max(100).default(25) })
  .strict();

/** The owner's verdict on one spot check; a later one replaces it. */
export const spotCheckVerdictSchema = z
  .object({ verdict: z.enum(['correct', 'wrong', 'unsure']) })
  .strict();

/** Which drawn checks to list: one band or all, one verdict or 'all' (default 'pending'). */
export const spotCheckQuerySchema = z
  .object({
    band: z.enum(BAND_IDS).optional(),
    verdict: z.enum([...SPOT_CHECK_VERDICTS, 'all']).default('pending'),
    limit: z.coerce.number().int().min(1).max(100).default(25),
    offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
  })
  .strict();

/**
 * One band of a run against the spot-check gate. `checked`: the checks
 * drawn before the band's first pending one, in draw order (a pending
 * check holds back every check drawn after it); `errors`: the wrong and
 * unsure ones among them (only correct is clean). `unsure` and `pending`
 * count all of the band's drawn checks. `upper`: the 95% Clopper-Pearson
 * upper bound on the error rate from `errors` in `checked`; `allowed`
 * when it is at most the library's maxErrorRate. `stillNeeded`: more
 * clean checks before it would be (0 when allowed; null when it cannot be
 * reached). `accepted`: picks already accepted by one of the run's batches.
 */
export interface BandRow {
  band: BandId;
  picks: number;
  drawn: number;
  checked: number;
  errors: number;
  unsure: number;
  pending: number;
  upper: number;
  allowed: boolean;
  stillNeeded: number | null;
  accepted: number;
}

/** A track as a spot check shows it; `length` as m:ss. */
export interface SpotCheckTrack { n: number; title: string | null; length: string | null }

/**
 * One drawn spot check: the owner's album (their own tags, from its
 * evidence as it is now) beside the edition the decider chose. `stale`:
 * the album's evidence changed since the decision. `groupSize`: releases
 * in the tracklist group it chose from. `probability`: null when the
 * decision has none.
 */
export interface SpotCheckItem {
  id: string;
  band: BandId;
  verdict: SpotCheckVerdictView;
  album: { id: string; title: string | null; artist: string | null; year: number | null; tracks: SpotCheckTrack[] };
  chosen: {
    releaseId: string; title: string; year: number | null; country: string | null; label: string | null; format: string | null; source: string;
    tracks: Array<{ n: number; title: string; length: string | null }>;
  };
  probability: number | null;
  groupSize: number;
  stale: boolean;
}

/** What a training of the local decider counted. */
export interface LocalModelCounts { albums: number; rows: number; owner: number; auto: number; rejections: number }

/** One band of a training's held-out figures (@tagave/core BandMetrics). */
export interface LocalModelBand {
  band: string; min: number; decided: number; coverage: number; wrongRelease: number; wrongAlbum: number;
  errorRate: number | null; errorUpper: number;
}

/** A training's held-out figures (@tagave/core LocalTrainMetrics); they inform, the spot checks gate. */
export interface LocalModelMetrics {
  albums: number; groupedAlbums: number; folds: number; seed: number; cutoff: number; margin: number;
  bands: LocalModelBand[]; atOrAbove: LocalModelBand[]; undecided: number;
  topPickRight: { right: number; albums: number; rate: number };
}

/** One stored model of the local decider; `active` is the one new runs use. */
export interface LocalModelView {
  id: string; version: string; createdAt: string; active: boolean; counts: LocalModelCounts; metrics: LocalModelMetrics;
}

/** The library's local decider models, newest first. */
export interface LocalModelsView { active: LocalModelView | null; models: LocalModelView[] }

/** Accept one band of a finished run's picks, once its spot-check gate is open. */
export const acceptBandSchema = z.object({ band: z.enum(BAND_IDS) }).strict();

/**
 * What accepting a band would do. `albums`: the band's picks that would go
 * into the batch; `excludedWrong`: picks left out because a spot check
 * found them wrong or unsure; `alreadyAccepted`: picks already in an
 * accepted or waiting batch of this run. `cannotUndo`: what an undo cannot
 * take back. `linkedApps`: Music Connections links that may pull the new
 * identities.
 */
export interface AcceptPreview {
  band: BandId;
  albums: number;
  excludedWrong: number;
  alreadyAccepted: number;
  /** picks whose decision is not pinned to the evidence it saw (decided before the album was identified again) */
  notPinned: number;
  gate: { upper: number; allowed: boolean; stillNeeded: number | null };
  cannotUndo: readonly string[];
  linkedApps: number;
  drain: { pending: number; perNight: number; nights: number; limit: number };
}
