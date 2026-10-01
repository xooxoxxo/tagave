/**
 * Version skew between a worker and the database (split installs update the
 * app and each worker host separately):
 *  - the app has not applied a migration this worker carries yet: wait, with
 *    backoff, for the app to finish (it migrates when it starts);
 *  - a newer app migrated the database: refuse to start (exit non-zero), and
 *    stop a running worker when that happens under it.
 */
import type postgres from 'postgres';
import { classifySkew, readSchemaState, type SkewVerdict } from '@liner/db';

export class WorkerSchemaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkerSchemaError';
  }
}

export interface SchemaGuardOptions {
  version: string;
  files: string[];
  log: { info: (obj: object, msg: string) => void; warn: (obj: object, msg: string) => void };
  /** Give up waiting for the app after this long (LINER_SCHEMA_WAIT_SECONDS, default 15 min). */
  maxWaitMs?: number;
  /** LINER_ALLOW_SCHEMA_SKEW: start on a newer database anyway. */
  allowSkew?: boolean;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export function schemaWaitMs(env: NodeJS.ProcessEnv): number {
  const s = Number.parseInt(env['LINER_SCHEMA_WAIT_SECONDS'] ?? '', 10);
  return (Number.isFinite(s) && s >= 0 ? s : 15 * 60) * 1000;
}

export function newerMessage(detail: string, version: string): string {
  return (
    `This worker (tagave ${version}) will not run: ${detail}. ` +
    'Update this worker to the same version as the app (with the installer: set TAGAVE_VERSION in .env, then ' +
    '`docker compose pull && docker compose up -d`). Set LINER_ALLOW_SCHEMA_SKEW=1 to run anyway.'
  );
}

/** One look at the database. */
export async function schemaVerdict(sql: postgres.Sql, files: string[], version: string): Promise<SkewVerdict> {
  return classifySkew(await readSchemaState(sql, files), version);
}

/**
 * Resolve once the schema matches this worker; throw WorkerSchemaError when
 * the database is newer, or when the app has not migrated within maxWaitMs.
 * A database that cannot be reached yet is waited for the same way.
 */
export async function waitForCompatibleSchema(sql: postgres.Sql, opts: SchemaGuardOptions): Promise<SkewVerdict> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const now = opts.now ?? Date.now;
  const maxWaitMs = opts.maxWaitMs ?? 15 * 60_000;
  const started = now();
  let delay = 2_000;
  if (opts.files.length === 0) {
    opts.log.warn({}, 'no migration files found next to this worker; skipping the schema check');
    return { verdict: 'ok', detail: 'not checked' };
  }
  for (;;) {
    let verdict: SkewVerdict | null = null;
    let reason: string;
    try {
      verdict = await schemaVerdict(sql, opts.files, opts.version);
      reason = verdict.detail;
    } catch (err) {
      reason = `cannot read the database yet (${(err as Error).message})`;
    }
    if (verdict?.verdict === 'ok') return verdict;
    if (verdict?.verdict === 'newer') {
      if (opts.allowSkew) {
        opts.log.warn({ detail: verdict.detail }, 'LINER_ALLOW_SCHEMA_SKEW is set: running on a database newer than this worker');
        return verdict;
      }
      throw new WorkerSchemaError(newerMessage(verdict.detail, opts.version));
    }
    const waited = now() - started;
    if (waited >= maxWaitMs) {
      throw new WorkerSchemaError(
        `This worker gave up after ${Math.round(waited / 1000)}s waiting for the app to update the database: ${reason}. ` +
          'Start or update the app first (it updates the database when it starts), then restart this worker. ' +
          'LINER_SCHEMA_WAIT_SECONDS sets how long a worker waits.',
      );
    }
    opts.log.info({ detail: reason, retryInMs: delay }, 'waiting for the app to update the database');
    await sleep(Math.min(delay, Math.max(0, maxWaitMs - waited)));
    delay = Math.min(delay * 2, 30_000);
  }
}
