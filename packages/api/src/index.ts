import Fastify from 'fastify';
import fastifySwagger from '@fastify/swagger';
import fastifySwaggerUI from '@fastify/swagger-ui';
import fastifyCookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import pino from 'pino';
import path from 'path';
import { fileURLToPath } from 'url';

import { makeDb, runMigrations } from '@liner/db';
import { createReviewRoutes } from './routes/reviews.js';
import { createViewRoutes } from './routes/views.js';
import { createBulkRoutes } from './routes/bulk.js';
import { createUpdateRoutes } from './routes/updates.js';
import { createAuthRoutes } from './routes/auth.js';
import { createLibraryRoutes } from './routes/library.js';
import { createHealthRoutes } from './routes/health.js';
import { createAlbumRoutes } from './routes/albums.js';
import { createJobRoutes } from './routes/jobs.js';
import { createQueueRoutes } from './routes/queue.js';
import { createImageRoutes } from './routes/images.js';
import { createSearchRoutes } from './routes/search.js';
import { createCollectionRoutes } from './routes/collection.js';
import { createIdentifyRoutes } from './routes/identify.js';
import { createArtistsRoutes } from './routes/artists.js';
import { authMiddleware, initAuth } from './middleware/auth.js';
import { errorHandler } from './middleware/errorHandler.js';

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

// Create Fastify app
const app = Fastify({
  logger: true,
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
  logger.warn(`APP_SECRET is ${appSecret.length} hex characters (< 32 bytes); rotate with \`openssl rand -hex 32\` + \`liner-doctor reseal\` (README › Security)`);
}

// Initialize database
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  logger.error('DATABASE_URL environment variable is required');
  process.exit(1);
}

let db: Awaited<ReturnType<typeof makeDb>>;
try {
  await runMigrations(databaseUrl);
  const { initDb } = await import('./db.js');
  db = await initDb(databaseUrl);
  initAuth(db.db);
  logger.info('Database initialized successfully');

  // One-time boot migration: seal plaintext credentials (PLT-5)
  try {
    const { sealSecret, isSealed } = await import('@liner/core');
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
      title: 'Liner API',
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
  });
} catch (err) {
  logger.warn({ err }, 'Web frontend not found; running API-only mode');
}

// SPA history-mode fallback: deep links (/albums, /queue) must serve the
// app shell; only /api gets JSON 404s.
app.setNotFoundHandler(async (request, reply) => {
  if (request.method === 'GET' && !request.url.startsWith('/api/')) {
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

  // Build identity + release feed (PLT-5 / XO-313)
  instance.register(createUpdateRoutes, { prefix: '/api/v1' });

  // Album routes
  instance.register(createAlbumRoutes, { prefix: '/api/v1' });

  // Job routes
  instance.register(createJobRoutes, { prefix: '/api/v1' });

  // Review queue routes
  instance.register(createQueueRoutes, { prefix: '/api/v1' });

  // Image serving
  instance.register(createImageRoutes, { prefix: '/api/v1' });

  // Search (BRW-4)
  instance.register(createSearchRoutes, { prefix: '/api/v1' });

  // Collection (COL-1, GAP-3)
  instance.register(createCollectionRoutes, { prefix: '/api/v1' });

  // Identify triage + coverage metrics (XO-309)
  instance.register(createIdentifyRoutes, { prefix: '/api/v1' });

  // Artists (canonical + unresolved, enrichment, follow) (XO-310)
  instance.register(createArtistsRoutes, { prefix: '/api/v1' });
});

// Start server
const start = async () => {
  try {
    const port = parseInt(process.env.PORT || '3000', 10);
    const host = process.env.HOST || '0.0.0.0';

    await app.listen({ port, host });
    logger.info(`Server running at http://${host}:${port}`);
    logger.info(`API docs at http://${host}:${port}/api/v1/docs`);
  } catch (err) {
    logger.error(err);
    process.exit(1);
  }
};

start();

export default app;
