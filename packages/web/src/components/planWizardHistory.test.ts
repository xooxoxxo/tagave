/**
 * Back after the Fix tags wizard. The album page opens the wizard by pushing
 * /plans?album=<id>; that entry only shows the wizard. Once the plan exists,
 * Back from the plan page must go to the album page, not reopen the wizard.
 * Driven through a real router on memory history, with the same route shapes
 * as the app (/plans validates ?album like router.tsx does).
 */
import { describe, it, expect } from 'vitest';
import { createMemoryHistory, createRootRoute, createRoute, createRouter } from '@tanstack/react-router';
import { planDoneNavigation, wizardCloseNavigation } from './planWizardHistory';

const ALBUM = 'a1';
const PLAN = 'p1';

function makeRouter() {
  const root = createRootRoute();
  const album = createRoute({ getParentRoute: () => root, path: '/albums/$albumId' });
  const plans = createRoute({
    getParentRoute: () => root,
    path: '/plans',
    validateSearch: (search: Record<string, unknown>): { album?: string } =>
      typeof search['album'] === 'string' && search['album'] ? { album: search['album'] } : {},
  });
  const plan = createRoute({ getParentRoute: () => root, path: '/plans/$planId' });
  const history = createMemoryHistory({ initialEntries: [`/albums/${ALBUM}`] });
  // Vitest runs in node, where there is no document: since router-core 1.171.35
  // the router then counts as server-side and navigate() does nothing. Say it
  // is a client, and give it the origin it would otherwise read from window.
  const router = createRouter({
    routeTree: root.addChildren([album, plans, plan]),
    history,
    isServer: false,
    origin: 'http://localhost',
  });
  return { router, history };
}

/** the URL the browser shows, as the wizard's open check sees it */
const here = (history: ReturnType<typeof createMemoryHistory>) => `${history.location.pathname}${history.location.search}`;
/** PlansPage opens the wizard whenever ?album= is in the URL */
const wizardWouldOpen = (history: ReturnType<typeof createMemoryHistory>) => new URLSearchParams(history.location.search).has('album');

async function back(router: ReturnType<typeof makeRouter>['router'], history: ReturnType<typeof createMemoryHistory>) {
  history.back();
  await router.load();
}

async function openFixTags(router: ReturnType<typeof makeRouter>['router']) {
  await router.load();
  // AlbumDetailPage: navigate({ to: '/plans', search: { album } }), a push
  await router.navigate({ to: '/plans', search: { album: ALBUM } });
}

describe('Fix tags wizard and browser history', () => {
  it('Back from the plan page goes to the album page, not the finished wizard', async () => {
    const { router, history } = makeRouter();
    await openFixTags(router);
    expect(wizardWouldOpen(history)).toBe(true);

    await router.navigate(planDoneNavigation(PLAN, true));
    expect(here(history)).toBe(`/plans/${PLAN}`);

    await back(router, history);
    expect(here(history)).toBe(`/albums/${ALBUM}`);
    expect(wizardWouldOpen(history)).toBe(false);

    // and Forward returns to the plan, still without the wizard in between
    history.forward();
    await router.load();
    expect(here(history)).toBe(`/plans/${PLAN}`);
  });

  it('pushing the plan page on top of the wizard entry (the old behaviour) reopens the wizard on Back', async () => {
    const { router, history } = makeRouter();
    await openFixTags(router);
    await router.navigate(planDoneNavigation(PLAN, false));
    await back(router, history);
    expect(wizardWouldOpen(history)).toBe(true);
  });

  it('dismissing the wizard drops ?album= in place, so Back goes to the album page', async () => {
    const { router, history } = makeRouter();
    await openFixTags(router);
    const nav = wizardCloseNavigation(ALBUM);
    expect(nav).not.toBeNull();
    await router.navigate(nav!);
    expect(here(history)).toBe('/plans');
    await back(router, history);
    expect(here(history)).toBe(`/albums/${ALBUM}`);
  });

  it('a wizard opened by a button (no ?album=) closes without touching history', () => {
    expect(wizardCloseNavigation(undefined)).toBeNull();
  });

  it('from the plans list button the plan page is pushed, so Back returns to the list', async () => {
    const { router, history } = makeRouter();
    await router.load();
    await router.navigate({ to: '/plans' });
    await router.navigate(planDoneNavigation(PLAN, false));
    await back(router, history);
    expect(here(history)).toBe('/plans');
  });
});
