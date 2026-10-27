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
  /** a run pauses when more of its calls than this fail (0.01 = 1%) */
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
