/**
 * Library care › Genre mapping on the settings layout (spec §6): the map is
 * one typed group with one Save (and Reset, beside its long text); the
 * preview's tables are groups too, an empty cell a word.
 */
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { GenreMappingView, type GenreMappingViewProps } from './SettingsGenresPage';

const PREVIEW: GenreMappingViewProps['preview'] = {
  map: { whitelist: ['Rock'], aliases: {}, maxGenres: 3 },
  tags: [
    { tag: 'rock', kind: 'genre', source: 'file', weight: null, count: 4, mappedTo: 'Rock' },
    { tag: 'shoegaze', kind: 'style', source: 'discogs', weight: null, count: 0, mappedTo: null },
  ],
  histogram: [{ genre: 'Rock', albums: 4 }],
};
const render = (over: Partial<GenreMappingViewProps> = {}) => renderToStaticMarkup(
  <GenreMappingView
    whitelistText="Rock"
    aliasesText=""
    maxGenres={3}
    ignored={0}
    dirty={false}
    preview={PREVIEW}
    onWhitelist={vi.fn()}
    onAliases={vi.fn()}
    onMaxGenres={vi.fn()}
    onSave={vi.fn()}
    onReset={vi.fn()}
    {...over}
  />,
);

describe('Library care › Genre mapping', () => {
  it('three groups, one Save with Reset', () => {
    const html = render();
    const at = (t: string) => html.indexOf(`<section aria-label="${t}"`);
    expect(at('Genre mapping')).toBeGreaterThan(-1);
    expect(at('Genre mapping')).toBeLessThan(at('Effective genres'));
    expect(at('Effective genres')).toBeLessThan(at('Raw tags'));
    expect(html.match(/>Save</g)).toHaveLength(1);
    expect(html.match(/>Reset</g)).toHaveLength(1);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>(<span[^>]*>)?Save</);
    expect(render({ dirty: true })).not.toMatch(/<button[^>]*disabled=""[^>]*>(<span[^>]*>)?Save</);
    expect(html).not.toMatch(/<h2/);
    expect(html).not.toContain('Saving...');
  });

  it('lines it cannot read are a value', () => {
    expect(render({ ignored: 2 })).toContain('2 lines ignored');
    expect(render()).not.toContain('lines ignored');
  });

  it('an empty cell is a word', () => {
    const html = render();
    expect(html).not.toContain('—');
    expect(html).toContain('Not mapped');
    expect(html).toContain('>0</td>');
  });
});
