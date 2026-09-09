import { RootRoute, Router, Route, redirect } from '@tanstack/react-router';
import { App } from './components/App';
import { Layout } from './components/Layout';
import {
  SetupPage,
  LoginPage,
  DashboardPage,
  OnboardingPage,
  AlbumsPage,
  ArtistsPage,
  ArtistPage,
  AlbumDetailPage,
  PlansPage,
  PlanPage,
  WorkPage,
  SettingsPage,
  CollectionPage,
} from './pages';
import { api } from './services/api';
import { parseAlbumsSearch } from './pages/albumsSearch';

/**
 * Parse work page search params: validate optional tab
 */
function parseWorkSearch(search: Record<string, unknown>) {
  const tab = search.tab as string | undefined;
  if (tab && !['review', 'identify', 'attention'].includes(tab)) {
    throw new Error(`Invalid work tab: ${tab}`);
  }
  return { tab: (tab as 'review' | 'identify' | 'attention' | undefined) ?? 'review' };
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
  component: OnboardingPage,
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
  component: PlansPage,
  // ?album=<localAlbumId> opens the wizard scoped to that album (album page "Fix tags").
  validateSearch: (search: Record<string, unknown>): { album?: string } =>
    typeof search['album'] === 'string' && search['album'] ? { album: search['album'] } : {},
});

const planRoute = new Route({
  getParentRoute: () => layoutRoute,
  path: '/plans/$planId',
  component: PlanPage,
});

const albumDetailRoute = new Route({
  getParentRoute: () => layoutRoute,
  path: '/albums/$albumId',
  component: AlbumDetailPage,
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
  component: WorkPage,
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
  beforeLoad: () => redirect({ to: '/settings/$section', params: { section: 'activity' } }),
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

const updatesRedirect = new Route({
  getParentRoute: () => layoutRoute,
  path: '/settings/updates',
  beforeLoad: () => redirect({ to: '/settings/system' }),
});

const logoutRoute = new Route({
  getParentRoute: () => layoutRoute,
  path: '/logout',
  beforeLoad: async () => {
    // Trigger logout mutation
    await api.post('/auth/logout');
    window.location.replace('/login');
  },
});

// Build route tree
const routeTree = rootRoute.addChildren([
  setupRoute,
  loginRoute,
  layoutRoute.addChildren([
    dashboardRoute,
    onboardingRoute,
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
    updatesRedirect,
    logoutRoute,
  ]),
]);

export const router = new Router({
  routeTree,
});

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
