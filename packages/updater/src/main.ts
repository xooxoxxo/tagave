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
 *   TAGAVE_UPDATER_STALL_SECONDS   a step that does not move for this long is diagnosed and the cause shown (default 120)
 *
 * From the install's .env, read on every check: MUSIC_DIR (the folder the
 * music self-heal mounts again, music-heal.ts) and TAGAVE_MUSIC_SELF_HEAL
 * (0 turns it off).
 *
 * A repair (repair.ts) tells the app how it settled with a signed
 * POST /api/v1/internal/updater/repair {"status", "cause"}.
 */
import { existsSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_CONFIG } from './update.js';
import { dockerRunner, httpAppProbe, httpRepairReport } from './runner.js';
import { UpdaterService } from './server.js';
import { IMAGE_KEYS_DIR, loadTrustedKeys } from './release.js';
import { MusicHealer, httpMusicApp, selfImage } from './music-heal.js';
import { cachedProber, musicProber } from './music-probe.js';

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

  // The public release keys travel inside this image; with none, every release is refused.
  const keys = await loadTrustedKeys(IMAGE_KEYS_DIR);
  if (keys.length === 0) console.error(JSON.stringify({ msg: `no release key in ${IMAGE_KEYS_DIR}: every update and module is refused` }));
  // One shared music reading, so the healer and an update probe the share once.
  const music = cachedProber(musicProber({ installDir, docker: dockerRunner(installDir) }), Date.now);
  const musicApp = httpMusicApp(appUrl, appSecret);
  const service = new UpdaterService({
    keys,
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
      stallMs: num('TAGAVE_UPDATER_STALL_SECONDS', DEFAULT_CONFIG.stallMs / 1000) * 1000,
    },
    music,
    musicUnmounted: () => musicApp.unmounted(),
    report: httpRepairReport(appUrl, appSecret),
    // Repair's one-time move to the parent music layout runs its helpers from this container's image.
    layoutImage: () => selfImage(dockerRunner(installDir), hostname()),
  });
  // The healer's tick waits while anything moves containers, a repair too;
  // its remount is refused only during an update or a module run, so a
  // repair's own remount goes through.
  const healer = new MusicHealer({
    installDir,
    docker: dockerRunner(installDir),
    music,
    app: musicApp,
    busy: () => service.moving(),
    updating: () => service.updating(),
    // The installer's one-off repair may run at the same time: each attempt holds .updater/repair.lock.
    lockParts: async () => {
      const got = await service.lockParts('heal');
      return typeof got === 'function' ? got : null;
    },
    log: (m) => console.log(JSON.stringify(m)),
  });
  service.attachHealer(healer);
  // load() picks up a waiting repair, and repairs an update left with stuck parts.
  await service.load();
  // A repair the installer's one-off left waiting gets this process's watcher.
  service.followRepairFile();
  const server = service.listen(port);
  healer.start();
  console.log(JSON.stringify({ msg: 'updater ready', port, installDir, releaseKeys: keys.map((k) => k.id) }));
  const stop = () => { healer.stop(); service.stop(); server.close(() => process.exit(0)); };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

main().catch((err: unknown) => {
  console.error(JSON.stringify({ msg: 'updater failed to start', error: (err as Error).message }));
  process.exit(1);
});
