#!/usr/bin/env node
/**
 * tagave updater (compose profile "updater"). Configuration comes from the
 * compose service:
 *
 *   APP_SECRET                     signs requests both ways (required)
 *   TAGAVE_INSTALL_DIR             the install folder, mounted at the same path (required)
 *   TAGAVE_UPDATER_APP_URL         the app on the internal network (default http://app:3000)
 *   TAGAVE_UPDATER_PORT            listen port inside the network (default 8080)
 *   TAGAVE_UPDATER_HEALTH_TIMEOUT  seconds the new version may take to answer healthy (default 600)
 *   TAGAVE_UPDATER_MIN_FREE_MB     free space left on Docker's disk after an update's images and backups (default 3072)
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_CONFIG } from './update.js';
import { dockerRunner, httpAppProbe } from './runner.js';
import { UpdaterService } from './server.js';

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  const n = raw === undefined || raw.trim() === '' ? NaN : Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

async function main(): Promise<void> {
  const appSecret = process.env['APP_SECRET'];
  const installDir = process.env['TAGAVE_INSTALL_DIR'];
  if (!appSecret) throw new Error('APP_SECRET is not set');
  if (!installDir || !installDir.startsWith('/')) throw new Error('TAGAVE_INSTALL_DIR must be the absolute path of the install folder');
  if (!existsSync(join(installDir, '.env'))) {
    throw new Error(`there is no .env in ${installDir}: set TAGAVE_INSTALL_DIR in .env to the install folder (install-tagave.sh enable-updater does)`);
  }
  const appUrl = process.env['TAGAVE_UPDATER_APP_URL'] || 'http://app:3000';
  const port = num('TAGAVE_UPDATER_PORT', 8080);

  const service = new UpdaterService({
    installDir,
    appSecret,
    // TAGAVE_BUILD_VERSION; LINER_VERSION is its pre-0.9 name (read until 0.10).
    version: process.env['TAGAVE_BUILD_VERSION'] || process.env['LINER_VERSION'] || 'unknown',
    docker: dockerRunner(installDir),
    app: httpAppProbe(appUrl, appSecret),
    config: {
      ...DEFAULT_CONFIG,
      healthTimeoutMs: num('TAGAVE_UPDATER_HEALTH_TIMEOUT', DEFAULT_CONFIG.healthTimeoutMs / 1000) * 1000,
      minFreeBytes: num('TAGAVE_UPDATER_MIN_FREE_MB', DEFAULT_CONFIG.minFreeBytes / 1024 ** 2) * 1024 ** 2,
    },
  });
  await service.load();
  const server = service.listen(port);
  console.log(JSON.stringify({ msg: 'updater ready', port, installDir }));
  const stop = () => server.close(() => process.exit(0));
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

main().catch((err: unknown) => {
  console.error(JSON.stringify({ msg: 'updater failed to start', error: (err as Error).message }));
  process.exit(1);
});
