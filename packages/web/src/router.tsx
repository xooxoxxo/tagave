import { RootRoute, Router, Route, redirect, lazyRouteComponent } from '@tanstack/react-router';
import { App } from './components/App';
import { Layout } from './components/Layout';
import { DashboardPage } from './pages/DashboardPage';

// Every page but Home is its own chunk, fetched on first visit (and on hover
// or focus of a link to it: defaultPreload 'intent'). Before, all 27 routes
// shipped in one 1 MB bundle to every page (audit 2026-10-10).
const SetupPage = lazyRouteComponent(() => import('./pages/SetupPage'), 'SetupPage');
const LoginPage = lazyRouteComponent(() => import('./pages/LoginPage'), 'LoginPage');
const TwoFactorPage = lazyRouteComponent(() => import('./pages/TwoFactorPage'), 'TwoFactorPage');
const OnboardingPage = lazyRouteComponent(() => import('./pages/OnboardingPage'), 'OnboardingPage');
const ProtectAccountPage = lazyRouteComponent(() => import('./pages/ProtectAccountPage'), 'ProtectAccountPage');
const AlbumsPage = lazyRouteComponent(() => import('./pages/AlbumsPage'), 'AlbumsPage');
const ArtistsPage = lazyRouteComponent(() => import('./pages/ArtistsPage'), 'ArtistsPage');
const ArtistPage = lazyRouteComponent(() => import('./pages/ArtistPage'), 'ArtistPage');
const AlbumDetailPage = lazyRouteComponent(() => import('./pages/AlbumDetailPage'), 'AlbumDetailPage');
const PlansPage = lazyRouteComponent(() => import('./pages/PlansPage'), 'PlansPage');
const PlanPage = lazyRouteComponent(() => import('./pages/PlanPage'), 'PlanPage');
const WorkPage = lazyRouteComponent(() => import('./pages/WorkPage'), 'WorkPage');
const SettingsPage = lazyRouteComponent(() => import('./pages/SettingsPage'), 'SettingsPage');
const InvitePage = lazyRouteComponent(() => import('./pages/InvitePage'), 'InvitePage');
const CollectionPage = lazyRouteComponent(() => import('./pages/CollectionPage'), 'CollectionPage');
const ConnectConsentPage = lazyRouteComponent(() => import('./pages/ConnectConsentPage'), 'ConnectConsentPage');
import { signOut } from './hooks/useAuth';
import { guarded } from './components/access/RequirePermission';
import { parseAlbumsSearch } from './pages/albumsSearch';
import { albumSearchRedirect, parseAlbumSearch } from './utils/albumAttention';

/**
 * Parse work page search params: validate optional tab
 */
function parseWorkSearch(search: Record<string, unknown>) {
  const tab = search.tab as string | undefined;
  if (tab && !['review', 'identify', 'attention', 'tasks'].includes(tab)) {
    throw new Error(`Invalid work tab: ${tab}`);
  }
  return { tab: (tab as 'review' | 'identify' | 'attention' | 'tasks' | undefined) ?? 'review' };
}

// Root route - handles auth redirection
const rootRoute = new RootRoute({
  component: App,
});

// Setup (first-run onboarding)
const setupRoute = new Route({
  getParentRoute: () => rootRoute,
  path: '/setup',
  component: SetupPage,
});

// Login
const loginRoute = new Route({
  getParentRoute: () => rootRoute,
  path: '/login',
  component: LoginPage,
});

// Second sign-in step: authenticator or backup code
const loginTwoFactorRoute = new Route({
  getParentRoute: () => rootRoute,
  path: '/login/2fa',
  component: TwoFactorPage,
});

// An invite or set-password link (Settings › Users): opened signed out
const inviteRoute = new Route({
  getParentRoute: () => rootRoute,
  path: '/invite/$token',
  component: InvitePage,
});

