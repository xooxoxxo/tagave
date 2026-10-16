/**
 * The module manifests (design §4). Library, collection and reviews are
 * built-in: always on, their tables stay where they are, each provides its
 * facets through a thin adapter. The player and Music Connections are
 * modules: off means their jobs skip, their UI hides and their facets are
 * unavailable, and their data stays.
 */
import { defineModule, type ModuleManifest } from './define.js';

export const LIBRARY_MODULE = defineModule({
  id: 'library',
  version: '1.0.0',
  builtIn: true,
  provides: [
    { facet: 'album.identity', version: '1.0' },
    { facet: 'album.rating', version: '1.0' },
    { facet: 'album.listens', version: '1.0' },
  ],
  consumes: [],
  enabled: () => true,
});

export const COLLECTION_MODULE = defineModule({
  id: 'collection',
  version: '1.0.0',
  builtIn: true,
  provides: [{ facet: 'album.collection', version: '1.0' }],
  consumes: [],
  enabled: () => true,
});

export const REVIEWS_MODULE = defineModule({
  id: 'reviews',
  version: '1.0.0',
  builtIn: true,
  // CritiqueBrainz and Wikipedia (external_reviews)
  provides: [{ facet: 'album.critic-scores', version: '1.0', table: 'external_reviews' }],
  consumes: [],
  enabled: () => true,
});

export const PLAYER_MODULE = defineModule({
  id: 'player',
  version: '1.0.0',
  provides: [{ facet: 'track.playable', version: '1.0', table: 'player_track_map' }],
  consumes: [{ facet: 'album.rating', range: '^1.0' }],
  jobs: ['player.scan'],
  prefix: 'player_',
  tables: [
    'player_links', 'player_events', 'player_listens', 'player_plays', 'player_poll_state', 'player_rating_sync',
    'player_retired_accounts', 'player_scan_requests', 'player_scrobbles', 'player_song_counts', 'player_track_map', 'player_users',
    'scrobble_accounts',
  ],
  enabled: (ctx) => ctx.playerUrl !== null && ctx.playerUrl !== '',
});

export const MC_MODULE = defineModule({
  id: 'mc',
  version: '1.0.0',
  provides: [
    { facet: 'album.critic-scores', version: '1.0', table: 'mc_critic_scores' },
    { facet: 'album.identity', version: '1.0', table: 'mc_identity' },
    { facet: 'album.wantlist-suggestion', version: '1.0', table: 'mc_wantlist_suggestions' },
  ],
  consumes: [
    { facet: 'album.identity', range: '^1.0' },
    { facet: 'album.rating', range: '^1.0' },
    { facet: 'album.collection', range: '^1.0' },
    { facet: 'album.listens', range: '^1.0' },
  ],
  gapFills: [{ kind: 'album', field: 'mbid' }],
  jobs: ['connections.pull', 'mc.purge'],
  prefix: 'mc_',
  tables: [
    'mc_links', 'mc_pending', 'mc_oauth_clients', 'mc_oauth_requests', 'mc_oauth_tokens',
    'mc_critic_scores', 'mc_identity', 'mc_wantlist_suggestions',
  ],
  enabled: (ctx) => ctx.settings.mcEnabled,
});

export const MODULES: readonly ModuleManifest[] = [LIBRARY_MODULE, COLLECTION_MODULE, REVIEWS_MODULE, PLAYER_MODULE, MC_MODULE];
