/**
 * An old Library care link (/jobs, Background activity, Genre mapping) goes
 * to /work for everyone, before the role is known. /work then sends a role
 * that may not open Library care to Your settings, in place of the address:
 * a listener never lands on Not available (spec §8, the anti-goals).
 */
import { readFileSync } from 'node:fs';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Role } from '@tagave/shared';

vi.mock('@tanstack/react-router', async (original) => ({
  ...(await original<typeof import('@tanstack/react-router')>()),
  // SSR runs no effects: show where Navigate would go instead
  Navigate: ({ to, replace }: { to: string; replace?: boolean }) => <i data-navigate={to} data-replace={String(!!replace)} />,
}));

vi.mock('../components/access/NotAvailable', () => ({
  // the real page links home, which needs a router
  NotAvailable: () => <p>Not available</p>,
}));

const { RequirePermission } = await import('../components/access/RequirePermission');
const { setCurrentRole } = await import('../hooks/usePermissions');
const { redirectFor, WORK_OTHERWISE } = await import('./redirects');

/** /work as router.tsx renders it, for a role. */
function work(role: Role, children: ReactNode = <p>Library care</p>): string {
  setCurrentRole(role);
  return renderToStaticMarkup(<RequirePermission permission="library.edit" otherwise={WORK_OTHERWISE}>{children}</RequirePermission>);
}

afterEach(() => setCurrentRole(null));

describe('an old Library care link, for someone who may not open it', () => {
  for (const [path, search] of [['/jobs', { job: 'j1' }], ['/settings/genre-mapping', {}], ['/settings/genres', {}], ['/settings/activity', {}]] as const) {
    it(`a listener on ${path} ends at Your settings, never Not available`, () => {
      expect(redirectFor(path, search)?.to).toBe('/work');
      const html = work('listener');
      expect(html).toContain('data-navigate="/you"');
      expect(html).toContain('data-replace="true"');
      expect(html).not.toContain('Not available');
      expect(html).not.toContain('Library care');
    });
  }

  it('an editor on /jobs?job=j1 gets Background activity with its job', () => {
    expect(redirectFor('/jobs', { job: 'j1' })).toEqual({ to: '/work', search: { tab: 'activity', job: 'j1' } });
    const html = work('editor');
    expect(html).toContain('Library care');
    expect(html).not.toContain('data-navigate');
  });

  it('without otherwise, a guarded page still shows Not available', () => {
    setCurrentRole('listener');
    const html = renderToStaticMarkup(<RequirePermission permission="library.edit"><p>Plans</p></RequirePermission>);
    expect(html).toContain('Not available');
  });

  it('the router guards /work with the fallback', () => {
    const router = readFileSync(new URL('../router.tsx', import.meta.url), 'utf8');
    expect(router).toContain("guarded('library.edit', WorkPage, WORK_OTHERWISE)");
  });
});
