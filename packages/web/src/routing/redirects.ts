/**
 * Every moved settings address redirects to its new home (spec §8), in one
 * hop and with its query (the Music Connections and Last.fm returns carry
 * ?linked=, ?error=, ?lastfm=, ?queued=; Library care › Background activity
 * ?job=). A row into Library care names its tab: the redirect sets `tab`
 * and keeps every other parameter. The router asks without a role, in
 * beforeLoad, before the role is known; SettingsPage asks again with it,
 * and with the modules' state, once they are. A plain module, not the lazy
 * SettingsPage chunk, so the router can read it.
 *
 * The modules rule: an old address into a module's part never lands on a
 * blank page or an Off value. While the module is on it goes to the part;
 * while it is off, the owner goes to Settings › Modules (where it is turned
 * on) and anyone else to the nearest page they have.
 */
import { MOVED_SECTIONS } from '../pages/moduleSettings';
import type { WorkTab } from '../pages/workTabs';

export type Redirect = { to: string; search: Record<string, unknown> };

export type Who = {
  /** has system.manage */
  owner: boolean;
  /** has at least one server section (settingsNav) */
  hasSettings: boolean;
  /** has library.edit: may open Library care (/work) */
  editor?: boolean;
  /** facet id → on; null while it loads */
  modules?: Readonly<Record<string, boolean | null>>;
};

/** A new home: an address, or a Library care tab. */
type Target = string | { to: '/work'; tab: WorkTab };

/** Rows that hold for anyone, whatever the role. */
const MOVED: Readonly<Record<string, Target>> = {
  '/settings/account': '/you/account',
  // Account and Security are one section in Your settings
  '/settings/security': '/you/account',
  '/settings/appearance': '/you/appearance',
  '/settings/custom-theme': '/you/custom-theme',
  ...Object.fromEntries(Object.entries(MOVED_SECTIONS).map(([from, to]) => [`/settings/${from}`, to])),
  '/settings/system': '/settings/status',
  '/settings/storage': '/settings/status',
  '/settings/deleting': '/settings/library',
  '/settings/providers': '/settings/modules',
  '/settings/users': '/settings/people',
  '/settings/metadata': '/settings/tag-writing',
  // older addresses, each one hop to today's section
  '/settings/tag-writes': '/settings/tag-writing',
  '/settings/scan-roots': '/settings/library',
  '/settings/follow-rules': '/settings/following',
  // Library care's tabs (spec §4)
  '/settings/genre-mapping': { to: '/work', tab: 'genres' },
  '/settings/genres': { to: '/work', tab: 'genres' },
  '/settings/activity': { to: '/work', tab: 'activity' },
  '/jobs': { to: '/work', tab: 'activity' },
  // switched in their Modules row now, no page of their own
  '/settings/modules/playlists': '/settings/modules',
  '/settings/modules/similar-artists': '/settings/modules',
};

/** A module page that holds a person's part, for anyone but the owner: where that part lives now. */
const MODULE_PARTS: Readonly<Record<string, string>> = {
  '/settings/modules/player': '/you/listening',
};

/**
 * A module page whose module is switched in its Modules row: by facet id,
 * where it goes while the module is on, and for whom while it is off.
 */
const MODULE_ROWS: Readonly<Record<string, { id: string; on: Target; off: (who: Who) => string }>> = {
  '/settings/modules/autotagger': {
    id: 'autotagger',
    on: { to: '/work', tab: 'autotagger' },
    // Library care without the tab (Review matches); someone who may not open it, Your settings
    off: (who) => (who.owner ? '/settings/modules' : who.editor ? '/work' : '/you'),
  },
  '/settings/modules/dj': { id: 'dj', on: '/you/dj', off: personalOff },
  '/settings/modules/listen-elsewhere': { id: 'listen-links', on: '/you/listen-elsewhere', off: personalOff },
  '/settings/modules/music-connections': { id: 'mc', on: '/you/connections', off: personalOff },
};

function personalOff(who: Who): string {
  return who.owner ? '/settings/modules' : '/you/account';
}

/**
 * The state of each module a module row needs, from GET /facets (facet id →
 * on; null while it loads): a module the server does not name is off.
 */
export function moduleStates(enabled: Readonly<Record<string, boolean>> | null): Record<string, boolean | null> {
  return Object.fromEntries(Object.values(MODULE_ROWS).map(({ id }) => [id, enabled ? enabled[id] === true : null]));
}

/** The module (facet id) an address waits for before it can redirect, or null. */
export function moduleRowOf(pathname: string): string | null {
  return MODULE_ROWS[trim(pathname)]?.id ?? null;
}

const has = (search: Record<string, unknown>, key: string) => search[key] !== undefined && search[key] !== null && search[key] !== '';

/** A return to a person's own page, whoever the person is. */
function personalReturn(path: string, search: Record<string, unknown>): string | null {
  if (path === '/settings/modules/music-connections' && (has(search, 'linked') || has(search, 'error'))) return '/you/connections';
  if (path === '/settings/modules/player' && has(search, 'lastfm')) return '/you/listening';
  return null;
}

/**
 * Where a moved address goes, or null when it stays. Without `who` only the
 * role-free rows apply; with it, a module row goes by its module's state
 * (null until `who.modules` knows it), a non-owner's Player page and
 * Modules go to Your settings, and /settings goes there for someone with
 * no server section.
 */
export function redirectFor(pathname: string, search: Record<string, unknown>, who?: Who): Redirect | null {
  const path = trim(pathname);
  const to = MOVED[path] ?? personalReturn(path, search) ?? (who ? moduleRow(path, who) ?? roleRow(path, who) : null);
  if (!to) return null;
  if (typeof to !== 'string') return { to: to.to, search: { ...search, tab: to.tab } };
  if (to === '/work') {
    // Library care on its first tab: any tab the address came with goes
    const { tab: _tab, ...rest } = search;
    return { to, search: rest };
  }
  return { to, search };
}

function trim(pathname: string): string {
  return pathname.length > 1 ? pathname.replace(/\/+$/, '') || '/' : pathname;
}

/** A module row, once the module's state is known (true or false); else null and the page waits. */
function moduleRow(path: string, who: Who): Target | null {
  const row = MODULE_ROWS[path];
  const on = row ? who.modules?.[row.id] : undefined;
  if (!row || typeof on !== 'boolean') return null;
  return on ? row.on : row.off(who);
}

function roleRow(path: string, who: Who): Target | null {
  if (!who.owner) {
    const part = MODULE_PARTS[path];
    if (part) return part;
    // Modules is the owner's now; others found their module parts there before
    if (path === '/settings/modules') return '/you';
  }
  if (!who.hasSettings && path === '/settings') return '/you';
  return null;
}
