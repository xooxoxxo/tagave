import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { InlineRename } from '../components/InlineRename';
import { MAX_SCORE_DOTS } from '../utils/matchScores';

const stripComments = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, '');
const read = (rel: string) => stripComments(readFileSync(new URL(rel, import.meta.url), 'utf8'));
const source = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');
/** Every block whose selector is exactly this one, joined. */
const rule = (css: string, selector: string) =>
  [...css.matchAll(new RegExp(`(?:^|\\n)\\s*${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`, 'g'))]
    .map((m) => m[1] ?? '').join('\n');
/** A length property of a block, in px (rem counted as 16px). */
const px = (block: string, prop: string) => {
  const m = block.match(new RegExp(`(?:^|[;\\s{])${prop}:\\s*([\\d.]+)(px|rem)`));
  if (!m) throw new Error(`no ${prop} in: ${block}`);
  return Number(m[1]) * (m[2] === 'rem' ? 16 : 1);
};

describe('data tables keep their columns still', () => {
  it('review candidates: fixed layout, a width on every column but Release', () => {
    const css = read('./QueuePage.module.css');
    expect(rule(css, '.table')).toMatch(/table-layout:\s*fixed/);
    for (const col of ['.wSource', '.wYear', '.wCountry', '.wTracks', '.wScores', '.wStatus', '.wDistance', '.wLinks']) {
      expect(rule(css, col)).toMatch(/width:\s*[\d.]+rem/);
    }
    const tsx = source('./QueuePage.tsx');
    expect(tsx).toMatch(/<colgroup>/);
    expect(tsx).not.toMatch(/Match cells, left to right: \{scoreKeys\.join/);
  });

  it('review candidates: the Match column holds the most dots any album carries', () => {
    const css = read('./QueuePage.module.css');
    const column = px(rule(css, '.wScores'), 'width');
    const dot = px(rule(css, '.cellNone'), 'width');
    const gap = px(rule(css, '.scoreStrip'), 'gap');
    // row cells: padding var(--space-sm) var(--space-md), and --space-md is 1rem
    expect(rule(css, '.rowSelected > td')).toMatch(/padding:\s*var\(--space-sm\) var\(--space-md\)/);
    const cellPadding = 2 * 16;
    expect(column - cellPadding).toBeGreaterThanOrEqual(MAX_SCORE_DOTS * dot + (MAX_SCORE_DOTS - 1) * gap);
    // past that the dots wrap to a second line instead of being clipped
    expect(rule(css, '.scoreStrip')).toMatch(/flex-wrap:\s*wrap/);
  });

  it('jobs and album candidates use fixed layout too', () => {
    expect(rule(read('./JobsPage.module.css'), '.table')).toMatch(/table-layout:\s*fixed/);
    expect(rule(read('./AlbumDetailPage.module.css'), '.candTable')).toMatch(/table-layout:\s*fixed/);
  });

  it('plan file rows fix every grid track except the path', () => {
    expect(rule(read('./PlanPage.module.css'), '.fileRow')).toMatch(/grid-template-columns:\s*1\.25rem 6\.5rem minmax\(0, 1fr\) 7rem/);
  });
});

describe('album page: missing tracks', () => {
  it('the number sits in a narrow tabular column right next to the title', () => {
    const css = read('./AlbumDetailPage.module.css');
    const no = rule(css, '.missingNo');
    expect(no).toMatch(/width:\s*1%/);
    expect(no).toMatch(/min-width:\s*2\.5ch/);
    expect(rule(css, '.missingTitle')).toMatch(/width:\s*auto/);
    expect(rule(css, '.num')).toMatch(/tabular-nums/);
    // number, then title, then length, in that order in the row
    const tsx = source('./AlbumDetailPage.tsx');
    const row = tsx.slice(tsx.indexOf('styles.missingNo'), tsx.indexOf('styles.missingLen'));
    expect(row).toContain('styles.missingTitle');
  });
});

describe('plan header', () => {
  it('the title block has a real basis, so the actions wrap below instead of overflowing', () => {
    const css = read('../components/ui/PageShell.module.css');
    expect(rule(css, '.titleBlock')).toMatch(/flex:\s*1 1 [\d.]+rem/);
    expect(rule(css, '.actions')).toMatch(/flex-wrap:\s*wrap/);
    expect(rule(css, '.actions')).toMatch(/max-width:\s*100%/);
  });

  it('the name clamps to two lines and keeps the status chip on its row', () => {
    const css = read('../components/InlineRename.module.css');
    expect(rule(css, '.wrap.title')).toMatch(/flex-wrap:\s*nowrap/);
    const text = rule(css, '.wrap.title .text');
    expect(text).toMatch(/-webkit-line-clamp:\s*2/);
    expect(text).toMatch(/overflow:\s*hidden/);
    expect(rule(css, '.tail')).toMatch(/white-space:\s*nowrap/);
    expect(rule(css, '.tail')).toMatch(/flex:\s*none/);

    const long = '02. Stephane Pompougnac - Hotel Costes Vol. 11 tags, a plan name long enough to need a third line';
    const html = renderToStaticMarkup(createElement(InlineRename, {
      value: long,
      label: 'Rename plan',
      onSave: async () => undefined,
      after: createElement('span', { 'data-chip': '' }, 'Draft'),
    }));
    // the whole name is in the markup (the clamp is CSS) and is the hover text
    expect(html).toContain(`title="${long}"`);
    expect(html).toContain(`>${long}</span>`);
    // the chip rides in the same no-wrap unit as the pencil
    expect(html).toMatch(/class="[^"]*tail[^"]*"><button[\s\S]*?<\/button><span data-chip="">Draft<\/span><\/span>/);
  });

  it('keeps the status chip next to the field while the name is being edited', () => {
    const tsx = source('../components/InlineRename.tsx');
    const editing = tsx.slice(tsx.lastIndexOf('return ('));
    expect(editing).toMatch(/styles\.editRow[\s\S]*<Input[\s\S]*\{after\}/);
  });
});

describe('page shells', () => {
  it('library care panels add no side padding of their own', () => {
    expect(rule(read('./IdentifyPage.module.css'), '.container')).not.toMatch(/padding|max-width/);
    expect(rule(read('./AttentionPage.module.css'), '.container')).not.toMatch(/padding/);
  });

  it('the segmented control hugs its options', () => {
    expect(rule(read('../components/ui/SegmentedControl.module.css'), '.track')).toMatch(/align-self:\s*flex-start/);
  });

  it('sign out never pokes out of the sidebar with a negative margin', () => {
    expect(rule(read('../components/Layout.module.css'), '.logoutBtn')).not.toMatch(/margin:[^;]*-/);
  });

  it('the email keeps a full-width line of its own, full address on hover', () => {
    expect(rule(read('../components/Layout.module.css'), '.navUser')).toMatch(/flex-direction:\s*column/);
    expect(source('../components/Layout.tsx')).toMatch(/className=\{styles\.userEmail\} title=\{user\.email\}/);
  });
});
