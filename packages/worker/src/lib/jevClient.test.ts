import { afterEach, describe, it, expect, vi } from 'vitest';
import {
  JevKeyRefused, JevRejected, JevUnavailable, MAX_SERVER_WAIT_MS, TYPESAFE_DEFAULT_URL, systemOne, typesafeBaseUrl,
} from './jevClient.js';

const body = { model: 'jev-latest', state: { task: 't', local: { artist: 'a', album: 'b', year: 'year unknown', discs: null, tracks: [] }, tracklists: {} }, questions: { is_A: { type: 'noul', instructions: 'i', criteria: { true: 't', false: 'f' } } } } as any;
const ok = { model: 'jev-2026-09-15', answers: { is_A: { type: 'noul', noul: 0.98 } }, usage: { input_tokens: 812, output_tokens: 3 } };
const res = (status: number, json: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(json), { status, headers: { 'content-type': 'application/json', ...headers } });
const KEY = 'ts-secret-key-0001';

/** The key must not be anywhere a caller could print: message, fields, cause chain, JSON. */
function expectNoKey(err: any) {
  const seen = new Set<unknown>();
  const walk = (e: any, depth: number) => {
    if (!e || depth > 5 || seen.has(e)) return;
    seen.add(e);
    expect(String(e.message ?? '')).not.toContain(KEY);
    expect(String(e.stack ?? '')).not.toContain(KEY);
    expect(String(e.detail ?? '')).not.toContain(KEY);
    expect(JSON.stringify(e)).not.toContain(KEY);
    walk(e.cause, depth + 1);
  };
  walk(err, 0);
  expect(err.cause).toBeUndefined();
}

