import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { InlineRename } from '../components/InlineRename';

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
  it('review: the comparison is a fixed table; label and verdict columns are set, the values share the rest', () => {
    const css = read('./review/review.module.css');
    expect(rule(css, '.compare')).toMatch(/table-layout:\s*fixed/);
    expect(rule(css, '.cField')).toMatch(/width:\s*[\d.]+%/);
    expect(rule(css, '.cMark')).toMatch(/width:\s*[\d.]+rem/);
    const tsx = source('./QueuePage.tsx');
    expect(tsx).toMatch(/<colgroup>/);
  });

  it('review: an edition row keeps the mark and the meter still and lets the facts take the rest', () => {
    const css = read('./review/review.module.css');
    expect(rule(css, '.edition,\n.editionSelected')).toMatch(/grid-template-columns:\s*auto minmax\(0, 1fr\) auto/);
    expect(rule(css, '.meterBar')).toMatch(/width:\s*56px/);
    expect(rule(css, '.meterPct')).toMatch(/min-width:\s*3\.4ch/);
    expect(rule(css, '.meterWord')).toMatch(/min-width:\s*3\.4rem/);
  });

  it('review: the two panels stack on a phone, comparison first', () => {
    const css = read('./review/review.module.css');
    expect(css).toMatch(/@media \(max-width: 720px\)\s*\{\s*\.panels\s*\{\s*grid-template-columns:\s*minmax\(0, 1fr\)/);
    const tsx = source('./QueuePage.tsx');
    expect(tsx.indexOf('aria-label="Selected edition beside your files"')).toBeLessThan(tsx.indexOf('id="editions-heading"'));
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

  it('the account row: no rule above it, edge to edge across the sidebar, on the bottom edge', () => {
    const layout = read('../components/Layout.module.css');
    const account = rule(layout, '.account');
    expect(account).not.toMatch(/border/);
    // it spans exactly the sidebar's padding, nothing more
    expect(account).toMatch(/margin-inline: calc\(-1 \* var\(--nav-pad-x\)\)/);
    expect(account).toMatch(/margin-top: auto/);
    expect(source('../components/Layout.tsx')).toMatch(/<AccountCompartment/);
  });

  it('the player bar draws no rule on top (one strip with the account row)', () => {
    const bar = rule(read('../components/PlayerBar.module.css'), '.bar');
    // forced colours keep a system rule (no glass there); every theme draws none
    expect(bar).not.toMatch(/border-top:[^;]*var\(--line/);
  });
});
