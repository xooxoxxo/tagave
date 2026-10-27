/**
 * Apps in development (AppManifest.dev: books, the spike) at the app's boot:
 * one that TAGAVE_DEV_APPS no longer names is turned off in the module
 * ledger, so the worker, which follows the ledger, stops too. Its data stays
 * (rule 2); naming it again and turning it on brings it back.
 */
import type postgres from 'postgres';
import { appAllowed, devAppIds, type AppManifest } from '@tagave/core/facets';
import { moduleEnabled, setModuleEnabled } from '@tagave/db';

export async function turnOffDisallowedDevApps(
  sql: postgres.Sql<any>,
  apps: readonly AppManifest[],
  onTurnedOff: (appId: string) => void = () => undefined,
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<void> {
  const dev = devAppIds(env);
  for (const a of apps.filter((x) => !appAllowed(x, dev))) {
    if (await moduleEnabled(sql, a.id)) {
      await setModuleEnabled(sql, a.id, false);
      onTurnedOff(a.id);
    }
  }
}
