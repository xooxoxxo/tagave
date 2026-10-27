/**
 * The autotagger module's settings: its switch (the module ledger), the
 * price table, and each library's settings and API key.
 *
 *   GET    /api/v1/settings/autotagger                      system.manage: the Settings › Modules row
 *   PUT    /api/v1/settings/autotagger                      system.manage + fresh step-up: { enabled }
 *   POST   /api/v1/settings/autotagger/remove-data          system.manage + fresh step-up: turn it off, delete its rows
 *   PUT    /api/v1/settings/autotagger/prices               system.manage: { model, perMillionInput, currency }
 *   DELETE /api/v1/settings/autotagger/prices/:model        system.manage
 *   GET    /api/v1/libraries/:libraryId/autotagger          library.edit: the library's settings (the key's hint for the owner only)
 *   PATCH  /api/v1/libraries/:libraryId/autotagger/config   system.manage: the settings patch
 *   PUT    /api/v1/libraries/:libraryId/autotagger/key      system.manage + fresh step-up: { key } or { key: null }
 *
 * Off: every /libraries/:libraryId/autotagger route but the GET answers 409.
 * The API key is sealed with the app secret before it is stored, and only
 * its last four characters are ever shown; it is never logged, returned or
 * put in an error or the audit log.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type postgres from 'postgres';
import {
  AUTOTAGGER_MODULE_ID, AUTOTAGGER_TABLES, AutotaggerStillOnError, UnknownModuleError, autotaggerConfig, autotaggerEnabled, clearTypesafeKey, removeAutotaggerData, setAutotaggerConfig,
  setAutotaggerEnabled, setTypesafeKey, typesafeKeyHint, typesafeKeyHintOf,
} from '@tagave/db';
import { sealSecret } from '@tagave/core';
import {
  AUTOTAGGER_DECIDER_ID, DEFAULT_AUTOTAGGER_CONFIG, autotaggerConfigPatchSchema, autotaggerKeySchema, autotaggerModuleSchema, deciderPriceSchema,
  type AutotaggerLibraryView, type AutotaggerModuleView, type DeciderPrice,
} from '@tagave/shared';
import { ApiError } from '../middleware/errorHandler.js';
import { getAuthHandle } from '../middleware/auth.js';
import { callerCan } from '../permissions/guard.js';
import { requireFreshStepUp } from './stepUp.js';
import { sameSite } from './mcConnections.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Postgres: relation does not exist (the module's migration has not run). */
const UNDEFINED_TABLE = '42P01';

const sql = () => getAuthHandle().sql;

/** The read's answer, or `fallback` when the module's tables are not there. */
async function orMissing<T>(read: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await read();
  } catch (err) {
    if ((err as { code?: string }).code === UNDEFINED_TABLE) return fallback;
    throw err;
  }
}

/** A 400 naming the fields that failed, never the values sent. */
function badRequest(issues: ReadonlyArray<{ path: ReadonlyArray<PropertyKey>; message: string }>, fallback: string): ApiError {
  const first = issues[0];
  return new ApiError(400, 'Bad Request', first ? `${first.path.map(String).join('.') || 'body'}: ${first.message}` : fallback);
}

async function assertLibrary(libraryId: string): Promise<void> {
  if (!UUID.test(libraryId)) throw new ApiError(404, 'Not Found', 'Library not found');
  const [row] = await sql()`select 1 as x from libraries where id = ${libraryId}`;
  if (!row) throw new ApiError(404, 'Not Found', 'Library not found');
}

async function on(): Promise<void> {
  if (!(await autotaggerEnabled(sql()))) throw new ApiError(409, 'Conflict', 'Autotagger is off');
}

/**
 * Run `write` in one transaction with the module's switch row share-locked
 * and on: deleting its data locks the row for update, so it cannot run
 * between the check and the write. Off (or no row): 409.
 */
async function whileOn<T>(write: (tx: postgres.TransactionSql) => Promise<T>): Promise<T> {
  return sql().begin(async (tx) => {
    const [row] = await orMissing(
      () => tx<Array<{ enabled: boolean }>>`select enabled from installed_modules where id = ${AUTOTAGGER_MODULE_ID} for share`,
      [] as Array<{ enabled: boolean }>,
    );
    if (row?.enabled !== true) throw new ApiError(409, 'Conflict', 'Autotagger is off');
    return write(tx);
  }) as Promise<T>;
}

/** How many of the module's tables this database has. */
async function tablesPresent(): Promise<number> {
  const [r] = await sql()<Array<{ n: number }>>`
    select count(*)::int as n from unnest(${[...AUTOTAGGER_TABLES]}::text[]) as t(name) where to_regclass(t.name) is not null`;
  return r!.n;
}

