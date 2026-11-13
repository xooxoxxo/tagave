/**
 * TypeSafe's System One endpoint (Jev), over plain fetch. Retries what is
 * worth retrying (408, 429, 5xx, a dropped connection, a timeout) with the
 * server's own retry-after when it gives one; a 400/413/422 means "this
 * request will never be accepted" (usually too large) and is returned at once.
 * A 200 with a malformed answer is not retried either: it may already be billed.
 *
 * The key goes in the Authorization header and nowhere else: errors thrown
 * from here carry a status and a short reason of our own, never the fetch
 * error (some fetch implementations put the request headers in theirs), never
 * a `cause`, and any response text kept is scrubbed of the key and cut short.
 * Nothing here logs: the request carries the owner's tags and the server can
 * echo them back.
 *
 * Only the answer's shape is checked; whether the probabilities make sense
 * is the decider's call.
 */
import type { JevRequest } from '@tagave/core';

export const TYPESAFE_DEFAULT_URL = 'https://api.typesafe.ai';
/** The endpoint's base. The override exists so tests can point at a fake server. */
export function typesafeBaseUrl(): string { return process.env['TAGAVE_TYPESAFE_URL'] || TYPESAFE_DEFAULT_URL; }

export interface JevResponse { model: string; answers: Record<string, { type: string; noul?: number }>; usage: { input_tokens: number; output_tokens: number } }

/** 400, 413, 422: the server will never accept this request as it is. Not retried. */
export class JevRejected extends Error {
  override readonly name = 'JevRejected';
  constructor(readonly status: number, readonly detail: string) { super(`TypeSafe rejected the request (${status})`); }
}
/** 401, 403: the key is wrong, revoked or out of credit. */
export class JevKeyRefused extends Error {
  override readonly name = 'JevKeyRefused';
  constructor(readonly status: number) { super(`TypeSafe refused the key (${status})`); }
}
/**
 * No usable answer: retries ran out, a timeout, a dropped connection or a
 * malformed answer. `attempts` is how many requests were actually sent (unset
 * when not known), so a caller can count each one that may have been billed.
 */
export class JevUnavailable extends Error {
  override readonly name = 'JevUnavailable';
  constructor(readonly status: number | null, why: string, readonly attempts?: number) { super(`TypeSafe is unavailable: ${why}`); }
}

export interface JevClientOptions { apiKey: string; baseUrl?: string; fetchImpl?: typeof fetch; maxRetries?: number; sleep?: (ms: number) => Promise<void>; timeoutMs?: number }

/** The longest wait a server can ask for; a hostile or broken header must not park a worker for hours. */
export const MAX_SERVER_WAIT_MS = 60_000;
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_RETRIES = 3;
/** How much of a rejection's body is kept, after scrubbing. */
const DETAIL_MAX = 200;

const isRetryStatus = (s: number) => s === 408 || s === 429 || s >= 500;
const isRejectStatus = (s: number) => s === 400 || s === 413 || s === 422;
const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function retryDelay(headers: Headers | null, attempt: number): number {
  const ms = Number(headers?.get('retry-after-ms') ?? NaN);
  if (Number.isFinite(ms) && ms > 0) return Math.min(ms, MAX_SERVER_WAIT_MS);
  const s = Number(headers?.get('retry-after') ?? NaN);
  if (Number.isFinite(s) && s > 0) return Math.min(s * 1000, MAX_SERVER_WAIT_MS);
  return Math.min(1000 * 2 ** attempt, MAX_SERVER_WAIT_MS);
}

