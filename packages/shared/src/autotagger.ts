/**
 * The autotagger module's settings (per library) and price rows, as the api
 * accepts and returns them. @tagave/db keeps its own copy of the config shape
 * and defaults (it depends on no other tagave package); a worker test checks
 * that the two agree.
 */
import { z } from 'zod';

export interface AutotaggerConfig {
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

export const DEFAULT_AUTOTAGGER_CONFIG: AutotaggerConfig = {
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
  currency: string;
  /** albums × the library's mean cost per answered call in `currency`; null before any call */
  projected: number | null;
}
