import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const stripComments = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, '');
const read = (rel: string) => stripComments(readFileSync(new URL(rel, import.meta.url), 'utf8'));
/** Every block whose selector is exactly this one, joined. */
const rule = (css: string, selector: string) =>
  [...css.matchAll(new RegExp(`(?:^|\\n)\\s*${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`, 'g'))]
    .map((m) => m[1] ?? '').join('\n');

describe('data tables keep their columns still', () => {
  it('review candidates: fixed layout, a width on every column but Release', () => {
    const css = read('./QueuePage.module.css');
    expect(rule(css, '.table')).toMatch(/table-layout:\s*fixed/);
    for (const col of ['.wSource', '.wYear', '.wCountry', '.wTracks', '.wScores', '.wStatus', '.wDistance', '.wLinks']) {
      expect(rule(css, col)).toMatch(/width:\s*[\d.]+rem/);
    }
    const tsx = readFileSync(new URL('./QueuePage.tsx', import.meta.url), 'utf8');
    expect(tsx).toMatch(/<colgroup>/);
    expect(tsx).not.toMatch(/Match cells, left to right: \{scoreKeys\.join/);
  });

  it('jobs and album candidates use fixed layout too', () => {
    expect(rule(read('./JobsPage.module.css'), '.table')).toMatch(/table-layout:\s*fixed/);
    expect(rule(read('./AlbumDetailPage.module.css'), '.candTable')).toMatch(/table-layout:\s*fixed/);
  });

  it('plan file rows fix every grid track except the path', () => {
    expect(rule(read('./PlanPage.module.css'), '.fileRow')).toMatch(/grid-template-columns:\s*1\.25rem 6\.5rem minmax\(0, 1fr\) 7rem/);
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
});
