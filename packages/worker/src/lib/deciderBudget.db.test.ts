/**
 * Decider prices, the monthly spend and the cap, against a real database:
 * the dated model's price before '*', cost in millionths, the spend of one
 * library in one currency within the UTC calendar month, tokens per byte
 * learned from recent calls, and the check before a call.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { makeDb } from '@tagave/db';
import {
  DEFAULT_TOKENS_PER_BYTE, checkBudget, costOf, monthSpend, monthSpendByCurrency, priceFor, tokensPerByte, type Price,
} from './deciderBudget.js';

describe('costOf', () => {
  it('cost is tokens times the price per million', () => expect(costOf(812, { perMillionInput: 0.5, currency: 'USD' })).toBe(0.000406));
  it('rounds to 6 decimals', () => {
    expect(costOf(1, { perMillionInput: 0.4, currency: 'USD' })).toBe(0);
    expect(costOf(3, { perMillionInput: 0.5, currency: 'USD' })).toBe(0.000002);
    expect(costOf(0, { perMillionInput: 3, currency: 'USD' })).toBe(0);
    expect(costOf(1_000_000, { perMillionInput: 1.234567, currency: 'USD' })).toBe(1.234567);
  });
  it('refuses negative or non-finite input', () => {
    for (const t of [-1, NaN, Infinity, -Infinity]) expect(() => costOf(t, { perMillionInput: 1, currency: 'USD' }), String(t)).toThrow(RangeError);
    for (const p of [-0.5, NaN, Infinity]) expect(() => costOf(10, { perMillionInput: p, currency: 'USD' }), String(p)).toThrow(RangeError);
  });
});

describe.skipIf(!process.env.TEST_DATABASE_URL)('decider budget (shared db: its own library and decider ids only)', () => {
  let client: any;
  const userId = randomUUID();
  const lib = randomUUID();
  const otherLib = randomUUID();
  const albumId = randomUUID();
  const otherAlbum = randomUUID();
  const decider = `jev-${randomUUID().slice(0, 8)}`;
  const p: Price = { perMillionInput: 0.5, currency: 'USD' };
  const now = new Date('2026-10-27T12:00:00Z');
  let n = 0;

  const call = (c: { cost?: number; currency?: string; createdAt: string; bytes?: number; tokens?: number; library?: string }) => {
    const library = c.library ?? lib;
    return client`
      insert into decider_calls (library_id, local_album_id, evidence_hash, spec_hash, decider_id, decider_version, request_bytes, input_tokens, cost, currency, answers, created_at)
      values (${library}, ${library === lib ? albumId : otherAlbum}, ${String(++n).padEnd(64, '0')}, 's1', ${decider}, 'jev-2026-09-15',
              ${c.bytes ?? 1000}, ${c.tokens ?? 300}, ${c.cost ?? 0}, ${c.currency ?? 'USD'}, '{}'::jsonb, ${c.createdAt}::timestamptz)`;
  };

  beforeAll(async () => {
    client = (await makeDb(process.env.TEST_DATABASE_URL!)).client;
    await client`insert into users (id, email, password_hash) values (${userId}, ${`budget-${userId}@test.com`}, 'x')`;
    for (const id of [lib, otherLib]) await client`insert into libraries (id, owner_user_id, name, settings) values (${id}, ${userId}, 'Budget', '{}'::jsonb)`;
    for (const [id, l] of [[albumId, lib], [otherAlbum, otherLib]] as const) {
      await client`insert into local_albums (id, library_id, cluster_key, title_guess, artist_guess, state) values (${id}, ${l}, ${`ck-${id}`}, 'A', 'B', 'needs_review')`;
    }
  });

  beforeEach(async () => {
    await client`delete from decider_calls where library_id = any(${[lib, otherLib]}::uuid[])`;
  });

  afterAll(async () => {
    await client`delete from decider_prices where decider_id = ${decider}`;
    await client`delete from libraries where id = any(${[lib, otherLib]}::uuid[])`;
    await client`delete from users where id = ${userId}`;
    await client.end({ timeout: 5 });
  });

  it('prices the exact dated model first, then "*"', async () => {
    await client`insert into decider_prices (decider_id, model, per_million_input, currency) values (${decider}, '*', 1.000000, 'USD'), (${decider}, 'jev-2026-09-15', 0.500000, 'USD')`;
    expect(await priceFor(client, decider, 'jev-2026-09-15')).toEqual({ perMillionInput: 0.5, currency: 'USD' });
    expect(await priceFor(client, decider, 'jev-2027-01-01')).toEqual({ perMillionInput: 1, currency: 'USD' });
    expect(await priceFor(client, `${decider}-other`, 'x')).toBeNull();
  });

  it('this month\'s spend counts this library\'s calls since the first of the month (UTC)', async () => {
    await call({ cost: 0.4, createdAt: '2026-10-01T00:00:01Z' });
    await call({ cost: 0.3, createdAt: '2026-09-30T23:59:59Z' });
    await call({ cost: 5, createdAt: '2026-10-02T00:00:00Z', library: otherLib });
    expect(await monthSpend(client, lib, 'USD', now)).toBeCloseTo(0.4, 6);
  });

  it('the month starts at 00:00:00 UTC on the 1st, and calls after `now` do not count', async () => {
    await call({ cost: 0.01, createdAt: '2026-10-01T00:00:00Z' });
    await call({ cost: 0.02, createdAt: '2026-09-30T23:59:59.998Z' });
    await call({ cost: 0.04, createdAt: '2026-10-28T00:00:00Z' });
    expect(await monthSpend(client, lib, 'USD', now)).toBeCloseTo(0.01, 6);
    // exactly at the boundary, the new month has nothing before `now` yet
    expect(await monthSpend(client, lib, 'USD', new Date('2026-10-01T00:00:00Z'))).toBe(0);
    expect(await monthSpend(client, lib, 'USD', new Date('2026-09-30T23:59:59.999Z'))).toBeCloseTo(0.02, 6);
  });

  it('spend is per currency: another currency is apart and never added in', async () => {
    await call({ cost: 0.25, createdAt: '2026-10-05T00:00:00Z' });
    await call({ cost: 0.7, currency: 'EUR', createdAt: '2026-10-05T00:00:00Z' });
    expect(await monthSpend(client, lib, 'USD', now)).toBeCloseTo(0.25, 6);
    expect(await monthSpend(client, lib, 'EUR', now)).toBeCloseTo(0.7, 6);
    expect(await monthSpend(client, lib, 'GBP', now)).toBe(0);
    expect(await monthSpendByCurrency(client, lib, now)).toEqual([{ currency: 'EUR', amount: 0.7 }, { currency: 'USD', amount: 0.25 }]);
  });

  it('without `now`, this month is the database\'s, and every call in it counts', async () => {
    const [{ at }] = await client`select now()::text as at`;
    await call({ cost: 0.125, createdAt: at });
    await call({ cost: 9, createdAt: '2020-01-15T00:00:00Z' });
    expect(await monthSpend(client, lib, 'USD')).toBeCloseTo(0.125, 6);
  });

  it('tokens per byte: 0.3 with no calls, else total tokens over total bytes of the last 200, skipping calls with no bytes', async () => {
    expect(await tokensPerByte(client, lib)).toBe(DEFAULT_TOKENS_PER_BYTE);
    expect(DEFAULT_TOKENS_PER_BYTE).toBe(0.3);
    await call({ createdAt: '2026-10-05T00:00:00Z', bytes: 1000, tokens: 200 });
    await call({ createdAt: '2026-10-05T00:00:01Z', bytes: 3000, tokens: 1000 });
    await call({ createdAt: '2026-10-05T00:00:02Z', bytes: 0, tokens: 500 });
    await call({ createdAt: '2026-10-05T00:00:03Z', bytes: 100, tokens: 10_000, library: otherLib });
    expect(await tokensPerByte(client, lib)).toBeCloseTo(1200 / 4000, 9);
  });

  it('a possibly billed call counts toward the spend at its estimate, but never toward tokens per byte', async () => {
    const [{ at }] = await client`select now()::text as at`;
    await call({ cost: 0.25, createdAt: at, bytes: 1000, tokens: 400 });
    await client`
      insert into decider_calls (library_id, local_album_id, evidence_hash, spec_hash, decider_id, decider_version, request_bytes, input_tokens, cost, currency, answers, possibly_billed, created_at)
      values (${lib}, ${albumId}, ${String(++n).padEnd(64, '0')}, 's1', ${decider}, 'jev-latest', 1000, 9000, 0.5, 'USD', null, true, ${at}::timestamptz)`;
    expect(await monthSpend(client, lib, 'USD')).toBeCloseTo(0.75, 6);
    expect(await tokensPerByte(client, lib)).toBeCloseTo(0.4, 9);
    // an answer is required unless the call is possibly billed, and refused when it is
    await expect(client`
      insert into decider_calls (library_id, local_album_id, evidence_hash, spec_hash, decider_id, decider_version, request_bytes, input_tokens, cost, currency, answers, possibly_billed)
      values (${lib}, ${albumId}, ${String(++n).padEnd(64, '0')}, 's1', ${decider}, 'jev-latest', 1, 1, 0, 'USD', '{}'::jsonb, true)`).rejects.toThrow(/check/);
  });

  it('tokens per byte: only zero-byte calls fall back to 0.3, never NaN or Infinity', async () => {
    await call({ createdAt: '2026-10-05T00:00:00Z', bytes: 0, tokens: 500 });
    await call({ createdAt: '2026-10-05T00:00:01Z', bytes: 0, tokens: 0 });
    expect(await tokensPerByte(client, lib)).toBe(0.3);
  });

  it('tokens per byte: only the last 200 calls count', async () => {
    // 1 old call far off the rate, then 200 newer ones at 0.5
    await call({ createdAt: '2026-09-01T00:00:00Z', bytes: 1, tokens: 1_000_000 });
    await client`
      insert into decider_calls (library_id, local_album_id, evidence_hash, spec_hash, decider_id, decider_version, request_bytes, input_tokens, cost, currency, answers, created_at)
      select ${lib}, ${albumId}, lpad(g::text, 64, 'f'), 's1', ${decider}, 'jev-2026-09-15', 1000, 500, 0, 'USD', '{}'::jsonb, '2026-10-05T00:00:00Z'::timestamptz + g * interval '1 second'
        from generate_series(1, 200) g`;
    expect(await tokensPerByte(client, lib)).toBeCloseTo(0.5, 9);
  });

  it('refuses without a cap or a price, and pauses at the cap', async () => {
    await call({ cost: 0.4, createdAt: '2026-10-01T00:00:01Z' });
    expect(await checkBudget(client, { libraryId: lib, cap: null, currency: 'USD', price: p, estimate: 0.01, now })).toMatchObject({ ok: false, reason: 'no_cap', cap: null });
    expect(await checkBudget(client, { libraryId: lib, cap: 1, currency: 'USD', price: null, estimate: 0.01 })).toMatchObject({ ok: false, reason: 'no_price' });
    expect(await checkBudget(client, { libraryId: lib, cap: 0.405, currency: 'USD', price: p, estimate: 0.01, now })).toMatchObject({ ok: false, reason: 'cap_reached', spent: 0.4 });
    expect(await checkBudget(client, { libraryId: lib, cap: 1, currency: 'USD', price: p, estimate: 0.01, now })).toEqual({ ok: true, spent: 0.4 });
    // exactly at the cap still fits
    expect(await checkBudget(client, { libraryId: lib, cap: 0.41, currency: 'USD', price: p, estimate: 0.01, now })).toMatchObject({ ok: true });
  });

  it('a cap lowered below this month\'s spend pauses before the next call', async () => {
    await call({ cost: 0.4, createdAt: '2026-10-01T00:00:01Z' });
    expect(await checkBudget(client, { libraryId: lib, cap: 0.1, currency: 'USD', price: p, estimate: 0, now })).toMatchObject({ ok: false, reason: 'cap_reached', spent: 0.4, cap: 0.1 });
  });

  it('a price in another currency than the cap is refused; spend in another currency does not count against the cap', async () => {
    await call({ cost: 0.4, currency: 'EUR', createdAt: '2026-10-01T00:00:01Z' });
    expect(await checkBudget(client, { libraryId: lib, cap: 1, currency: 'USD', price: { perMillionInput: 0.5, currency: 'EUR' }, estimate: 0.01, now }))
      .toEqual({ ok: false, reason: 'currency_mismatch', spent: 0, cap: 1 });
    expect(await checkBudget(client, { libraryId: lib, cap: 0.1, currency: 'USD', price: p, estimate: 0.01, now })).toEqual({ ok: true, spent: 0 });
    expect(await checkBudget(client, { libraryId: lib, cap: 0.1, currency: 'EUR', price: { perMillionInput: 0.5, currency: 'EUR' }, estimate: 0.01, now }))
      .toMatchObject({ ok: false, reason: 'cap_reached', spent: 0.4 });
  });

  it('refuses a negative or non-finite estimate', async () => {
    for (const estimate of [-0.01, NaN, Infinity]) {
      await expect(checkBudget(client, { libraryId: lib, cap: 1, currency: 'USD', price: p, estimate, now }), String(estimate)).rejects.toThrow(RangeError);
    }
  });
});

describe('decider budget without the module\'s tables', () => {
  // a client whose every query fails as Postgres does for a missing table
  const missing: any = Object.assign(
    () => Promise.reject(Object.assign(new Error('relation "decider_calls" does not exist'), { code: '42P01' })),
    {},
  );
  const broken: any = () => Promise.reject(Object.assign(new Error('connection refused'), { code: 'ECONNREFUSED' }));

  it('reads answer as for empty tables', async () => {
    expect(await priceFor(missing, 'jev', 'x')).toBeNull();
    expect(await monthSpend(missing, randomUUID(), 'USD')).toBe(0);
    expect(await monthSpendByCurrency(missing, randomUUID())).toEqual([]);
    expect(await tokensPerByte(missing, randomUUID())).toBe(0.3);
    expect(await checkBudget(missing, { libraryId: randomUUID(), cap: 1, currency: 'USD', price: { perMillionInput: 1, currency: 'USD' }, estimate: 0.01 }))
      .toEqual({ ok: true, spent: 0 });
  });

  it('any other error is thrown', async () => {
    await expect(monthSpend(broken, randomUUID(), 'USD')).rejects.toThrow('connection refused');
    await expect(priceFor(broken, 'jev', 'x')).rejects.toThrow('connection refused');
  });
});
