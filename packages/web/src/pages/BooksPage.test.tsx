/**
 * The books app (the spike): the Books grid and the Settings › Modules row
 * render values only; a work without a cover gets the placeholder.
 */
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { BookWorkView } from '@tagave/shared';
import { BooksGrid } from './BooksPage';
import { BooksModuleRow } from './SettingsModulesPage';

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

  it('the Settings › Modules row: its state and counts, one button', () => {
    const html = renderToStaticMarkup(
      <BooksModuleRow view={{ enabled: true, libraryId: 'l', folders: 1, works: 4, files: 1 }} onTurnOn={() => undefined} onTurnOff={() => undefined} />,
    );
    expect(html).toContain('Books');
    expect(html).toContain('On');
    expect(html).toContain('1 folder · 4 works · 1 file');
    expect(html).toContain('Turn off');
    expect(html).not.toContain('Turn on');
  });
});
