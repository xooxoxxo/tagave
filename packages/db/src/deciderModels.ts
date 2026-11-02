/**
 * The local decider's stored models (the autotagger module's decider_models).
 *
 *   activeModel(sql, libraryId, decider)   the model new runs use; null when there
 *                                          is none, or the table is not there (the
 *                                          module's migration never ran)
 *   storeModel(sql, row)                   the new active model: in one transaction
 *                                          the old one is deactivated and the new
 *                                          one inserted, so a library never has two
 *                                          active models, nor none between the two
 *   listModels(sql, libraryId, limit)      the newest first, active or not
 *
 * This package depends on no other tagave package, so the model itself is
 * typed by the caller (core's LocalModel); it is stored and read back as is.
 */
import type postgres from 'postgres';

type Sql = postgres.Sql<any>;
type Tx = postgres.TransactionSql<any>;

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

export const DEFAULT_DECIDER = 'local';

/** What a training counted. */
export interface DeciderModelCounts {
  /** albums with one labelled winner */
  albums: number;
  /** feature rows fitted */
  rows: number;
  /** albums the owner decided */
  owner: number;
  /** albums matched automatically and never reversed */
  auto: number;
  /** candidates the owner rejected, each a negative row */
  rejections: number;
}

export interface NewDeciderModel<M = unknown, X = unknown> {
  libraryId: string;
  /** default 'local' */
  decider?: string;
  version: string;
  featuresSchemaHash: string;
  model: M;
  dataHash: string;
  counts: DeciderModelCounts;
  metrics: X;
}

export interface DeciderModelRow<M = unknown, X = unknown> extends Required<NewDeciderModel<M, X>> {
  id: string;
  active: boolean;
  /** ISO 8601 */
  createdAt: string;
}

interface RawRow {
  id: string; library_id: string; decider: string; version: string; features_schema_hash: string; model: unknown;
  data_hash: string; counts: unknown; metrics: unknown; active: boolean; created_at: Date | string;
}

const json = (v: unknown): unknown => (typeof v === 'string' ? JSON.parse(v) : v);

function rowOf<M, X>(r: RawRow): DeciderModelRow<M, X> {
  return {
    id: r.id,
    libraryId: r.library_id,
    decider: r.decider,
    version: r.version,
    featuresSchemaHash: r.features_schema_hash,
    model: json(r.model) as M,
    dataHash: r.data_hash,
    counts: json(r.counts) as DeciderModelCounts,
    metrics: json(r.metrics) as X,
    active: r.active,
    createdAt: (r.created_at instanceof Date ? r.created_at : new Date(r.created_at)).toISOString(),
  };
}

/** The library's active model of `decider`; null when it has none or the table is missing. */
export async function activeModel<M = unknown, X = unknown>(
  sql: Sql | Tx, libraryId: string, decider: string = DEFAULT_DECIDER,
): Promise<DeciderModelRow<M, X> | null> {
  return orMissing(async () => {
    const [r] = await sql<RawRow[]>`
      select id, library_id, decider, version, features_schema_hash, model, data_hash, counts, metrics, active, created_at
        from decider_models where library_id = ${libraryId} and decider = ${decider} and active`;
    return r ? rowOf<M, X>(r) : null;
  }, null);
}

const isTx = (sql: Sql | Tx): sql is Tx => typeof (sql as Tx).savepoint === 'function';

async function storeIn<M, X>(tx: Tx, row: NewDeciderModel<M, X>): Promise<DeciderModelRow<M, X>> {
  const decider = row.decider ?? DEFAULT_DECIDER;
  // two trainings of one library storing at once take turns here, so the
  // second deactivates the first's model instead of tripping the unique index
  await tx`select pg_advisory_xact_lock(hashtext(${`decider_models:${row.libraryId}:${decider}`}))`;
  await tx`update decider_models set active = false where library_id = ${row.libraryId} and decider = ${decider} and active`;
  const [r] = await tx<RawRow[]>`
    insert into decider_models (library_id, decider, version, features_schema_hash, model, data_hash, counts, metrics, active)
    values (${row.libraryId}, ${decider}, ${row.version}, ${row.featuresSchemaHash}, ${JSON.stringify(row.model)}::text::jsonb,
            ${row.dataHash}, ${JSON.stringify(row.counts)}::text::jsonb, ${JSON.stringify(row.metrics)}::text::jsonb, true)
    returning id, library_id, decider, version, features_schema_hash, model, data_hash, counts, metrics, active, created_at`;
  return rowOf<M, X>(r!);
}

/**
 * Store `row` as the library's active model of its decider, deactivating the
 * one before, in one transaction (the caller's, when given one).
 */
export async function storeModel<M = unknown, X = unknown>(sql: Sql | Tx, row: NewDeciderModel<M, X>): Promise<DeciderModelRow<M, X>> {
  if (isTx(sql)) return storeIn(sql, row);
  return sql.begin((tx) => storeIn(tx, row)) as Promise<DeciderModelRow<M, X>>;
}

/** The library's models of `decider`, newest first; [] when the table is missing. */
export async function listModels<M = unknown, X = unknown>(
  sql: Sql | Tx, libraryId: string, limit = 20, decider: string = DEFAULT_DECIDER,
): Promise<Array<DeciderModelRow<M, X>>> {
  const n = Math.max(1, Math.min(Math.floor(limit), 500));
  return orMissing(async () => {
    const rows = await sql<RawRow[]>`
      select id, library_id, decider, version, features_schema_hash, model, data_hash, counts, metrics, active, created_at
        from decider_models where library_id = ${libraryId} and decider = ${decider}
       order by created_at desc, id desc limit ${n}`;
    return rows.map((r) => rowOf<M, X>(r));
  }, []);
}
