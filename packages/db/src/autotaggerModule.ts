/**
 * The autotagger module's switch, its per-library settings and its data
 * (Module Composition Principle rule 2).
 *
 *   turn off          no run can start and Library care › Review hides the
 *                     decider; every row stays
 *   delete its data   its six tables are emptied, nothing else: accept
 *                     batches and match provenance are core, so accepted
 *                     batches stay undoable
 *
 * The switch is the module ledger's row 'autotagger' (installed_modules), off
 * until the owner turns it on; a boot makes the row (syncInstalledModules).
 * Its settings are per library, in its own table decider_library_settings
 * (with the sealed API key and its hint), not in libraries.settings.
 *
 * The config shape and its defaults are kept here as well as in
 * @tagave/shared (autotagger.ts), because this package depends on no other
 * tagave package; a worker test checks that the two agree. The patch is
 * validated by the caller's parser (autotaggerConfigPatchSchema.parse).
 */
import type postgres from 'postgres';
import { moduleEnabled, setModuleEnabled } from './modules.js';

type Sql = postgres.Sql<any>;
type Tx = postgres.TransactionSql<any>;

export const AUTOTAGGER_MODULE_ID = 'autotagger';

/** Every table the module owns, a table before the ones it references. */
export const AUTOTAGGER_TABLES = [
  'decider_spot_checks', 'decider_decisions', 'decider_calls', 'decider_runs', 'decider_prices', 'decider_library_settings',
] as const;

/** The module's settings for one library (@tagave/shared AutotaggerConfig). */
export interface AutotaggerConfig {
  model: string;
  monthlyCap: number | null;
  currency: string;
  maxErrorRate: number;
  maxRequestBytes: number | null;
  payloadSeenAt: string | null;
  payloadSeenBy: string | null;
}

export const DEFAULT_AUTOTAGGER_CONFIG: Readonly<AutotaggerConfig> = Object.freeze({
  model: 'jev-latest',
  monthlyCap: null,
  currency: 'USD',
  maxErrorRate: 0.01,
  maxRequestBytes: null,
  payloadSeenAt: null,
  payloadSeenBy: null,
});

/** What the owner may change (@tagave/shared AutotaggerConfigPatch). */
export type AutotaggerConfigPatch = { [K in 'model' | 'monthlyCap' | 'currency' | 'maxErrorRate' | 'maxRequestBytes']?: AutotaggerConfig[K] | undefined };

const CONFIG_KEYS = Object.keys(DEFAULT_AUTOTAGGER_CONFIG) as Array<keyof AutotaggerConfig>;

export async function autotaggerEnabled(sql: Sql | Tx): Promise<boolean> {
  return moduleEnabled(sql, AUTOTAGGER_MODULE_ID);
}

/** UnknownModuleError until a boot has made the module's ledger row. */
export async function setAutotaggerEnabled(sql: Sql | Tx, enabled: boolean): Promise<void> {
  await setModuleEnabled(sql, AUTOTAGGER_MODULE_ID, enabled);
}

const asObject = (v: unknown): Record<string, unknown> => {
  const o = typeof v === 'string' ? JSON.parse(v) : v;
  return o && typeof o === 'object' && !Array.isArray(o) ? (o as Record<string, unknown>) : {};
};

/** The stored keys it knows, over the defaults. */
function withDefaults(stored: Record<string, unknown>): AutotaggerConfig {
  const out: Record<string, unknown> = { ...DEFAULT_AUTOTAGGER_CONFIG };
  for (const k of CONFIG_KEYS) if (k in stored) out[k] = stored[k];
  return out as unknown as AutotaggerConfig;
}

/** The library's settings: the defaults, with what the owner set over them. */
export async function autotaggerConfig(sql: Sql | Tx, libraryId: string): Promise<AutotaggerConfig> {
  const [row] = await sql<Array<{ config: unknown }>>`select config from decider_library_settings where library_id = ${libraryId}`;
  return withDefaults(asObject(row?.config));
}

/**
 * Merge `patch` into the library's settings and return them. `parse` is the
 * patch's validator (autotaggerConfigPatchSchema.parse from @tagave/shared);
 * what it throws, nothing is written. A key set to null is stored as null
 * (no cap, no limit).
 */
