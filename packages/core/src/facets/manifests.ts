/**
 * The app and module manifests (design §4; Core Platform Architecture §2.5,
 * §2.6, manifest v2). Music is the one app. Library, collection and reviews
 * are built-in parts of it: always on, their tables stay where they are,
 * each provides its facets through a thin adapter. The player, Music
 * Connections, Listen elsewhere and playlists are modules that work with
 * music: off means their jobs skip, their UI hides and their facets are
 * unavailable, and their data stays.
 *
 * An in-process module is switched in the module ledger (installed_modules):
 * a boot makes its row at defaultEnabled (syncInstalledModules), and
 * ctx.enabled(id) reads it. Its tables, in purge order, are what doctor
 * purge-module empties, unless it fills core gaps (Music Connections), which
 * only its own removal can revert.
 */
import { defineApp, defineModule, type AppManifest, type ModuleManifest } from './define.js';

/**
 * Music: audio files grouped into albums by cluster.dir. Always on while it
 * is the only app. Its tables are in the core chain.
 */
export const MUSIC_APP = defineApp({
  id: 'music',
  version: '1.0.0',
  builtIn: true,
  defaultEnabled: true,
  fileTypes: ['audio'],
  grouping: { queue: 'cluster.dir' },
});

export const APPS: readonly AppManifest[] = [MUSIC_APP];

/** What every music module accepts of the music app. */
const MUSIC_1 = [{ app: 'music', range: '^1.0' }] as const;

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
  // Core facet transport (0048, 0050): the change log every facet writes,
  // where in-process consumers stopped reading it, and the gap-fill ledger.
  // Core keeps them whichever modules are on; listed so the schema test
  // (every module-ish table has an owner) has one place to look.
  tables: ['facet_changes', 'facet_cursors', 'identity_fills'],
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
  // its services are a compose profile; the updater switches it (TAGAVE_PLAYER_URL)
  kind: 'container',
  compatibleWith: MUSIC_1,
  provides: [{ facet: 'track.playable', version: '1.0', table: 'player_track_map' }],
  consumes: [{ facet: 'album.rating', range: '^1.0' }],
  jobs: ['player.scan'],
  prefix: 'player_',
  tables: [
    'player_links', 'player_events', 'player_listens', 'player_plays', 'player_poll_state', 'player_queue_state', 'player_rating_sync',
    'player_retired_accounts', 'player_scan_requests', 'player_scrobbles', 'player_song_counts', 'player_track_map', 'player_users',
    'scrobble_accounts',
  ],
  enabled: (ctx) => ctx.playerUrl !== null && ctx.playerUrl !== '',
});

export const MC_MODULE = defineModule({
  id: 'mc',
  version: '1.0.0',
  compatibleWith: MUSIC_1,
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
  // a value is what a linked app sent: its source label is the app, the outlet is in the data
  relays: true,
  tables: [
    'mc_links', 'mc_pending', 'mc_oauth_clients', 'mc_oauth_requests', 'mc_oauth_tokens',
    'mc_critic_scores', 'mc_identity', 'mc_wantlist_suggestions',
  ],
  // off until the owner turns it on (Settings › Modules)
  defaultEnabled: false,
});

/**
 * Listen elsewhere (vault "tagave - External Players Scoping", phase 1):
 * links from albums to the streaming platforms each person picks. Off: the
 * resolve job skips and the Listen control hides; the data stays until
 * "Delete its data" (api › routes/listenLinks.ts).
 */
export const LISTEN_LINKS_MODULE = defineModule({
  id: 'listen-links',
  version: '1.0.0',
  compatibleWith: MUSIC_1,
  provides: [],
  consumes: [],
  jobs: ['listenLinks.resolve'],
  prefix: 'listen_',
  tables: ['listen_links', 'listen_artist_links', 'listen_album_checks', 'listen_artist_checks', 'listen_prefs'],
  // off until the owner turns it on: it asks outside services about albums
  defaultEnabled: false,
});

/**
 * Playlists: each person's private lists of tracks (0056). Off: the
 * Playlists page and "Add to playlist" hide; the data stays until "Delete
 * its data" (api › routes/playlists.ts). On from the start.
 */
export const PLAYLISTS_MODULE = defineModule({
  id: 'playlists',
  version: '1.0.0',
  compatibleWith: MUSIC_1,
  provides: [],
  consumes: [],
  prefix: 'playlist',
  tables: ['playlist_items', 'playlists'],
  // it reaches nothing outside tagave, so an install has it from the start
  defaultEnabled: true,
});

export const MODULES: readonly ModuleManifest[] = [LIBRARY_MODULE, COLLECTION_MODULE, REVIEWS_MODULE, PLAYER_MODULE, MC_MODULE, LISTEN_LINKS_MODULE, PLAYLISTS_MODULE];

/** A ledger row (installed_modules) for every app and in-process module: what a boot syncs. */
export interface LedgerEntry {
  id: string;
  kind: 'app' | 'in-process';
  version: string;
  defaultEnabled: boolean;
}

export function ledgerEntries(apps: readonly AppManifest[] = APPS, modules: readonly ModuleManifest[] = MODULES): LedgerEntry[] {
  return [
    ...apps.map((a) => ({ id: a.id, kind: 'app' as const, version: a.version, defaultEnabled: a.builtIn || a.defaultEnabled })),
    ...modules.filter((m) => !m.builtIn && m.kind === 'in-process').map((m) => ({ id: m.id, kind: 'in-process' as const, version: m.version, defaultEnabled: m.defaultEnabled })),
  ];
}
