import { RootRoute, Router, Route } from '@tanstack/react-router';
import { App } from './components/App';
import { Layout } from './components/Layout';
import {
  SetupPage,
  LoginPage,
  DashboardPage,
  AlbumsPage,
  ArtistsPage,
  QueuePage,
  SettingsScanRootsPage,
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

const albumDetailRoute = new Route({
  getParentRoute: () => layoutRoute,
  path: '/albums/$albumId',
  component: () => <div>Album Detail - M1+</div>, // Placeholder for M1
});

const settingsScanRootsRoute = new Route({
  getParentRoute: () => layoutRoute,
  path: '/settings/scan-roots',
  component: SettingsScanRootsPage,
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
    albumsRoute,
    artistsRoute,
    queueRoute,
    albumDetailRoute,
    settingsScanRootsRoute,
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