export async function setAutotaggerConfig(
  sql: Sql | Tx,
  libraryId: string,
  patch: unknown,
  parse: (raw: unknown) => AutotaggerConfigPatch,
): Promise<AutotaggerConfig> {
  const valid = parse(patch);
  const set = Object.fromEntries(Object.entries(valid).filter(([, v]) => v !== undefined));
  const [row] = await sql<Array<{ config: unknown }>>`
    insert into decider_library_settings (library_id, config) values (${libraryId}, ${JSON.stringify(set)}::text::jsonb)
    on conflict (library_id) do update
      set config = decider_library_settings.config || excluded.config, updated_at = now()
    returning config`;
  return withDefaults(asObject(row?.config));
}

/**
 * The API key is stored sealed (with the app secret, as the other provider
 * keys are) and never plain. The caller seals it: this package depends on no
 * other tagave package, so it checks the sealed form's prefix, and the
 * table's check refuses a plain key whoever writes it. The hint is the last
 * four characters of the plain key, set by the caller; it is all that is
 * ever shown.
 */
const SEALED_PREFIX = 'enc:';
const MAX_HINT = 4;

/** The hint of a plain API key: its last four characters (the whole key when shorter). */
export function typesafeKeyHintOf(plain: string): string {
  return plain.slice(-MAX_HINT);
}

/** Store the library's sealed API key and its hint. Throws, writing nothing, on a value that is not sealed. */
export async function setTypesafeKey(sql: Sql | Tx, libraryId: string, sealedValue: string, hint: string): Promise<void> {
  // the messages never carry the value
  if (typeof sealedValue !== 'string' || !sealedValue.startsWith(SEALED_PREFIX) || sealedValue.length <= SEALED_PREFIX.length) {
    throw new Error('the TypeSafe key must be sealed before it is stored');
  }
  if (typeof hint !== 'string' || hint.length === 0 || hint.length > MAX_HINT) {
    throw new Error(`the TypeSafe key's hint is 1 to ${MAX_HINT} characters`);
  }
  await sql`
    insert into decider_library_settings (library_id, sealed_key, key_hint) values (${libraryId}, ${sealedValue}, ${hint})
    on conflict (library_id) do update
      set sealed_key = excluded.sealed_key, key_hint = excluded.key_hint, updated_at = now()`;
}

/** Forget the library's API key and its hint; its settings stay. */
export async function clearTypesafeKey(sql: Sql | Tx, libraryId: string): Promise<void> {
  await sql`update decider_library_settings set sealed_key = null, key_hint = null, updated_at = now() where library_id = ${libraryId}`;
}

/** The hint of the library's API key, for display; null when it has none. */
export async function typesafeKeyHint(sql: Sql | Tx, libraryId: string): Promise<string | null> {
  const [row] = await sql<Array<{ hint: string | null }>>`
    select key_hint as hint from decider_library_settings where library_id = ${libraryId} and sealed_key is not null`;
  return row?.hint ?? null;
}

/** Deleting the module's data while it is on: refused, nothing deleted. */
export class AutotaggerStillOnError extends Error {
  constructor() {
    super(`${AUTOTAGGER_MODULE_ID} is still on here (Settings › Modules); turn it off first`);
    this.name = 'AutotaggerStillOnError';
  }
}

/**
 * Delete the module's data: exactly its rows, in one transaction. Idempotent.
 * Refused while the module is on (AutotaggerStillOnError). The ledger row is
 * locked for the check, so it cannot be turned on between the check and the
 * deletes; a missing row reads off.
 */
export async function removeAutotaggerData(sql: Sql): Promise<Record<(typeof AUTOTAGGER_TABLES)[number], number>> {
  return sql.begin(async (tx) => {
    const [row] = await tx<Array<{ enabled: boolean }>>`select enabled from installed_modules where id = ${AUTOTAGGER_MODULE_ID} for update`;
    if (row?.enabled === true) throw new AutotaggerStillOnError();
    const out = {} as Record<(typeof AUTOTAGGER_TABLES)[number], number>;
    for (const t of AUTOTAGGER_TABLES) out[t] = (await tx`delete from ${tx(t)}`).count;
    return out;
  });
}
