import Fastify from 'fastify';
import fastifyCookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import pino from 'pino';
import path from 'path';
import { fileURLToPath } from 'url';

import { makeDb } from '@tagave/db';
import { AuthConfigError, createAuth, ensureCredentialAccounts, passkeysCanWork, readAuthEnv } from '@tagave/auth';
import { readBuildInfo } from '@tagave/core';
import { migrateOnBoot } from '@tagave/doctor';
import { startUpdateChecks } from './routes/updates.js';
import { startPlayerScanWorker } from './lib/player.js';
import { getSql } from './db.js';
import { BackupService, startBackupScheduler } from './lib/backupService.js';
import { getBoss, setBossLogger } from './boss.js';
import { initAuth } from './middleware/auth.js';
import { registerApiRoutes } from './app.js';
import { servesAppShell, staticCacheControl } from './lib/staticCache.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Initialize logger
const loggerConfig = {
  level: process.env.LOG_LEVEL || 'info',
  ...(process.env.NODE_ENV !== 'production' && {
    transport: {
      target: 'pino-pretty',
      options: {
        colorize: true,
      },
    },
  }),
};

const logger = pino(loggerConfig);
setBossLogger(logger);

// Last-resort loggers: a stray rejected promise (a pool error surfacing
// through an un-awaited call) is logged instead of taking the process down
// unnoticed; an uncaught exception is logged, then the process exits as
// Node would (Docker restarts it).
process.on('unhandledRejection', (reason) => {
  logger.error({ err: reason }, 'unhandled promise rejection');
});
process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'uncaught exception; exiting');
  process.exit(1);
});

// Create Fastify app
const app = Fastify({
  // LOG_LEVEL applies to request logs too (was always info).
  logger: { level: process.env.LOG_LEVEL || 'info' },
  requestIdHeader: 'x-request-id',
  requestIdLogLabel: 'requestId',
});

// Validate APP_SECRET (required for credential encryption)
const appSecret = process.env.APP_SECRET;
if (!appSecret) {
  logger.error('APP_SECRET environment variable is required (see .env.example)');
  process.exit(1);
}

// APP_SECRET length: refuse anything under 32 characters; a hex-only value
// under 64 characters carries fewer than 32 bytes of entropy, which is a
// warning (existing installs keep booting) with the rotation path spelled out.
const isHex = /^[0-9a-fA-F]+$/.test(appSecret);
if (appSecret.length < 32) {
  logger.error(`APP_SECRET too short: ${appSecret.length} < 32 characters. Generate with: openssl rand -hex 32`);
  process.exit(1);
}
if (isHex && appSecret.length < 64) {
  logger.warn(`APP_SECRET is ${appSecret.length} hex characters (< 32 bytes); rotate with \`openssl rand -hex 32\` + \`tagave-doctor reseal\` (README › Security)`);
}

// Sign-in settings: PUBLIC_URL is required (Better Auth base URL, trusted
// origin, passkey relying-party ID).
let authEnv: ReturnType<typeof readAuthEnv>;
try {
  authEnv = readAuthEnv(process.env);
} catch (err) {
  if (err instanceof AuthConfigError) {
    logger.error(err.message);
    process.exit(1);
  }
  throw err;
}
if (!passkeysCanWork(authEnv.publicUrl)) {
  logger.warn(`PUBLIC_URL is ${authEnv.publicUrl.origin}: browsers allow passkeys and security keys only on https or localhost. Password and authenticator-app sign-in still work.`);
}

// Initialize database
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  logger.error('DATABASE_URL environment variable is required');
  process.exit(1);
}

