/**
 * Settings › Modules › <module>: every module's settings live on its own
 * page under Modules (2026-11-04, direction A). The slug is the address,
 * the id the module's manifest id (packages/core › facets/manifests.ts);
 * a module the catalogue adds later gets a page of its own under its id.
 */
export interface ModulePageEntry {
  slug: string;
  /** manifest id */
  id: string;
  name: string;
}

export const MODULE_PAGES: readonly ModulePageEntry[] = [
  { slug: 'player', id: 'player', name: 'Player' },
  { slug: 'dj', id: 'dj', name: 'DJ' },
  { slug: 'lidarr', id: 'lidarr', name: 'Lidarr' },
  { slug: 'listen-elsewhere', id: 'listen-links', name: 'Listen elsewhere' },
  { slug: 'music-connections', id: 'mc', name: 'Music Connections' },
  { slug: 'playlists', id: 'playlists', name: 'Playlists' },
  { slug: 'similar-artists', id: 'similar-artists', name: 'Similar artists' },
];

/** The page of a module by its manifest id (a catalogue module unknown here: its id). */
export function moduleSlug(id: string): string {
  return MODULE_PAGES.find((m) => m.id === id)?.slug ?? id;
}

/**
 * Where the old settings sections went: /settings/<old> → /settings/modules/<slug>.
 * Links in docs, release notes and owner asks keep working.
 */
export const MOVED_SECTIONS: Readonly<Record<string, string>> = {
  connections: 'music-connections',
  'listen-elsewhere': 'listen-elsewhere',
  playback: 'player',
  listening: 'player',
};
