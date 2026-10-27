/**
 * Every /api route and the hooks in front of them, on the root instance.
 * index.ts calls this once; the route-permission tests build the same app
 * with it, so the table they check is the one production serves.
 */
import type { FastifyInstance } from 'fastify';
import fastifySwagger from '@fastify/swagger';
import fastifySwaggerUI from '@fastify/swagger-ui';
import { createReviewRoutes } from './routes/reviews.js';
import { createViewRoutes } from './routes/views.js';
import { createBulkRoutes } from './routes/bulk.js';
import { createUpdateRoutes } from './routes/updates.js';
import { createUpdaterInternalRoutes, createUpdaterRoutes } from './routes/updater.js';
import { createModuleRoutes } from './routes/modules.js';
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
import { createPlayerListeningRoutes } from './routes/playerListening.js';
import { createUserRoutes } from './routes/users.js';
import { createInviteRoutes } from './routes/invites.js';
import { createConnectRoutes, createManifestRoute } from './routes/connect.js';
import { createMcFeedRoutes } from './routes/mcFeeds.js';
import { createMcConnectionRoutes } from './routes/mcConnections.js';
import { createMcWantlistRoutes } from './routes/mcWantlist.js';
import { createFacetRoutes } from './routes/facets.js';
import { createListenLinksRoutes } from './routes/listenLinks.js';
import { createPlayerQueueRoutes } from './routes/playerQueue.js';
import { createPlaylistRoutes } from './routes/playlists.js';
import { applyBackupSchedule, type BackupService } from './lib/backupService.js';
import { getBoss } from './boss.js';
import { authMiddleware } from './middleware/auth.js';
import { errorHandler } from './middleware/errorHandler.js';

export interface ApiRouteDeps {
  backupService: BackupService;
  cacheDir?: string | undefined;
}

export async function registerApiRoutes(app: FastifyInstance, deps: ApiRouteDeps): Promise<void> {
  // Error handler and the session + permission hooks must live on the ROOT
  // instance — registering them as plugins would encapsulate them away from
  // sibling route plugins.
  await errorHandler(app);
  await authMiddleware(app);

  // OpenAPI: registered first so it sees every route below.
  await app.register(fastifySwagger, {
    openapi: {
      info: { title: 'tagave API', version: '1.0.0', description: 'Music archive catalog API' },
      servers: [{ url: '/api/v1', description: 'API v1' }],
    },
  });
  await app.register(fastifySwaggerUI, { routePrefix: '/api/v1/docs' });
  app.get('/api/v1/openapi.json', async () => app.swagger());

  // Health check endpoint (no auth required)
  app.register(createHealthRoutes, { prefix: '/api/v1' });

  // Signed by the updater instead of a session (opt-in updater)
  app.register(createUpdaterInternalRoutes, { prefix: '/api/v1' });

  // Better Auth: /api/auth/* (sign-in, sign-out, session, 2FA, passkeys)
  app.register(createBetterAuthRoutes);

  // Auth routes (no auth required for setup/login)
  app.register(createAuthRoutes, { prefix: '/api/v1/auth' });

  // Invite and set-password links: opened before the person has an account
  app.register(createInviteRoutes, { prefix: '/api/v1' });

  // Music Connections: the manifest (outside /api, public) and the OAuth
  // provider another music app links through. register/authorize/token/revoke
  // are public (the client authenticates itself; authorize only starts a
  // request); the consent page's two routes need a session ('self').
  app.register(createManifestRoute);
  app.register(createConnectRoutes, { prefix: '/api/v1' });
  // The feeds (/mc/v1, outside /api): their own bearer-token gate, deny by
  // default (routes/mcFeeds.ts).
  app.register(createMcFeedRoutes);

  // Every route below needs a session; what each role may do is in
  // permissions/routeTable.ts, checked by the root hook (middleware/auth.ts).
  app.register(async (instance) => {
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
    // Settings › Modules: optional parts from the signed catalogue (owner, step-up)
    instance.register(createModuleRoutes, { prefix: '/api/v1' });

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
      service: deps.backupService,
      onSettingsChanged: async () => applyBackupSchedule(await getBoss(), deps.backupService),
    });

    // Settings › Storage: disk use and the tag-change cleanup (owner only)
    instance.register(createStorageRoutes, { prefix: '/api/v1', backupDir: deps.backupService.dir, cacheDir: deps.cacheDir });

    // The opt-in player: capabilities, Settings › Playback, queue, stream proxy, play events
    instance.register(createPlayerRoutes, { prefix: '/api/v1' });
    // The player per person: listening history, Last.fm and ListenBrainz, phone-app passwords
    instance.register(createPlayerListeningRoutes, { prefix: '/api/v1' });

    // Settings › Users: people, roles, invites (owner)
    instance.register(createUserRoutes, { prefix: '/api/v1' });

    // Settings › Connections: Music Connections links this person made to other apps ('self')
    instance.register(createMcConnectionRoutes, { prefix: '/api/v1' });
    // Wantlist suggestions from linked apps, Accept / Dismiss ('self')
    instance.register(createMcWantlistRoutes, { prefix: '/api/v1' });
    // Facets (what is on, for the app to hide what is off) and the Music Connections module row
    instance.register(createFacetRoutes, { prefix: '/api/v1' });
    // Listen elsewhere: links to streaming platforms, each person's platforms, the module row
    instance.register(createListenLinksRoutes, { prefix: '/api/v1' });
    // The play queue per person (follows them across devices) and their history
    instance.register(createPlayerQueueRoutes, { prefix: '/api/v1' });
    // Playlists: each person's own lists, export and import, the module row
    instance.register(createPlaylistRoutes, { prefix: '/api/v1' });
  });
}
