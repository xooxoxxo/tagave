/**
 * The plan page's field filter: one collapsed line by default, and a line of
 * fixed height whether or not a field is picked (the owner saw the header
 * grow when "Show all fields" appeared beside the title).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { PlanFieldFilter, type FieldFilterEntry } from './PlanFieldFilter';

const entries: FieldFilterEntry[] = [
  { field: 'album', label: 'Album title', files: 116, reasonShort: 'overwrite', reasonTitle: '116 overwrite' },
  { field: 'genre', label: 'Genre', files: 89, reasonShort: 'overwrite/fill', reasonTitle: '77 overwrite · 12 fill' },
];
const render = (field = '', defaultOpen = false) =>
  renderToStaticMarkup(<PlanFieldFilter entries={entries} field={field} onPick={() => undefined} defaultOpen={defaultOpen} />);

describe('PlanFieldFilter', () => {
  it('starts collapsed to one line that names how many fields there are', () => {
    const html = render();
    expect(html).toMatch(/aria-expanded="false"/);
    expect(html).toContain('Filter by field');
    expect(html).toContain('· 2 fields');
    // the tiles are not mounted until the line is opened
    expect(html).not.toContain('Filter files by Album title');
  });

  it('opened, lists one tile per field with its file count', () => {
    const html = render('', true);
    expect(html).toMatch(/aria-expanded="true"/);
    expect(html).toContain('aria-label="Filter files by Album title"');
    expect(html).toContain('>116<');
  });

  it('a picked field shows inside the header line with a clear button, even collapsed', () => {
    const html = render('genre');
    const head = html.match(/<div[^>]*data-field-filter-head[^>]*>[\s\S]*?<\/div>/)?.[0] ?? '';
    expect(head).toContain('Genre');
    expect(head).toContain('aria-label="Clear the field filter (Genre); show all fields"');
    expect(html).not.toContain('Show all fields</button>');
  });

  it('the header line has a fixed height, so the picked field and its clear button cannot grow it', () => {
    const css = readFileSync(new URL('./PlanPage.module.css', import.meta.url), 'utf8');
    const head = css.match(/\.fieldHead\s*\{([^}]*)\}/)?.[1] ?? '';
    expect(head).toMatch(/(^|[\s;])height:\s*44px/);
    const picked = css.match(/\.fieldPicked\s*\{([^}]*)\}/)?.[1] ?? '';
    expect(picked).toMatch(/height:\s*var\(--h-chip\)/);
  });
});
