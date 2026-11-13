/**
 * The books app (in development): the Books grid renders values only, a work
 * without a cover gets the placeholder; Settings › Modules lists Books only
 * for the owner of a server whose TAGAVE_DEV_APPS names it.
 */
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { BookWorkView } from '@tagave/shared';
import { BooksGrid } from './BooksPage';
import { moduleRows } from './SettingsModulesPage';

const WORKS: BookWorkView[] = [
  { id: 'w1', title: 'A Test of Lanterns', authors: ['Ada Example', 'Eve Second'], series: 'Lantern Tales', seriesIndex: 1, formats: ['epub', 'pdf'], coverEditionId: 'e1' },
  { id: 'w2', title: 'untitled', authors: [], series: null, seriesIndex: null, formats: ['pdf'], coverEditionId: null },
];

describe('Books', () => {
  it('a tile per work: its cover, title and authors', () => {
    const html = renderToStaticMarkup(<BooksGrid works={WORKS} />);
    expect(html.match(/<li/g)).toHaveLength(2);
    expect(html).toContain('/api/v1/books/editions/e1/cover');
    expect(html).toContain('A Test of Lanterns');
    expect(html).toContain('Ada Example, Eve Second');
    expect(html).toContain('untitled');
    // no cover: no image request
    expect(html.match(/\/books\/editions\//g)).toHaveLength(1);
  });

  it('Settings › Modules: a Books row only with the flag, for the owner, last', () => {
    const enabled = { mc: true, 'listen-links': true, playlists: true };
    const slugs = (owner: boolean, devApps?: Record<string, boolean> | null) => moduleRows({ owner, enabled, ...(devApps !== undefined ? { devApps } : {}) })!.map((r) => r.slug);
    // no flag: exactly the rows as before
    expect(slugs(true)).not.toContain('books');
    expect(slugs(true, {})).toEqual(slugs(true));
    expect(slugs(true, null)).toEqual(slugs(true));
    // the flag: the owner's last row, with its state
    expect(slugs(true, { books: false }).at(-1)).toBe('books');
    expect(moduleRows({ owner: true, enabled, devApps: { books: true } })!.at(-1)).toEqual({ slug: 'books', name: 'Books', state: 'On', on: true });
    // anyone else: never
    expect(slugs(false, { books: true })).not.toContain('books');
  });
});
