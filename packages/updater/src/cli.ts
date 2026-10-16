#!/usr/bin/env node
/**
 * The module runs for installs without the updater service:
 * install-tagave.sh enable-module / disable-module start this image as a
 * one-off container (Docker socket and install folder mounted, on the
 * install's default network so it reaches the app) and run
 *
 *   node dist/cli.js module enable <id> [--manifest FILE --signature FILE]
 *   node dist/cli.js module disable <id> [--delete-data]
 *
 * The same state machine and the same checks as Settings › Modules: only a
 * module from the signed catalogue of the release that runs here. The
 * manifest is the one next to the install, or the files given (kept there
 * once they check out). Every log line is printed; the exit code is 0 when
 * the run succeeded.
 */
import { readFile } from 'node:fs/promises';
import { DEFAULT_CONFIG } from './update.js';
import { dockerRunner, httpAppProbe } from './runner.js';
import { UpdaterService } from './server.js';
import { IMAGE_KEYS_DIR, loadTrustedKeys } from './release.js';

function usage(): never {
  console.error('usage: cli.js module enable|disable <id> [--delete-data] [--manifest FILE --signature FILE]');
  process.exit(2);
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  if (args[0] !== 'module' || (args[1] !== 'enable' && args[1] !== 'disable') || !args[2]) usage();
  const action = args[1];
  const id = args[2];
  const opt = (name: string) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const installDir = process.env['TAGAVE_INSTALL_DIR'];
  if (!installDir || !installDir.startsWith('/')) throw new Error('TAGAVE_INSTALL_DIR must be the absolute path of the install folder');
  const keys = await loadTrustedKeys(IMAGE_KEYS_DIR);
  const service = new UpdaterService({
    installDir,
    // Only the app's health is asked for; nothing here is signed with it.
    appSecret: 'unused-by-module-runs',
    version: process.env['TAGAVE_BUILD_VERSION'] || 'unknown',
    keys,
    docker: dockerRunner(installDir),
    app: httpAppProbe(process.env['TAGAVE_UPDATER_APP_URL'] || 'http://app:3000', 'unused-by-module-runs'),
    config: { ...DEFAULT_CONFIG, selfUpdate: false },
  });
  const manifest = opt('--manifest');
  if (manifest) {
    const sigFile = opt('--signature');
    const accepted = await service.acceptRelease(await readFile(manifest, 'utf8'), sigFile ? await readFile(sigFile, 'utf8') : '');
    if (!accepted.ok) {
      console.error(`refused: ${accepted.error}`);
      return 1;
    }
  }
  const started = await service.startModule(id, action, args.includes('--delete-data'));
  if (!started.ok) {
    console.error(`refused: ${started.error}`);
    return 1;
  }
  let printed = 0;
  const flush = async () => {
    const run = (await service.modules()).run;
    for (const line of run?.log.slice(printed) ?? []) console.log(`${line.level === 'info' ? '  ' : `${line.level}: `}${line.message}`);
    printed = run?.log.length ?? printed;
    return run;
  };
  const timer = setInterval(() => void flush(), 1000);
  await service.idle();
  clearInterval(timer);
  const run = await flush();
  if (run?.status !== 'succeeded') {
    console.error(`${run?.moduleName ?? id}: ${run?.status ?? 'unknown'}: ${run?.reason ?? ''}`);
    return 1;
  }
  if (run.reason) console.error(run.reason);
  return 0;
}

main().then((code) => process.exit(code), (err: unknown) => {
  console.error((err as Error).message);
  process.exit(1);
});