/** Remove the key (and any bearer token) from server text, then cut it short. */
function scrubDetail(text: string, key: string): string {
  let t = key ? text.split(key).join('[redacted]') : text;
  t = t.replace(/bearer\s+[^\s"',;]+/gi, 'Bearer [redacted]');
  t = t.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return t.slice(0, DETAIL_MAX);
}

const isObject = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);

/** The answer with only the fields we know, or null when its shape is wrong. */
function parseAnswer(text: string): JevResponse | null {
  let x: unknown;
  try { x = JSON.parse(text); } catch { return null; }
  if (!isObject(x) || typeof x['model'] !== 'string' || !isObject(x['answers']) || !isObject(x['usage'])) return null;
  const usage = x['usage'];
  const input = usage['input_tokens'];
  const output = usage['output_tokens'];
  if (typeof input !== 'number' || typeof output !== 'number' || !Number.isFinite(input) || !Number.isFinite(output) || input < 0 || output < 0) return null;
  // no prototype: a '__proto__' answer key from the server stays a plain key
  const answers = Object.create(null) as JevResponse['answers'];
  for (const [name, a] of Object.entries(x['answers'])) {
    if (!isObject(a) || typeof a['type'] !== 'string') return null;
    if (a['noul'] !== undefined && typeof a['noul'] !== 'number') return null;
    answers[name] = a['noul'] === undefined ? { type: a['type'] } : { type: a['type'], noul: a['noul'] };
  }
  return { model: x['model'], answers, usage: { input_tokens: input, output_tokens: output } };
}

type Attempt =
  | { kind: 'response'; status: number; headers: Headers; text: string }
  | { kind: 'failed'; why: 'timed out' | 'connection failed' };

/**
 * One request, response body included, under its own timeout. The fetch is
 * raced against the timer as well as given the signal, so a fetch that
 * ignores the signal still cannot hang the worker. Whatever the fetch throws
 * is dropped here: only our own reason leaves.
 */
async function attemptOnce(f: typeof fetch, url: string, init: RequestInit, timeoutMs: number): Promise<Attempt> {
  const ctrl = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => { ctrl.abort(); resolve('timeout'); }, timeoutMs);
  });
  let res: Response | null = null;
  try {
    const got = await Promise.race([f(url, { ...init, signal: ctrl.signal }), timedOut]);
    if (got === 'timeout') return { kind: 'failed', why: 'timed out' };
    res = got;
    const text = await Promise.race([res.text(), timedOut]);
    if (text === 'timeout') {
      res.body?.cancel().catch(() => undefined);
      return { kind: 'failed', why: 'timed out' };
    }
    return { kind: 'response', status: res.status, headers: res.headers, text };
  } catch {
    if (ctrl.signal.aborted) return { kind: 'failed', why: 'timed out' };
    // a dropped body mid-read still has a status worth acting on
    if (res) return { kind: 'response', status: res.status, headers: res.headers, text: '' };
    return { kind: 'failed', why: 'connection failed' };
  } finally {
    clearTimeout(timer);
  }
}

export async function systemOne(opts: JevClientOptions, body: JevRequest): Promise<JevResponse> {
  if (!opts.apiKey) throw new JevKeyRefused(0);
  const f = opts.fetchImpl ?? fetch;
  const sleep = opts.sleep ?? wait;
  const max = opts.maxRetries ?? DEFAULT_RETRIES;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const url = `${(opts.baseUrl ?? typesafeBaseUrl()).replace(/\/+$/, '')}/v1/systemone`;
  const init: RequestInit = {
    method: 'POST',
    headers: {
      authorization: `Bearer ${opts.apiKey}`,
      'content-type': 'application/json',
      accept: 'application/json',
      'user-agent': 'tagave',
    },
    body: JSON.stringify(body),
  };

  let last: { status: number | null; why: string } = { status: null, why: 'no answer' };
  for (let attempt = 0; attempt <= max; attempt++) {
    const r = await attemptOnce(f, url, init, timeoutMs);
    let headers: Headers | null = null;
    if (r.kind === 'failed') {
      last = { status: null, why: r.why };
    } else {
      if (r.status === 401 || r.status === 403) throw new JevKeyRefused(r.status);
      if (isRejectStatus(r.status)) throw new JevRejected(r.status, scrubDetail(r.text, opts.apiKey));
      if (isRetryStatus(r.status)) {
        last = { status: r.status, why: `HTTP ${r.status}` };
        headers = r.headers;
      } else if (r.status < 200 || r.status >= 300) {
        // another 4xx (or an odd status): retrying will not change the answer
        throw new JevUnavailable(r.status, `HTTP ${r.status}`, attempt + 1);
      } else {
        const answer = parseAnswer(r.text);
        if (answer) return answer;
        // the call may already be billed: asking again could double or triple the cost
        throw new JevUnavailable(r.status, 'malformed answer', attempt + 1);
      }
    }
    if (attempt < max) await sleep(retryDelay(headers, attempt));
  }
  throw new JevUnavailable(last.status, last.why, max + 1);
}
