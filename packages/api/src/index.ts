import Fastify from 'fastify';
import fastifySwagger from '@fastify/swagger';
import fastifySwaggerUI from '@fastify/swagger-ui';
import fastifyCookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import pino from 'pino';
import path from 'path';
import { fileURLToPath } from 'url';

import { makeDb } from '@tagave/db';
import { AuthConfigError, createAuth, ensureCredentialAccounts, passkeysCanWork, readAuthEnv } from '@tagave/auth';
import { readBuildInfo } from '@tagave/core';
import { migrateOnBoot } from '@tagave/doctor';
import { createReviewRoutes } from './routes/reviews.js';
import { createViewRoutes } from './routes/views.js';
import { createBulkRoutes } from './routes/bulk.js';
import { createUpdateRoutes, startUpdateChecks } from './routes/updates.js';
import { createUpdaterInternalRoutes, createUpdaterRoutes } from './routes/updater.js';
import { createAuthRoutes } from './routes/auth.js';
import { createBetterAuthRoutes } from './routes/betterAuth.js';
import { createLibraryRoutes } from './routes/library.js';
import { createHealthRoutes } from './routes/health.js';
import { createSystemRoutes } from './routes/system.js';
import { createAlbumRoutes } from './routes/albums.js';
import { createFieldLocksRoutes } from './routes/fieldLocks.js';
import { createJobRoutes } from './routes/jobs.js';
import { createQueueRoutes } from './routes/queue.js';
import { createReviewMatchesRoutes } from './routes/reviewMatches.js';
import { createGapRoutes } from './routes/gaps.js';
import { createImageRoutes } from './routes/images.js';
import { createSearchRoutes } from './routes/search.js';
import { createCollectionRoutes } from './routes/collection.js';
import { createIdentifyRoutes } from './routes/identify.js';
import { createFingerprintRoutes } from './routes/fingerprint.js';
import { createArtistsRoutes } from './routes/artists.js';
import { createTagPlansRoutes } from './routes/tagPlans.js';
import { createBackupRoutes } from './routes/backups.js';
import { createStorageRoutes } from './routes/storage.js';
import { createPlayerRoutes } from './routes/player.js';
import { startPlayerScanWorker } from './lib/player.js';
import { createPlayerListeningRoutes } from './routes/playerListening.js';
import { startPlayerPeopleWorker } from './lib/playerSync.js';
import { getSql } from './db.js';
import { BackupService, applyBackupSchedule, startBackupScheduler } from './lib/backupService.js';
import { getBoss, setBossLogger } from './boss.js';
import { authMiddleware, initAuth } from './middleware/auth.js';
import { errorHandler } from './middleware/errorHandler.js';
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

// Register Swagger/OpenAPI
await app.register(fastifySwagger, {
  openapi: {
    info: {
      title: 'tagave API',
      version: '1.0.0',
      description: 'Music archive catalog API',
    },
    servers: [
      {
        url: '/api/v1',
        description: 'API v1',
      },
    ],
  },
});

await app.register(fastifySwaggerUI, {
  routePrefix: '/api/v1/docs',
});

app.get('/api/v1/openapi.json', async () => app.swagger());

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

// Error handler and auth hook must live on the ROOT instance — registering
// them as plugins would encapsulate them away from sibling route plugins.
await errorHandler(app);
await authMiddleware(app);

// Health check endpoint (no auth required)
app.register(createHealthRoutes, { prefix: '/api/v1' });

// Signed by the updater instead of a session (opt-in updater)
app.register(createUpdaterInternalRoutes, { prefix: '/api/v1' });

// Better Auth: /api/auth/* (sign-in, sign-out, session, 2FA, passkeys)
app.register(createBetterAuthRoutes);

// Auth routes (no auth required for setup/login)
app.register(createAuthRoutes, { prefix: '/api/v1/auth' });

// Protected routes
app.register(async (instance) => {
  // Require authentication for all routes below this point
  instance.addHook('preHandler', async (request, reply) => {
    // Skip auth check for health and auth endpoints
    if (request.url.startsWith('/api/v1/health') || request.url.startsWith('/api/v1/auth')) {
      return;
    }

    if (!request.user) {
      reply.status(401).send({
        status: 401,
        title: 'Unauthorized',
        detail: 'Authentication required',
      });
    }
  });

  // Library routes
  instance.register(createLibraryRoutes, { prefix: '/api/v1/libraries' });

  // Reviews, listens, clippings (REV-1..3)
  instance.register(createReviewRoutes, { prefix: '/api/v1' });

  // Saved grid views (BRW-1)
  instance.register(createViewRoutes, { prefix: '/api/v1' });

  // Bulk actions on a grid selection (§14.2)
  instance.register(createBulkRoutes, { prefix: '/api/v1' });

  // System checks with a fix per failure (status page, first-run wizard)
  instance.register(createSystemRoutes, { prefix: '/api/v1' });

  // Build identity + release feed (PLT-5 / XO-313)
  instance.register(createUpdateRoutes, { prefix: '/api/v1' });
  // The opt-in updater: start an update, follow its run (owner, step-up)
  instance.register(createUpdaterRoutes, { prefix: '/api/v1' });

  // Album routes
  instance.register(createAlbumRoutes, { prefix: '/api/v1' });

  // Field locks and history (M2)
  instance.register(createFieldLocksRoutes, { prefix: '/api/v1' });

  // Job routes
  instance.register(createJobRoutes, { prefix: '/api/v1' });

  // Review queue routes
  instance.register(createQueueRoutes, { prefix: '/api/v1' });
  // Review matches: auto-accept rules, pasted editions
  instance.register(createReviewMatchesRoutes, { prefix: '/api/v1' });

  // Gaps, their three-way decisions and the Tasks list (0032)
  instance.register(createGapRoutes, { prefix: '/api/v1' });

  // Image serving
  instance.register(createImageRoutes, { prefix: '/api/v1' });

  // Search (BRW-4)
  instance.register(createSearchRoutes, { prefix: '/api/v1' });

  // Collection (COL-1, GAP-3)
  instance.register(createCollectionRoutes, { prefix: '/api/v1' });

  // Identify triage + coverage metrics (XO-309)
  instance.register(createIdentifyRoutes, { prefix: '/api/v1' });
  instance.register(createFingerprintRoutes, { prefix: '/api/v1' });

  // Artists (canonical + unresolved, enrichment, follow) (XO-310)
  instance.register(createArtistsRoutes, { prefix: '/api/v1' });

  // Tag plans (M2)
  instance.register(createTagPlansRoutes, { prefix: '/api/v1/libraries/:libraryId' });

  // Database backups (Settings › Backups)
  instance.register(createBackupRoutes, {
    prefix: '/api/v1',
    service: backupService,
    onSettingsChanged: async () => applyBackupSchedule(await getBoss(), backupService),
  });

  // Settings › Storage: disk use and the tag-change cleanup (owner only)
  instance.register(createStorageRoutes, { prefix: '/api/v1', backupDir: backupService.dir, cacheDir: process.env.CACHE_DIR || undefined });

  // The opt-in player: capabilities, Settings › Playback, queue, stream proxy, play events
  instance.register(createPlayerRoutes, { prefix: '/api/v1' });
  // The player per person: listening history, Last.fm and ListenBrainz, phone-app passwords
  instance.register(createPlayerListeningRoutes, { prefix: '/api/v1' });
});

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
    // Plays → listens, accounts on the player server, scrobbles, ratings out.
    startPlayerPeopleWorker({ sql: getSql(), log: logger });
  } catch (err) {
    logger.error(err);
    process.exit(1);
  }
};

start();

export default app;
