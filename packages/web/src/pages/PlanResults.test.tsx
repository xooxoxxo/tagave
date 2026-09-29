/**
 * The results section of an applied plan: album rows link to the album page
 * and to the artist (the artist page when the artist is linked, the albums
 * list filtered to the name otherwise), and it says when albums are still
 * being updated from the new tags.
 */
import { describe, it, expect, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { TagPlanResults } from '@liner/shared';

vi.mock('@tanstack/react-router', () => ({
  Link: ({ to, params, search, children, className }: { to: string; params?: Record<string, string>; search?: Record<string, string>; children: unknown; className?: string }) => {
    let href = to;
    for (const [k, v] of Object.entries(params ?? {})) href = href.replace(`$${k}`, v);
    if (search) href += `?${new URLSearchParams(search).toString()}`;
    return <a href={href} className={className}>{children as never}</a>;
  },
}));

import { PlanResults, PlanReverted } from './PlanResults';

const merged: TagPlanResults = {
  filesWritten: 10, filesFailed: 0, albumsBefore: 3, albumCount: 1, looseFiles: 0, updating: false,
  albums: [{
    id: 'a1', title: 'The Last Tycoon', artistCredit: 'Peter Moren', artistId: null, year: 2008,
    coverUrl: '/api/v1/images/album/a1', trackCount: 10, planFiles: 10,
  }],
};

describe('PlanResults', () => {
  it('names the merged album and links to it and to its artist', () => {
    const html = renderToStaticMarkup(<PlanResults results={merged} loading={false} />);
    expect(html).toContain('3 albums became 1: The Last Tycoon by Peter Moren');
    expect(html).toContain('10 files written');
    expect(html).toContain('href="/albums/a1"');
    expect(html).toContain('href="/albums?artist=Peter+Moren"');
    expect(html).toContain('src="/api/v1/images/album/a1"');
    expect(html).not.toContain('Updating albums');
  });

  it('links a canonical artist to the artist page, and says when albums are updating', () => {
    const html = renderToStaticMarkup(<PlanResults results={{ ...merged, updating: true, albums: [{ ...merged.albums[0]!, artistId: 'art1', planFiles: 4 }] }} loading={false} />);
    expect(html).toContain('href="/artists/art1"');
    expect(html).toContain('Updating albums from the new tags');
    expect(html).toContain('4 from this plan');
  });

  it('a reverted plan gets one plain line, no album cards and no "became"', () => {
    const html = renderToStaticMarkup(<PlanReverted filesWritten={10} />);
    expect(html).toContain('Reverted: the tags from before this plan are back on 10 files.');
    expect(html).not.toContain('became');
    expect(html).not.toContain('href=');
  });
});