describe('systemOne', () => {
  let sleep = vi.fn(async (_ms: number) => undefined);
  afterEach(() => { sleep = vi.fn(async (_ms: number) => undefined); });

  it('posts the request with the key as a bearer token and returns the answer', async () => {
    const fetchImpl = vi.fn(async (..._a: unknown[]) => res(200, ok));
    const out = await systemOne({ apiKey: KEY, baseUrl: 'http://fake', fetchImpl: fetchImpl as any, sleep }, body);
    expect(out).toEqual(ok);
    const [url, init] = fetchImpl.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe('http://fake/v1/systemone');
    expect(url).not.toContain(KEY);
    expect(init.method).toBe('POST');
    const h = new Headers(init.headers);
    expect(h.get('authorization')).toBe(`Bearer ${KEY}`);
    expect(h.get('content-type')).toBe('application/json');
    expect(h.get('accept')).toBe('application/json');
    expect(h.get('user-agent')).toBe('tagave');
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(String(init.body))).toEqual(body);
  });

  it('drops a trailing slash on the base url', async () => {
    const fetchImpl = vi.fn(async (..._a: unknown[]) => res(200, ok));
    await systemOne({ apiKey: 'k', baseUrl: 'http://fake/', fetchImpl: fetchImpl as any, sleep }, body);
    expect(fetchImpl.mock.calls[0]![0]).toBe('http://fake/v1/systemone');
  });

  it('returns only the known fields of the answer', async () => {
    const fetchImpl = vi.fn(async () => res(200, { ...ok, extra: 'x', answers: { is_A: { type: 'noul', noul: 0.5, why: 'w' } }, usage: { ...ok.usage, cost: 1 } }));
    const out = await systemOne({ apiKey: 'k', baseUrl: 'http://fake', fetchImpl: fetchImpl as any, sleep }, body);
    expect(out).toEqual({ model: ok.model, answers: { is_A: { type: 'noul', noul: 0.5 } }, usage: ok.usage });
  });

  it('retries 429 after retry-after, then succeeds', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(res(429, {}, { 'retry-after': '2' })).mockResolvedValueOnce(res(200, ok));
    await systemOne({ apiKey: 'k', baseUrl: 'http://fake', fetchImpl, sleep }, body);
    expect(sleep).toHaveBeenCalledWith(2000);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('prefers retry-after-ms over retry-after', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(res(503, {}, { 'retry-after-ms': '750', 'retry-after': '9' })).mockResolvedValueOnce(res(200, ok));
    await systemOne({ apiKey: 'k', baseUrl: 'http://fake', fetchImpl, sleep }, body);
    expect(sleep).toHaveBeenCalledWith(750);
  });

  it('caps a server-requested wait', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(res(429, {}, { 'retry-after': '86400' }))
      .mockResolvedValueOnce(res(429, {}, { 'retry-after-ms': '999999999' }))
      .mockResolvedValueOnce(res(200, ok));
    await systemOne({ apiKey: 'k', baseUrl: 'http://fake', fetchImpl, sleep }, body);
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([MAX_SERVER_WAIT_MS, MAX_SERVER_WAIT_MS]);
    expect(MAX_SERVER_WAIT_MS).toBe(60_000);
  });

  it('backs off 1 s, 2 s, 4 s without a usable retry-after', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(res(500, {}))
      .mockResolvedValueOnce(res(408, {}, { 'retry-after': 'soon' }))
      .mockResolvedValueOnce(res(502, {}, { 'retry-after': '-3' }))
      .mockResolvedValueOnce(res(200, ok));
    await systemOne({ apiKey: 'k', baseUrl: 'http://fake', fetchImpl, sleep }, body);
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([1000, 2000, 4000]);
  });

  it('gives up after the retries on 5xx', async () => {
    const fetchImpl = vi.fn(async () => res(503, {}));
    const err = await systemOne({ apiKey: 'k', baseUrl: 'http://fake', fetchImpl: fetchImpl as any, sleep, maxRetries: 2 }, body).catch((e) => e);
    expect(err).toBeInstanceOf(JevUnavailable);
    expect(err.status).toBe(503);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it('defaults to three retries', async () => {
    const fetchImpl = vi.fn(async () => res(500, {}));
    await expect(systemOne({ apiKey: 'k', baseUrl: 'http://fake', fetchImpl: fetchImpl as any, sleep }, body)).rejects.toBeInstanceOf(JevUnavailable);
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it('a 400 or 422 is a rejection, not retried', async () => {
    const fetchImpl = vi.fn(async () => res(422, { detail: [{ loc: ['body'], msg: 'too large', type: 'x' }] }));
    const err = await systemOne({ apiKey: 'k', baseUrl: 'http://fake', fetchImpl: fetchImpl as any, sleep }, body).catch((e) => e);
    expect(err).toBeInstanceOf(JevRejected);
    expect(err.status).toBe(422);
    expect(err.detail).toContain('too large');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each([400, 413])('a %i is a rejection', async (status) => {
    const fetchImpl = vi.fn(async () => res(status, {}));
    const err = await systemOne({ apiKey: 'k', baseUrl: 'http://fake', fetchImpl: fetchImpl as any, sleep }, body).catch((e) => e);
    expect(err).toBeInstanceOf(JevRejected);
    expect(err.status).toBe(status);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('a rejection detail is short and never carries the key', async () => {
    const echo = { detail: `bad header Authorization: Bearer ${KEY} ${'tag text '.repeat(200)}` };
    const fetchImpl = vi.fn(async () => res(400, echo));
    const err = await systemOne({ apiKey: KEY, baseUrl: 'http://fake', fetchImpl: fetchImpl as any, sleep }, body).catch((e) => e);
    expect(err).toBeInstanceOf(JevRejected);
    expect(err.detail.length).toBeLessThanOrEqual(200);
    expectNoKey(err);
  });

  it('a key echoed in a slice of the body never survives the truncation', async () => {
    // the key straddles the cut-off point
    const fetchImpl = vi.fn(async () => new Response(`${'x'.repeat(190)}${KEY}`, { status: 422 }));
    const err = await systemOne({ apiKey: KEY, baseUrl: 'http://fake', fetchImpl: fetchImpl as any, sleep }, body).catch((e) => e);
    expect(err.detail).not.toContain(KEY.slice(0, 10));
    expectNoKey(err);
  });

  it('a refused key never shows the key', async () => {
    const fetchImpl = vi.fn(async () => res(401, {}));
    const err = await systemOne({ apiKey: KEY, baseUrl: 'http://fake', fetchImpl: fetchImpl as any, sleep }, body).catch((e) => e);
    expect(err).toBeInstanceOf(JevKeyRefused);
    expect(err.status).toBe(401);
    expect(String(err.message)).not.toContain(KEY);
  });

  it('a 401 whose body echoes the key never shows the key', async () => {
    const fetchImpl = vi.fn(async () => res(401, { detail: `invalid key ${KEY}`, authorization: `Bearer ${KEY}` }));
    const err = await systemOne({ apiKey: KEY, baseUrl: 'http://fake', fetchImpl: fetchImpl as any, sleep }, body).catch((e) => e);
    expect(err).toBeInstanceOf(JevKeyRefused);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expectNoKey(err);
  });

  it('a 403 is a refused key, not retried', async () => {
    const fetchImpl = vi.fn(async () => res(403, {}));
    const err = await systemOne({ apiKey: KEY, baseUrl: 'http://fake', fetchImpl: fetchImpl as any, sleep }, body).catch((e) => e);
    expect(err).toBeInstanceOf(JevKeyRefused);
    expect(err.status).toBe(403);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('a fetch error that carries the request headers never leaks the key', async () => {
    const leaky = () => {
      const inner = Object.assign(new Error(`connect ECONNRESET, headers: {"authorization":"Bearer ${KEY}"}`), { code: 'ECONNRESET', headers: { authorization: `Bearer ${KEY}` } });
      return new TypeError(`fetch failed (Authorization: Bearer ${KEY})`, { cause: inner });
    };
    const fetchImpl = vi.fn(async () => { throw leaky(); });
    const err = await systemOne({ apiKey: KEY, baseUrl: 'http://fake', fetchImpl: fetchImpl as any, sleep, maxRetries: 1 }, body).catch((e) => e);
    expect(err).toBeInstanceOf(JevUnavailable);
    expect(err.status).toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(1000);
    expectNoKey(err);
  });

  it('retries a dropped connection, then succeeds', async () => {
    const fetchImpl = vi.fn().mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValueOnce(res(200, ok));
    const out = await systemOne({ apiKey: 'k', baseUrl: 'http://fake', fetchImpl, sleep }, body);
    expect(out.model).toBe(ok.model);
  });

  it('times out a hung fetch, per attempt', async () => {
    // never settles and ignores the abort signal: the client must not wait on it
    const fetchImpl = vi.fn(() => new Promise<Response>(() => undefined));
    const started = Date.now();
    const err = await systemOne({ apiKey: KEY, baseUrl: 'http://fake', fetchImpl: fetchImpl as any, sleep, maxRetries: 1, timeoutMs: 30 }, body).catch((e) => e);
    expect(err).toBeInstanceOf(JevUnavailable);
    expect(err.message).toMatch(/timed out/);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(Date.now() - started).toBeLessThan(2000);
    const signal = (fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].signal!;
    expect(signal.aborted).toBe(true);
    expectNoKey(err);
  });

  it('times out a body that never finishes', async () => {
    const stalled = new Response(new ReadableStream({ start() { /* never enqueues */ } }), { status: 200 });
    const fetchImpl = vi.fn(async () => stalled);
    const err = await systemOne({ apiKey: 'k', baseUrl: 'http://fake', fetchImpl: fetchImpl as any, sleep, maxRetries: 0, timeoutMs: 30 }, body).catch((e) => e);
    expect(err).toBeInstanceOf(JevUnavailable);
    expect(err.message).toMatch(/timed out/);
  });

  it('a malformed answer is unavailable', async () => {
    const fetchImpl = vi.fn(async () => res(200, { model: 'x' }));
    await expect(systemOne({ apiKey: 'k', baseUrl: 'http://fake', fetchImpl: fetchImpl as any, sleep, maxRetries: 0 }, body)).rejects.toBeInstanceOf(JevUnavailable);
  });

  it('a malformed answer is not retried: it may already be billed', async () => {
    const fetchImpl = vi.fn(async () => res(200, { model: 'x', echoed: 'some tag text' }));
    const err = await systemOne({ apiKey: 'k', baseUrl: 'http://fake', fetchImpl: fetchImpl as any, sleep }, body).catch((e) => e);
    expect(err).toBeInstanceOf(JevUnavailable);
    expect(err.status).toBe(200);
    expect(err.message).toBe('TypeSafe is unavailable: malformed answer');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it.each([
    ['not json', 'nope'],
    ['answers is an array', JSON.stringify({ ...ok, answers: [] })],
    ['an answer without a type', JSON.stringify({ ...ok, answers: { is_A: { noul: 0.4 } } })],
    ['a noul that is a string', JSON.stringify({ ...ok, answers: { is_A: { type: 'noul', noul: '0.4' } } })],
    ['usage missing output tokens', JSON.stringify({ ...ok, usage: { input_tokens: 1 } })],
    ['model not a string', JSON.stringify({ ...ok, model: 3 })],
    ['null', 'null'],
  ])('a malformed answer (%s) is unavailable', async (_name, text) => {
    const fetchImpl = vi.fn(async () => new Response(text, { status: 200 }));
    const err = await systemOne({ apiKey: 'k', baseUrl: 'http://fake', fetchImpl: fetchImpl as any, sleep }, body).catch((e) => e);
    expect(err).toBeInstanceOf(JevUnavailable);
    expect(err.status).toBe(200);
    expect(err.message).toMatch(/malformed/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('leaves out-of-range probabilities for the decider to judge', async () => {
    const fetchImpl = vi.fn(async () => res(200, { ...ok, answers: { is_A: { type: 'noul', noul: 7 } } }));
    const out = await systemOne({ apiKey: 'k', baseUrl: 'http://fake', fetchImpl: fetchImpl as any, sleep }, body);
    expect(out.answers['is_A']!.noul).toBe(7);
  });

  it('another 4xx is unavailable at once, not retried', async () => {
    const fetchImpl = vi.fn(async () => res(404, {}));
    const err = await systemOne({ apiKey: 'k', baseUrl: 'http://fake', fetchImpl: fetchImpl as any, sleep }, body).catch((e) => e);
    expect(err).toBeInstanceOf(JevUnavailable);
    expect(err.status).toBe(404);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('refuses to call without a key', async () => {
    const fetchImpl = vi.fn(async () => res(200, ok));
    await expect(systemOne({ apiKey: '', baseUrl: 'http://fake', fetchImpl: fetchImpl as any, sleep }, body)).rejects.toThrow(/key/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('typesafeBaseUrl', () => {
  afterEach(() => { vi.unstubAllEnvs(); });
  it('defaults to the public endpoint', () => {
    vi.stubEnv('TAGAVE_TYPESAFE_URL', '');
    expect(typesafeBaseUrl()).toBe(TYPESAFE_DEFAULT_URL);
    expect(TYPESAFE_DEFAULT_URL).toBe('https://api.typesafe.ai');
  });
  it('a test can point it at a fake server', () => {
    vi.stubEnv('TAGAVE_TYPESAFE_URL', 'http://fake:1234');
    expect(typesafeBaseUrl()).toBe('http://fake:1234');
  });
});
