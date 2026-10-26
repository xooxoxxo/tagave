/**
 * QA 2026-10-26 Q-06 / Q-32: an unknown album, plan or artist id sat on
 * "Loading…" (the 404 was retried three times first) or a blank page, and
 * an unknown address showed a bare "Not Found" with no way back.
 */
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { isNotFound, NotFoundPage, shouldRetryQuery } from './NotFound';

describe('shouldRetryQuery', () => {
  it('never retries an answer the server meant (4xx)', () => {
    expect(shouldRetryQuery(0, { status: 404 })).toBe(false);
    expect(shouldRetryQuery(0, { status: 403 })).toBe(false);
    expect(shouldRetryQuery(0, { status: 400 })).toBe(false);
  });

  it('retries a server or network failure up to three times', () => {
    expect(shouldRetryQuery(0, { status: 503 })).toBe(true);
    expect(shouldRetryQuery(2, new TypeError('Failed to fetch'))).toBe(true);
    expect(shouldRetryQuery(3, { status: 500 })).toBe(false);
  });

  it('retries a timeout or rate limit', () => {
    expect(shouldRetryQuery(0, { status: 408 })).toBe(true);
    expect(shouldRetryQuery(0, { status: 429 })).toBe(true);
  });
});

describe('isNotFound', () => {
  it('is a 404 from the API', () => {
    expect(isNotFound({ status: 404 })).toBe(true);
    expect(isNotFound({ status: 500 })).toBe(false);
    expect(isNotFound(null)).toBe(false);
  });
});

/** The page needs a router for its link. */
async function render(node: React.ReactNode): Promise<string> {
  const root = createRootRoute({ component: () => <>{node}</> });
  const router = createRouter({
    routeTree: root.addChildren([createRoute({ getParentRoute: () => root, path: '/' })]),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  });
  await router.load();
  return renderToStaticMarkup(<RouterProvider router={router} />);
}

describe('NotFoundPage', () => {
  it('says not found and links back home by default', async () => {
    const html = await render(<NotFoundPage />);
    expect(html).toContain('Not found');
    expect(html).toMatch(/<a[^>]*href="\/"[^>]*>Back to Home<\/a>/);
  });

  it('names what was not found and links back to its list', async () => {
    const html = await render(<NotFoundPage title="Album not found" to="/albums" label="Back to albums" />);
    expect(html).toContain('Album not found');
    expect(html).toMatch(/<a[^>]*href="\/albums"[^>]*>Back to albums<\/a>/);
  });
});

describe('router', () => {
  it('sends an unknown address to the in-app not-found page', async () => {
    const { router } = await import('../router');
    const matches = router.matchRoutes('/nope/route', {});
    expect(matches.at(-1)?.routeId).toBe('/layout/$');
    expect(router.matchRoutes('/albums', {}).at(-1)?.routeId).toBe('/layout/albums');
  });
});