// Music Connections consent: another app asks to read this person's data.
// Outside the app frame, like sign-in; needs a session (App sends to /login
// and back).
const connectConsentRoute = new Route({
  getParentRoute: () => rootRoute,
  path: '/connect/consent',
  component: ConnectConsentPage,
  validateSearch: (search: Record<string, unknown>): { request?: string } =>
    typeof search['request'] === 'string' && search['request'] ? { request: search['request'] } : {},
});

// Protected routes (require auth)
const layoutRoute = new Route({
  getParentRoute: () => rootRoute,
  id: 'layout',
  component: Layout,
});

const dashboardRoute = new Route({
  getParentRoute: () => layoutRoute,
  path: '/',
  component: DashboardPage,
});

const onboardingRoute = new Route({
  getParentRoute: () => layoutRoute,
  path: '/onboarding',
  component: guarded('system.manage', OnboardingPage),
});

// Setup wizard, last step: passkey / authenticator (skippable)
const protectAccountRoute = new Route({
  getParentRoute: () => layoutRoute,
  path: '/onboarding/protect',
  component: ProtectAccountPage,
  // ?from=invite: the last step after accepting an invite (no setup steps shown)
  validateSearch: (search: Record<string, unknown>): { from?: 'invite' } => (search['from'] === 'invite' ? { from: 'invite' } : {}),
});

const albumsRoute = new Route({
  getParentRoute: () => layoutRoute,
  path: '/albums',
  component: AlbumsPage,
  // Filters/sort/view/page live in the URL (spec BRW-1: bookmarkable views).
  validateSearch: (search: Record<string, unknown>) => parseAlbumsSearch(search),
});

const artistsRoute = new Route({
  getParentRoute: () => layoutRoute,
  path: '/artists',
  component: ArtistsPage,
});

const artistDetailRoute = new Route({
  getParentRoute: () => layoutRoute,
  path: '/artists/$artistId',
  component: ArtistPage,
});


const plansRoute = new Route({
  getParentRoute: () => layoutRoute,
  path: '/plans',
  component: guarded('library.edit', PlansPage),
  // ?album=<localAlbumId> opens the wizard scoped to that album (album page "Fix tags").
  validateSearch: (search: Record<string, unknown>): { album?: string } =>
    typeof search['album'] === 'string' && search['album'] ? { album: search['album'] } : {},
});

const planRoute = new Route({
  getParentRoute: () => layoutRoute,
  path: '/plans/$planId',
  component: guarded('library.edit', PlanPage),
});

const albumDetailRoute = new Route({
  getParentRoute: () => layoutRoute,
  path: '/albums/$albumId',
  component: AlbumDetailPage,
  // ?tab=tracks|editions|about|activity; old ids (?tab=care, album, reviews)
  // redirect to their new home, and ?issues opens the attention strip.
  validateSearch: (search: Record<string, unknown>) => parseAlbumSearch(search),
  beforeLoad: ({ location, params }) => {
    const next = albumSearchRedirect(location.search as Record<string, unknown>);
    if (next) throw redirect({ to: '/albums/$albumId', params, search: next, replace: true });
  },
});

const settingsProvidersRoute = new Route({
  getParentRoute: () => layoutRoute,
  path: '/settings/providers',
  component: SettingsPage,
});

// New unified routes
const workRoute = new Route({
  getParentRoute: () => layoutRoute,
  path: '/work',
  component: guarded('library.edit', WorkPage),
  validateSearch: (search: Record<string, unknown>) => parseWorkSearch(search),
});

const settingsRoute = new Route({
  getParentRoute: () => layoutRoute,
  path: '/settings',
  component: SettingsPage,
});

const settingsSectionRoute = new Route({
  getParentRoute: () => layoutRoute,
  path: '/settings/$section',
  component: SettingsPage,
  // ?job=<job_runs id> points Background activity at one job (a plan's
  // preview and the activity list itself link here): JobsPage reads it with
  // useSearch, asks the API to include it and scrolls to it, highlighted.
  validateSearch: (search: Record<string, unknown>): { job?: string } =>
    typeof search['job'] === 'string' && search['job'] ? { job: search['job'] } : {},
});

