/**
 * What a decider call costs, what a library has spent this month, and
 * whether the next call fits under its monthly cap. Shared by the api (the
 * library view's spend) and the worker (the check before each call).
 *
 * Money is kept per currency and never added across currencies: a cap is in
 * the library's settings currency, and only calls billed in that currency
 * count against it. A price in another currency cannot be checked against
 * the cap at all, so the check refuses it.
 *
 * The module's tables may be missing (its migration never ran): the reads
 * then answer as for an empty table (no price, nothing spent).
 */
import type postgres from 'postgres';

type Sql = postgres.Sql<any> | postgres.TransactionSql<any>;

/** Postgres: relation does not exist (the module's migration has not run). */
const UNDEFINED_TABLE = '42P01';

async function orMissing<T>(read: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await read();
  } catch (err) {
    if ((err as { code?: string }).code === UNDEFINED_TABLE) return fallback;
    throw err;
  }
}

/** What one decider model costs per million input tokens (output is free). */
export interface Price { perMillionInput: number; currency: string }

/** The price of `model`: its own row when there is one, else the decider's '*' row; null when neither. */
export async function priceFor(sql: Sql, deciderId: string, model: string): Promise<Price | null> {
  return orMissing(async () => {
    const [row] = await sql<Array<{ per_million_input: string; currency: string }>>`
      select per_million_input::text, currency from decider_prices
       where decider_id = ${deciderId} and model in (${model}, '*')
       order by (model = '*') asc
       limit 1`;
    return row ? { perMillionInput: Number(row.per_million_input), currency: row.currency } : null;
  }, null);
}

/** The cost of `inputTokens` at `price`, rounded to 6 decimals (as decider_calls.cost stores it). */
export function costOf(inputTokens: number, price: Price): number {
  if (!Number.isFinite(inputTokens) || inputTokens < 0) throw new RangeError('input tokens must be a finite number, 0 or more');
  if (!Number.isFinite(price.perMillionInput) || price.perMillionInput < 0) throw new RangeError('a price must be a finite number, 0 or more');
  // tokens × price per million is the cost in millionths
  return Math.round(inputTokens * price.perMillionInput) / 1e6;
}

/**
 * The library's spend in this UTC calendar month, per currency, ordered by
 * currency. `now` fixes the month (and counts only calls before it); without
 * it the month is the database's current one and every call in it counts.
 */
export async function monthSpendByCurrency(sql: Sql, libraryId: string, now?: Date): Promise<Array<{ currency: string; amount: number }>> {
  const at = now ? now.toISOString() : null;
  return orMissing(async () => {
    const rows = await sql<Array<{ currency: string; amount: string }>>`
      select currency, sum(cost)::text as amount from decider_calls
       where library_id = ${libraryId}
         and created_at >= date_trunc('month', coalesce(${at}::timestamptz, now()) at time zone 'utc') at time zone 'utc'
         and (${at}::timestamptz is null or created_at < ${at}::timestamptz)
       group by currency order by currency`;
    return rows.map((r) => ({ currency: r.currency, amount: Number(r.amount) }));
  }, []);
}

/** The library's spend in `currency` this UTC calendar month (see monthSpendByCurrency for `now`). */
export async function monthSpend(sql: Sql, libraryId: string, currency: string, now?: Date): Promise<number> {
  return (await monthSpendByCurrency(sql, libraryId, now)).find((s) => s.currency === currency)?.amount ?? 0;
}

/** Input tokens per request byte assumed before a library has any call to learn from. */
export const DEFAULT_TOKENS_PER_BYTE = 0.3;
const TOKENS_PER_BYTE_WINDOW = 200;

/**
 * Input tokens per request byte over the library's last 200 calls (total
 * tokens over total bytes), for estimating a call's cost before it is sent.
 * Calls with no bytes are left out, so a malformed row cannot divide by
 * zero; with none left, or a ratio that is not above 0, the default.
 */
export async function tokensPerByte(sql: Sql, libraryId: string): Promise<number> {
  const ratio = await orMissing(async () => {
    const [row] = await sql<Array<{ tokens: string | null; bytes: string | null }>>`
      select sum(input_tokens)::text as tokens, sum(request_bytes)::text as bytes from (
        select input_tokens, request_bytes from decider_calls
         where library_id = ${libraryId} and request_bytes > 0 and input_tokens is not null
         order by created_at desc, id desc
         limit ${TOKENS_PER_BYTE_WINDOW}
      ) recent`;
    const tokens = Number(row?.tokens ?? NaN);
    const bytes = Number(row?.bytes ?? NaN);
    return bytes > 0 ? tokens / bytes : NaN;
  }, NaN);
  return Number.isFinite(ratio) && ratio > 0 ? ratio : DEFAULT_TOKENS_PER_BYTE;
}

export type BudgetVerdict =
  | { ok: true; spent: number }
  | { ok: false; reason: 'no_cap' | 'no_price' | 'currency_mismatch' | 'cap_reached'; spent: number; cap: number | null };

/**
 * Whether a call estimated at `estimate` fits under the library's monthly
 * `cap`, which is in `currency` (the library settings' currency):
 *
 *   no_cap             no cap is set: nothing is sent without one
 *   no_price           the model has no price
 *   currency_mismatch  the price is in another currency than the cap
 *   cap_reached        this month's spend in `currency` plus the estimate is over the cap
 *
 * `spent` is this month's spend in `currency`. This is a read and takes no
 * lock: two runs on one library could both pass and overshoot together.
 * Callers must run at most one decider run per library at a time (the
 * decider queue serialises runs by library).
 */
export async function checkBudget(
  sql: Sql,
  a: { libraryId: string; cap: number | null; currency: string; price: Price | null; estimate: number; now?: Date },
): Promise<BudgetVerdict> {
  if (!Number.isFinite(a.estimate) || a.estimate < 0) throw new RangeError('an estimate must be a finite number, 0 or more');
  const spent = await monthSpend(sql, a.libraryId, a.currency, a.now);
  if (a.cap === null) return { ok: false, reason: 'no_cap', spent, cap: null };
  if (a.price === null) return { ok: false, reason: 'no_price', spent, cap: a.cap };
  if (a.price.currency !== a.currency) return { ok: false, reason: 'currency_mismatch', spent, cap: a.cap };
  // in millionths, so 0.1 + 0.2 is not over a cap of 0.3
  if (Math.round((spent + a.estimate) * 1e6) > Math.round(a.cap * 1e6)) return { ok: false, reason: 'cap_reached', spent, cap: a.cap };
  return { ok: true, spent };
}
