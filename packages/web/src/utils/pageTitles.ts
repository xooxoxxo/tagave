/**
 * The name of each main page: the sidebar's link labels and, on a phone, the
 * top bar's title (in place of the wordmark). One map, so the two never
 * drift apart. Settings sections name themselves (SettingsPage).
 */
export const pageTitles = {
  '/': 'Home',
  '/albums': 'Albums',
  '/artists': 'Artists',
  '/collection': 'Physical collection',
  '/playlists': 'Playlists',
  '/work': 'Library care',
  '/plans': 'Tag changes',
  '/settings': 'Settings',
} as const;

export type MainPage = keyof typeof pageTitles;

/** Older paths that open inside a main page (Library care's tabs, Settings' activity). */
const aliases: Record<string, MainPage> = {
  '/queue': '/work',
  '/identify': '/work',
  '/attention': '/work',
  '/jobs': '/settings',
};

/** The main page a path belongs to, or null (sign in, setup, onboarding). */
export function mainPageOf(pathname: string): MainPage | null {
  const path = pathname.replace(/\/+$/, '') || '/';
  if (path === '/') return '/';
  const first = `/${path.split('/')[1]}`;
  if (first in pageTitles) return first as MainPage;
  return aliases[first] ?? null;
}

/** The title the phone's top bar shows for a path, or null when it has none. */
export function pageTitle(pathname: string): string | null {
  const page = mainPageOf(pathname);
  return page ? pageTitles[page] : null;
}