const settingsLibraryRoute = new Route({
  getParentRoute: () => layoutRoute,
  path: '/settings/library',
  component: SettingsPage,
});

const settingsSystemRoute = new Route({
  getParentRoute: () => layoutRoute,
  path: '/settings/system',
  component: SettingsPage,
});

// Redirects for old routes
const queueRedirect = new Route({
  getParentRoute: () => layoutRoute,
  path: '/queue',
  beforeLoad: () => redirect({ to: '/work', search: { tab: 'review' } }),
});

const identifyRedirect = new Route({
  getParentRoute: () => layoutRoute,
  path: '/identify',
  beforeLoad: () => redirect({ to: '/work', search: { tab: 'identify' } }),
});

const attentionRedirect = new Route({
  getParentRoute: () => layoutRoute,
  path: '/attention',
  beforeLoad: () => redirect({ to: '/work', search: { tab: 'attention' } }),
});

// Collection is the physical archive: a main surface, not a setting.
const collectionRoute = new Route({
  getParentRoute: () => layoutRoute,
  path: '/collection',
  component: CollectionPage,
});

const jobsOldRoute = new Route({
  getParentRoute: () => layoutRoute,
  path: '/jobs',
  // keep ?job=<id> deep links working from the old address
  beforeLoad: ({ search }) => redirect({ to: '/settings/$section', params: { section: 'activity' }, search }),
});

const scanRootsRedirect = new Route({
  getParentRoute: () => layoutRoute,
  path: '/settings/scan-roots',
  beforeLoad: () => redirect({ to: '/settings/library' }),
});

const tagWritesRedirect = new Route({
  getParentRoute: () => layoutRoute,
  path: '/settings/tag-writes',
  beforeLoad: () => redirect({ to: '/settings/$section', params: { section: 'metadata' } }),
});

const genresRedirect = new Route({
  getParentRoute: () => layoutRoute,
  path: '/settings/genres',
  beforeLoad: () => redirect({ to: '/settings/$section', params: { section: 'genre-mapping' } }),
});

const followRulesRedirect = new Route({
  getParentRoute: () => layoutRoute,
  path: '/settings/follow-rules',
  beforeLoad: () => redirect({ to: '/settings/$section', params: { section: 'following' } }),
});

const settingsUpdatesRoute = new Route({
  getParentRoute: () => layoutRoute,
  path: '/settings/updates',
  component: SettingsPage,
});

const logoutRoute = new Route({
  getParentRoute: () => layoutRoute,
  path: '/logout',
  beforeLoad: async () => {
    await signOut();
    window.location.replace('/login');
  },
});

// Build route tree
const routeTree = rootRoute.addChildren([
  setupRoute,
  loginRoute,
  loginTwoFactorRoute,
  inviteRoute,
  connectConsentRoute,
  layoutRoute.addChildren([
    dashboardRoute,
    onboardingRoute,
    protectAccountRoute,
    albumsRoute,
    artistsRoute,
    artistDetailRoute,
    plansRoute,
    planRoute,
    albumDetailRoute,
    // New unified routes
    workRoute,
    settingsRoute,
    settingsSectionRoute,
    settingsLibraryRoute,
    settingsSystemRoute,
    settingsProvidersRoute,
    // Redirects for old routes
    queueRedirect,
    identifyRedirect,
    attentionRedirect,
    collectionRoute,
    jobsOldRoute,
    scanRootsRedirect,
    tagWritesRedirect,
    genresRedirect,
    followRulesRedirect,
    settingsUpdatesRoute,
    logoutRoute,
  ]),
]);

export const router = new Router({
  routeTree,
  defaultPreload: 'intent',
});

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