async function prices(): Promise<DeciderPrice[]> {
  return orMissing(async () => {
    const rows = await sql()<Array<{ model: string; per_million_input: string; currency: string }>>`
      select model, per_million_input::text, currency from decider_prices where decider_id = ${AUTOTAGGER_DECIDER_ID} order by model`;
    return rows.map((r) => ({ model: r.model, perMillionInput: Number(r.per_million_input), currency: r.currency }));
  }, []);
}

async function count(table: 'decider_runs' | 'decider_decisions'): Promise<number> {
  return orMissing(async () => {
    const [r] = await sql()<Array<{ n: number }>>`select count(*)::int as n from ${sql()(table)}`;
    return r!.n;
  }, 0);
}

async function moduleView(): Promise<AutotaggerModuleView> {
  return { enabled: await autotaggerEnabled(sql()), runs: await count('decider_runs'), decisions: await count('decider_decisions'), prices: await prices() };
}

async function libraryView(request: FastifyRequest, libraryId: string): Promise<AutotaggerLibraryView> {
  const config = await orMissing(() => autotaggerConfig(sql(), libraryId), { ...DEFAULT_AUTOTAGGER_CONFIG });
  const hint = await orMissing(() => typesafeKeyHint(sql(), libraryId), null);
  // this calendar month (UTC), per currency: the settings' currency, and any other apart
  const spent = await orMissing(async () => {
    const rows = await sql()<Array<{ currency: string; amount: string }>>`
      select currency, sum(cost)::text as amount from decider_calls
       where library_id = ${libraryId} and created_at >= date_trunc('month', now() at time zone 'utc') at time zone 'utc'
       group by currency order by currency`;
    return rows.map((r) => ({ currency: r.currency, amount: Number(r.amount) }));
  }, [] as Array<{ currency: string; amount: number }>);
  const owner = callerCan(request, 'system.manage');
  return {
    enabled: await autotaggerEnabled(sql()),
    keySet: hint !== null,
    keyHint: owner ? hint : null,
    config: owner ? config : { ...config, payloadSeenBy: null },
    spentThisMonth: spent.find((s) => s.currency === config.currency)?.amount ?? 0,
    spentOther: spent.filter((s) => s.currency !== config.currency),
    currency: config.currency,
  };
}

