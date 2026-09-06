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
  QueuePage,
  AlbumDetailPage,
  AttentionPage,
  CollectionPage,
  SettingsScanRootsPage,
  SettingsProvidersPage,
  JobsPage,
} from './pages';
import { useMe } from './hooks';

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
});

const artistsRoute = new Route({
  getParentRoute: () => layoutRoute,
  path: '/artists',
  component: ArtistsPage,
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

const collectionRoute = new Route({
  getParentRoute: () => layoutRoute,
  path: '/collection',
  component: CollectionPage,
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
    queueRoute,
    attentionRoute,
    collectionRoute,
    albumDetailRoute,
    settingsScanRootsRoute,
    settingsProvidersRoute,
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
