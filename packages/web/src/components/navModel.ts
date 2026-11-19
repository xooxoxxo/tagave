/**
 * What the sidebar and the person menu list for a role. Pure: the sidebar
 * and IdentityRow only render what these return.
 *
 * - Browse, for everyone: the places to browse, the optional ones while
 *   their module is on.
 * - Care, for those who look after the library (`library.edit`): Library
 *   care (with its open tasks) and Tag changes. A listener gets none.
 * - The person menu: Your settings, Settings (only with Care), Sign out.
 */
import { pageTitles } from '../utils/pageTitles';

export type NavItem = {
  key: string;
  label: string;
  to: string;
  search?: Record<string, string>;
  current: boolean;
  count?: number;
  countLabel?: string;
};

export type NavModules = { playlists: boolean; likes: boolean; books: boolean };

/** Paths that open inside Library care (its tabs and the older pages). */
const carePaths = ['/work', '/queue', '/identify', '/attention'];

const under = (pathname: string, path: string) => pathname === path || pathname.startsWith(`${path}/`);

export function sidebarNav(o: { pathname: string; canCare: boolean; taskCount: number; modules: NavModules }): { browse: NavItem[]; care: NavItem[] } {
  const { pathname } = o;
  const page = (key: string, to: keyof typeof pageTitles): NavItem => ({
    key,
    label: pageTitles[to],
    to,
    current: to === '/' ? pathname === '/' : under(pathname, to),
  });
  const browse: NavItem[] = [
    page('home', '/'),
    page('albums', '/albums'),
    page('artists', '/artists'),
    page('collection', '/collection'),
    ...(o.modules.playlists ? [page('playlists', '/playlists')] : []),
    ...(o.modules.likes ? [page('liked', '/liked')] : []),
    ...(o.modules.books ? [page('books', '/books')] : []),
  ];
  const care: NavItem[] = o.canCare
    ? [
        {
          key: 'work',
          label: pageTitles['/work'],
          to: '/work',
          search: { tab: 'review' },
          current: carePaths.some((p) => under(pathname, p)),
          count: o.taskCount,
          countLabel: `open ${o.taskCount === 1 ? 'task' : 'tasks'}`,
        },
        page('plans', '/plans'),
      ]
    : [];
  return { browse, care };
}

export type IdentityItem = { key: 'you' | 'settings' | 'signout'; label: string; to?: string };

/** The person menu. PR 2 points `you` at `/you` and shows `settings` to anyone with a server section. */
export function identityMenu(o: { canCare: boolean }): IdentityItem[] {
  return [
    { key: 'you', label: 'Your settings', to: '/settings/account' },
    ...(o.canCare ? [{ key: 'settings' as const, label: pageTitles['/settings'], to: '/settings' }] : []),
    { key: 'signout', label: 'Sign out' },
  ];
}

/** The monogram's dot, as words for its accessible name: the owner's update, else none. */
export function identityDot(o: { owner: boolean; updateAvailable: boolean }): string | null {
  return o.owner && o.updateAvailable ? 'a new version is available' : null;
}