export async function createAutotaggerRoutes(fastify: FastifyInstance) {
  // ---- Settings › Modules ----

  fastify.get('/settings/autotagger', async (): Promise<AutotaggerModuleView> => moduleView());

  fastify.put('/settings/autotagger', async (request): Promise<AutotaggerModuleView> => {
    sameSite(request);
    const parsed = autotaggerModuleSchema.safeParse(request.body ?? {});
    if (!parsed.success) throw new ApiError(400, 'Bad Request', 'enabled (true or false) is required');
    await requireFreshStepUp(request);
    try {
      await setAutotaggerEnabled(sql(), parsed.data.enabled);
    } catch (err) {
      if (err instanceof UnknownModuleError) throw new ApiError(409, 'Conflict', 'Autotagger is not installed');
      throw err;
    }
    request.log.info({ event: parsed.data.enabled ? 'module.enable' : 'module.disable', module: 'autotagger', userId: request.user?.id }, 'autotagger switched');
    return moduleView();
  });

  fastify.post('/settings/autotagger/remove-data', async (request, reply) => {
    sameSite(request);
    await requireFreshStepUp(request);
    const actor = request.user?.id ?? null;
    // off first, so no run starts while the rows go; the delete checks again,
    // with the switch's row locked, and refuses if it was turned back on
    try {
      await setAutotaggerEnabled(sql(), false);
    } catch (err) {
      // no ledger row: it was never on
      if (!(err instanceof UnknownModuleError)) throw err;
    }
    // the switch is recorded before the delete, so a failed delete still leaves the trail
    await sql()`insert into audit_log (library_id, actor_user_id, action, subject_type, payload)
              values (null, ${actor}, 'module.disable', 'module', ${JSON.stringify({ module: 'autotagger', for: 'remove_data' })}::text::jsonb)`;
    request.log.info({ event: 'module.disable', module: 'autotagger', userId: actor, for: 'remove_data' }, 'autotagger switched off to delete its data');
    let removed: Record<string, number>;
    try {
      // no table at all: never migrated, nothing to delete; some missing: an error
      removed = (await tablesPresent()) === 0 ? {} : await removeAutotaggerData(sql());
    } catch (err) {
      if (err instanceof AutotaggerStillOnError) throw new ApiError(409, 'Conflict', 'Autotagger was turned on again');
      request.log.error({ err, event: 'module.remove_data_failed', module: 'autotagger', userId: actor }, 'autotagger data not removed');
      // off, nothing deleted (one transaction), and a retry is safe
      return reply.status(500).send({ title: 'Data not removed', status: 500, detail: 'Autotagger: off · data: kept · retry: safe', enabled: false, removed: null });
    }
    await sql()`insert into audit_log (library_id, actor_user_id, action, subject_type, payload)
              values (null, ${request.user?.id ?? null}, 'module.remove_data', 'module', ${JSON.stringify({ module: 'autotagger', ...removed })}::text::jsonb)`;
    request.log.info({ event: 'module.remove_data', module: 'autotagger', userId: actor, ...removed }, 'autotagger data removed');
    const view: AutotaggerModuleView & { removed: Record<string, number> } = { ...(await moduleView()), removed };
    return view;
  });

  fastify.put('/settings/autotagger/prices', async (request): Promise<AutotaggerModuleView> => {
    sameSite(request);
    const parsed = deciderPriceSchema.safeParse(request.body ?? {});
    if (!parsed.success) throw badRequest(parsed.error.issues, 'Invalid price');
    const p = parsed.data;
    await sql()`
      insert into decider_prices (decider_id, model, per_million_input, currency)
      values (${AUTOTAGGER_DECIDER_ID}, ${p.model}, ${p.perMillionInput}, ${p.currency})
      on conflict (decider_id, model) do update
        set per_million_input = excluded.per_million_input, currency = excluded.currency, updated_at = now()`;
    return moduleView();
  });

  fastify.delete('/settings/autotagger/prices/:model', async (request): Promise<AutotaggerModuleView> => {
    sameSite(request);
    const { model } = request.params as { model: string };
    const valid = deciderPriceSchema.shape.model.safeParse(model);
    if (!valid.success) throw new ApiError(404, 'Not Found', 'Price not found');
    const gone = await sql()`delete from decider_prices where decider_id = ${AUTOTAGGER_DECIDER_ID} and model = ${valid.data}`;
    if (gone.count === 0) throw new ApiError(404, 'Not Found', 'Price not found');
    return moduleView();
  });

  // ---- one library ----

  fastify.get('/libraries/:libraryId/autotagger', async (request): Promise<AutotaggerLibraryView> => {
    const { libraryId } = request.params as { libraryId: string };
    await assertLibrary(libraryId);
    return libraryView(request, libraryId);
  });

  fastify.patch('/libraries/:libraryId/autotagger/config', async (request): Promise<AutotaggerLibraryView> => {
    sameSite(request);
    const { libraryId } = request.params as { libraryId: string };
    await assertLibrary(libraryId);
    await on();
    const parsed = autotaggerConfigPatchSchema.safeParse(request.body ?? {});
    if (!parsed.success) throw badRequest(parsed.error.issues, 'Invalid settings');
    await whileOn((tx) => setAutotaggerConfig(tx, libraryId, parsed.data, (raw) => autotaggerConfigPatchSchema.parse(raw)));
    return libraryView(request, libraryId);
  });

  fastify.put('/libraries/:libraryId/autotagger/key', async (request): Promise<AutotaggerLibraryView> => {
    sameSite(request);
    const { libraryId } = request.params as { libraryId: string };
    await assertLibrary(libraryId);
    await on();
    const parsed = autotaggerKeySchema.safeParse(request.body ?? {});
    // the message never carries what was sent
    if (!parsed.success) throw new ApiError(400, 'Bad Request', 'key: 16 to 512 characters, no spaces, or null');
    await requireFreshStepUp(request);
    const plain = parsed.data.key;
    const actor = request.user?.id ?? null;
    const appSecret = process.env.APP_SECRET;
    if (plain !== null && !appSecret) throw new ApiError(503, 'Service Unavailable', 'APP_SECRET is not set');
    // the audit row names the library and who; never the key or its hint
    const action = plain === null ? 'autotagger.key_cleared' : 'autotagger.key_set';
    await whileOn(async (tx) => {
      if (plain === null) await clearTypesafeKey(tx, libraryId);
      else await setTypesafeKey(tx, libraryId, sealSecret(plain, appSecret!), typesafeKeyHintOf(plain));
      await tx`insert into audit_log (library_id, actor_user_id, action, subject_type, subject_id)
               values (${libraryId}, ${actor}, ${action}, 'library', ${libraryId})`;
    });
    request.log.info({ event: action, libraryId, userId: actor }, plain === null ? 'autotagger key cleared' : 'autotagger key set');
    return libraryView(request, libraryId);
  });
}
