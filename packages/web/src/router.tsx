import { RootRoute, Router, Route } from '@tanstack/react-router';
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
  QueuePage,
  AlbumDetailPage,
  AttentionPage,
  IdentifyPage,
  CollectionPage,
  PlansPage,
  SettingsScanRootsPage,
  SettingsProvidersPage,
  SettingsGenresPage,
  SettingsFollowRulesPage,
  SettingsTagWritesPage,
  SettingsUpdatesPage,
  JobsPage,
} from './pages';
import { useMe } from './hooks';
import { parseAlbumsSearch } from './pages/albumsSearch';

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

const queueRoute = new Route({
  getParentRoute: () => layoutRoute,
  path: '/queue',
  component: QueuePage,
});

const attentionRoute = new Route({
  getParentRoute: () => layoutRoute,
  path: '/attention',
  component: AttentionPage,
});

const identifyRoute = new Route({
  getParentRoute: () => layoutRoute,
  path: '/identify',
  component: IdentifyPage,
});

const collectionRoute = new Route({
  getParentRoute: () => layoutRoute,
  path: '/collection',
  component: CollectionPage,
});

const plansRoute = new Route({
  getParentRoute: () => layoutRoute,
  path: '/plans',
  component: PlansPage,
});

const albumDetailRoute = new Route({
  getParentRoute: () => layoutRoute,
  path: '/albums/$albumId',
  component: AlbumDetailPage,
});

const settingsScanRootsRoute = new Route({
  getParentRoute: () => layoutRoute,
  path: '/settings/scan-roots',
  component: SettingsScanRootsPage,
});

const settingsProvidersRoute = new Route({
  getParentRoute: () => layoutRoute,
  path: '/settings/providers',
  component: SettingsProvidersPage,
});

const settingsGenresRoute = new Route({
  getParentRoute: () => layoutRoute,
  path: '/settings/genres',
  component: SettingsGenresPage,
});

const settingsFollowRulesRoute = new Route({
  getParentRoute: () => layoutRoute,
  path: '/settings/follow-rules',
  component: SettingsFollowRulesPage,
});

const settingsTagWritesRoute = new Route({
  getParentRoute: () => layoutRoute,
  path: '/settings/tag-writes',
  component: SettingsTagWritesPage,
});

const settingsUpdatesRoute = new Route({
  getParentRoute: () => layoutRoute,
  path: '/settings/updates',
  component: SettingsUpdatesPage,
});

const jobsRoute = new Route({
  getParentRoute: () => layoutRoute,
  path: '/jobs',
  component: JobsPage,
});

const logoutRoute = new Route({
  getParentRoute: () => layoutRoute,
  path: '/logout',
  beforeLoad: async () => {
    // Trigger logout mutation
    const { useLogout } = await import('./hooks');
    const logout = useLogout();
    logout.mutate();
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
    queueRoute,
    attentionRoute,
    identifyRoute,
    collectionRoute,
    plansRoute,
    albumDetailRoute,
    settingsScanRootsRoute,
    settingsProvidersRoute,
    settingsGenresRoute,
    settingsFollowRulesRoute,
    settingsTagWritesRoute,
    settingsUpdatesRoute,
    jobsRoute,
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
