/**
 * The section list Your settings and Settings both render: one link per
 * section, the current one marked, search above the links, a value line
 * when nothing is listed.
 */
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { describe, expect, it } from 'vitest';
import { SectionNav } from './SectionNav';

async function withRouter(children: ReactNode): Promise<string> {
  const root = createRootRoute({ component: () => <>{children}</> });
  const router = createRouter({ routeTree: root, history: createMemoryHistory({ initialEntries: ['/'] }) });
  await router.load();
  return renderToStaticMarkup(<RouterProvider router={router} />);
}

const items = [
  { value: 'account', label: 'Account', to: '/you/account' },
  { value: 'appearance', label: 'Appearance', to: '/you/appearance' },
  { value: 'listening', label: 'Listening', to: '/you/listening' },
];

describe('SectionNav', () => {
  it('marks the current section', async () => {
    const html = await withRouter(<SectionNav label="Your settings sections" items={items} current="appearance" />);
    expect(html).toContain('aria-label="Your settings sections"');
    const marked = [...html.matchAll(/<a [^>]*aria-current="page"[^>]*>([^<]*)</g)].map((m) => m[1]);
    expect(marked).toEqual(['Appearance']);
  });

  it('links each section', async () => {
    const html = await withRouter(<SectionNav label="Your settings sections" items={items} current={null} />);
    expect(html).toContain('href="/you/account"');
    expect(html).toContain('href="/you/listening"');
    expect(html).not.toContain('aria-current');
  });

  it('search sits above the links', async () => {
    const html = await withRouter(<SectionNav label="Settings sections" items={items} current="account" search={<span data-marker="search-slot" />} />);
    const at = html.indexOf('search-slot');
    expect(at).toBeGreaterThan(-1);
    expect(at).toBeLessThan(html.indexOf('<a'));
  });

  it('empty list shows the empty value', async () => {
    const html = await withRouter(<SectionNav label="Settings sections" items={[]} current={null} empty="No match" />);
    expect(html).toContain('No match');
    expect(html).not.toContain('<a');
  });
});
