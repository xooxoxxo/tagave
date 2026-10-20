#!/usr/bin/env node
/**
 * Site screenshots, reproducible: builds a demo library of silent FLACs,
 * starts a throwaway tagave from this checkout against it, waits for
 * identification / enrichment / cover art, then captures the landing-page
 * shots into site/img/. See README.md next to this file.
 *
 *   node scripts/site-shots/run.mjs [--only albums,plan] [--hold] [--keep]
 *
 * --only   capture only these shots (names in lib/shots.mjs)
 * --hold   after the library is ready, keep the stack up until Ctrl-C (to
 *          look around at the printed address); nothing is captured
 * --keep   leave the run folder (logs, library) behind
 */
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildLibrary } from './lib/library.mjs';
import { Stack, until } from './lib/stack.mjs';
import { prepareLibrary } from './lib/prepare.mjs';
import { captureShots, SHOTS } from './lib/shots.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../..');
const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const value = (name) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };
const only = value('only')?.split(',').map((s) => s.trim()).filter(Boolean);
if (only) for (const n of only) if (!SHOTS.includes(n)) throw new Error(`unknown shot "${n}" (known: ${SHOTS.join(', ')})`);

const started = Date.now();
const elapsed = () => `${Math.round((Date.now() - started) / 1000)}s`;
const log = (msg) => console.log(`[${elapsed().padStart(5)}] ${msg}`);

const runId = randomBytes(3).toString('hex');
const runDir = await mkdtemp(path.join(os.tmpdir(), `siteshots-${runId}-`));
const musicDir = path.join(runDir, 'music');
// MusicBrainz responses: SITESHOTS_CACHE keeps them between runs.
const cacheDir = process.env.SITESHOTS_CACHE ?? path.join(runDir, 'mb-cache');
await mkdir(path.join(runDir, 'cache'), { recursive: true });

const requireFromDb = createRequire(path.join(repo, 'packages/db/package.json'));
const postgres = (await import(pathToFileURL(requireFromDb.resolve('postgres')).href)).default;

const stack = new Stack({ repo, runDir, runId, log });
let sql;
let cleaning = false;
async function cleanup(code) {
  if (cleaning) return;
  cleaning = true;
  log('cleaning up');
  await sql?.end({ timeout: 2 }).catch(() => undefined);
  await stack.stop().catch((err) => log(`  ! stop failed: ${err.message}`));
  if (flag('keep')) log(`  kept ${runDir}`);
  else {
    await rm(runDir, { recursive: true, force: true });
    log(`  removed ${runDir}`);
  }
  process.exit(code);
}
process.on('SIGINT', () => void cleanup(130));
process.on('SIGTERM', () => void cleanup(143));

try {
  const { albums } = JSON.parse(await readFile(path.join(here, 'albums.json'), 'utf8'));
  log(`demo library (${albums.length} releases) in ${musicDir}`);
  const library = await buildLibrary({ albums, musicDir, cacheDir, log });

  log('starting tagave');
  await stack.start();
  sql = postgres(stack.databaseUrl, { max: 2, onnotice: () => undefined });

  const session = await prepareLibrary({ stack, sql, musicDir, library, log, until });

  if (flag('hold')) {
    log(`holding: open ${stack.baseUrl} and sign in as ${session.email} / ${session.password}; Ctrl-C to stop`);
    await new Promise(() => undefined);
  }

  const outDir = path.join(repo, 'site/img');
  const written = await captureShots({ repo, stack, session, outDir, only, log, runDir, hooks: session.hooks });
  log(`done: ${written.length} images in site/img`);
  for (const w of written) console.log(`  ${w.file}  ${(w.bytes / 1024).toFixed(1)} KB`);
  await cleanup(0);
} catch (err) {
  console.error(err);
  log(`FAILED: ${err.message}`);
  if (!flag('keep')) log('  (re-run with --keep to look at api.log / worker.log)');
  await cleanup(1);
}
