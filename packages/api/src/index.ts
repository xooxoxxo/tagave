import Fastify from 'fastify';
import fastifySwagger from '@fastify/swagger';
import fastifySwaggerUI from '@fastify/swagger-ui';
import fastifyCookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import pino from 'pino';
import path from 'path';
import { fileURLToPath } from 'url';

import { makeDb, runMigrations } from '@liner/db';
import { createAuthRoutes } from './routes/auth.js';
import { createLibraryRoutes } from './routes/library.js';
import { createHealthRoutes } from './routes/health.js';
import { createAlbumRoutes } from './routes/albums.js';
import { createJobRoutes } from './routes/jobs.js';
import { createQueueRoutes } from './routes/queue.js';
import { createImageRoutes } from './routes/images.js';
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
  logger: process.env.NODE_ENV !== 'production' ? true : false,
  requestIdHeader: 'x-request-id',
  requestIdLogLabel: 'requestId',
});

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

  // Album routes
  instance.register(createAlbumRoutes, { prefix: '/api/v1' });

  // Job routes
  instance.register(createJobRoutes, { prefix: '/api/v1' });

  // Review queue routes
  instance.register(createQueueRoutes, { prefix: '/api/v1' });

  // Image serving
  instance.register(createImageRoutes, { prefix: '/api/v1' });
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