let db: Awaited<ReturnType<typeof makeDb>>;
try {
  // Advisory lock, newer-schema refusal, verified pg_dump, then migrations.
  // Any refusal exits here with a plain message before the app listens.
  try {
    const result = await migrateOnBoot({
      databaseUrl,
      appVersion: readBuildInfo().version,
      log: (msg) => logger.info(msg),
    });
    if (result.applied.length > 0) {
      logger.info({ applied: result.applied, backup: result.backup?.path ?? null }, 'Migrations applied');
    }
  } catch (err) {
    logger.error((err as Error).message);
    logger.error('The app did not start. Run `tagave-doctor doctor` (or read GET /api/v1/health once it is up) for the full check list.');
    process.exit(1);
  }
  const { initDb } = await import('./db.js');
  db = await initDb(databaseUrl);
  const authHandle = createAuth({ env: authEnv, databaseUrl });
  initAuth(authHandle);
  // Rollback-and-return: users written by 0.6.x get their credential account.
  const healed = await ensureCredentialAccounts(authHandle.sql);
  if (healed > 0) logger.info(`Created the sign-in account for ${healed} user(s) written by an older version`);
  logger.info('Database initialized successfully');

  // One-time boot migration: seal plaintext credentials (PLT-5)
  try {
    const { sealSecret, isSealed } = await import('@tagave/core');
    const libraries = await db.client`
      select id, settings from libraries
      where settings->>'discogsToken' is not null
         or settings->>'acoustidKey' is not null
    ` as unknown as Array<{ id: string; settings: Record<string, any> }>;

    let sealed = 0;
    for (const lib of libraries) {
      const settings = typeof lib.settings === 'string'
        ? JSON.parse(lib.settings)
        : lib.settings;

      let needsUpdate = false;

      // Seal discogsToken if present and not already sealed
      if (settings.discogsToken && typeof settings.discogsToken === 'string' && !isSealed(settings.discogsToken)) {
        const hint = settings.discogsToken.slice(-4);
        settings.discogsToken = sealSecret(settings.discogsToken, appSecret);
        settings.discogsTokenHint = hint;
        needsUpdate = true;
      }

      // Seal acoustidKey if present and not already sealed
      if (settings.acoustidKey && typeof settings.acoustidKey === 'string' && !isSealed(settings.acoustidKey)) {
        const hint = settings.acoustidKey.slice(-4);
        settings.acoustidKey = sealSecret(settings.acoustidKey, appSecret);
        settings.acoustidKeyHint = hint;
        needsUpdate = true;
      }

      if (needsUpdate) {
        await db.client`
          update libraries set settings = ${JSON.stringify(settings)}
          where id = ${lib.id}
        `;
        sealed++;
      }
    }

    if (sealed > 0) {
      logger.info(`Sealed ${sealed} library credential(s) during boot migration`);
    }
  } catch (migrationErr) {
    logger.error({ err: migrationErr }, 'Boot migration failed (non-fatal)');
  }
} catch (err) {
  logger.error({ err }, 'Failed to initialize database');
  process.exit(1);
}

// Database backups: nightly schedule + Settings › Backups (the app image
// ships pg_dump and mounts the backups folder).
const backupService = new BackupService({ databaseUrl });

// Register plugins
await app.register(fastifyCookie);

// CORS configuration - relaxed for development, should be restricted in production
app.register(async (fastify) => {
  fastify.register(async (instance) => {
    instance.addHook('onRequest', async (request, reply) => {
      const origin = request.headers.origin;
      const allowedOrigins = (process.env.ALLOWED_ORIGINS || 'http://localhost:3001').split(',');

      if (allowedOrigins.includes(origin || '') || allowedOrigins.includes('*')) {
        reply.header('Access-Control-Allow-Origin', origin || '*');
        reply.header('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
        reply.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-CSRF-Token');
        reply.header('Access-Control-Allow-Credentials', 'true');
      }

      if (request.method === 'OPTIONS') {
        reply.code(200).send();
      }
    });
  });
});

// OpenAPI and its docs page are registered with the API routes (app.ts).

// Static file serving (web frontend)
const webDistPath = path.join(__dirname, '../../web/dist');
try {
  await app.register(fastifyStatic, {
    root: webDistPath,
    prefix: '/',
    // dist/ carries .br/.gz written at build (web/scripts/precompress.mjs);
    // served by Accept-Encoding, with Vary set by the plugin.
    preCompressed: true,
    cacheControl: false,
    setHeaders: (reply, filePath) => { reply.header('cache-control', staticCacheControl(filePath)); },
  });
} catch (err) {
  logger.warn({ err }, 'Web frontend not found; running API-only mode');
}

// SPA history-mode fallback: deep links (/albums, /queue) must serve the
// app shell; /api and missing /assets files get JSON 404s.
app.setNotFoundHandler(async (request, reply) => {
  if (servesAppShell(request.method, request.url)) {
    return reply.sendFile('index.html', webDistPath);
  }
  return reply.status(404).send({ status: 404, title: 'Not Found', detail: `Route ${request.method}:${request.url} not found` });
});

// Error handler, session + permission hooks and every /api route (app.ts):
// the same wiring the route-permission tests build.
await registerApiRoutes(app, { backupService, cacheDir: process.env.CACHE_DIR || undefined });

// Start server
const start = async () => {
  try {
    const port = parseInt(process.env.PORT || '3000', 10);
    const host = process.env.HOST || '0.0.0.0';

    await app.listen({ port, host });
    // Release feed: checked in the background at most every 12 hours.
    startUpdateChecks(app.log);
    logger.info(`Server running at http://${host}:${port}`);
    logger.info(`API docs at http://${host}:${port}/api/v1/docs`);

    // After listen: a slow pg-boss start must not hold up the health check.
    try {
      await startBackupScheduler(await getBoss(), backupService, logger);
      const s = await backupService.settings();
      logger.info({ dir: backupService.dir, enabled: s.enabled, hour: s.hour, tz: backupService.timeZone }, 'backup schedule applied');
    } catch (err) {
      logger.error({ err }, 'could not start the nightly backup schedule');
    }
    // The player module's scans: the API works this queue itself, so the
    // player credentials never leave the app.
    try {
      await startPlayerScanWorker(await getBoss(), getSql(), logger);
    } catch (err) {
      logger.error({ err }, 'could not start the player scan worker');
    }
  } catch (err) {
    logger.error(err);
    process.exit(1);
  }
};

start();

export default app;
