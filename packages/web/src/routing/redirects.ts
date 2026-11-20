/**
 * Every moved settings address redirects to its new home (spec §8), in one
 * hop and with its query (the Music Connections and Last.fm returns carry
 * ?linked=, ?error=, ?lastfm=, ?queued=; Background activity ?job=). The
 * router asks without a role, in beforeLoad, before the role is known;
 * SettingsPage asks again with it once it is. A plain module, not the lazy
 * SettingsPage chunk, so the router can read it.
 */
import { MOVED_SECTIONS } from '../pages/moduleSettings';

export type Redirect = { to: string; search: Record<string, unknown> };

export type Who = {
  /** has system.manage */
  owner: boolean;
  /** has at least one server section (settingsNav) */
  hasSettings: boolean;
};

/** Rows that hold for anyone, whatever the role. */
const MOVED: Readonly<Record<string, string>> = {
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
  '/settings/genres': '/settings/genre-mapping',
  '/settings/follow-rules': '/settings/following',
};

/** A module page that holds a person's part: where that part lives now. */
const MODULE_PARTS: Readonly<Record<string, string>> = {
  '/settings/modules/player': '/you/listening',
  '/settings/modules/dj': '/you/dj',
  '/settings/modules/listen-elsewhere': '/you/listen-elsewhere',
  '/settings/modules/music-connections': '/you/connections',
};

const has = (search: Record<string, unknown>, key: string) => search[key] !== undefined && search[key] !== null && search[key] !== '';

/** A return to a person's own page, whoever the person is. */
function personalReturn(path: string, search: Record<string, unknown>): string | null {
  if (path === '/settings/modules/music-connections' && (has(search, 'linked') || has(search, 'error'))) return '/you/connections';
  if (path === '/settings/modules/player' && has(search, 'lastfm')) return '/you/listening';
  return null;
}

/**
 * Where a moved address goes, or null when it stays. Without `who` only the
 * role-free rows apply; with it, a non-owner's module pages and Modules go
 * to Your settings, and /settings goes there for someone with no server
 * section.
 */
export function redirectFor(pathname: string, search: Record<string, unknown>, who?: Who): Redirect | null {
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, '') || '/' : pathname;
  const to = MOVED[path] ?? personalReturn(path, search) ?? (who ? roleRow(path, who) : null);
  return to ? { to, search } : null;
}

function roleRow(path: string, who: Who): string | null {
  if (!who.owner) {
    const part = MODULE_PARTS[path];
    if (part) return part;
    // Modules is the owner's now; others found their module parts there before
    if (path === '/settings/modules') return '/you';
  }
  if (!who.hasSettings && path === '/settings') return '/you';
  return null;
}
