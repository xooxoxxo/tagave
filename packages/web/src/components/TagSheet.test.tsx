/**
 * The Tag sheet (vault "tagave - Tag Flow"): it opens on the defaults with
 * every other choice a collapsed row carrying its value, one primary button
 * (Preview for a matched album), "No release matched" with Pick a release
 * otherwise, and the split line for an album that is one file. Plus the
 * words and the payload (tagSheetModel) and the old wizard's small labels.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactNode } from 'react';
import type { TagPlan } from '@tagave/shared';

const state = vi.hoisted(() => ({
  album: undefined as unknown,
  split: undefined as unknown,
  openPlans: [] as unknown[],
  owner: true,
  settings: { tagWritesEnabled: true, tagPolicy: { preset: 'fill_blanks_only', id3Version: '2.3', multiValueSeparator: '; ' } } as unknown,
  analyze: vi.fn(),
}));

vi.mock('./ui/Sheet', () => ({ Sheet: ({ children, title }: { children: ReactNode; title: string }) => <div role="dialog" aria-label={title}>{children}</div> }));
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => () => undefined, Link: ({ children }: { children: ReactNode }) => <a>{children}</a> }));
vi.mock('@tanstack/react-query', () => ({
  useQuery: () => ({ data: state.album }),
  useMutation: () => ({ mutate: vi.fn(), isPending: false, isError: false }),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));
vi.mock('../hooks/usePermissions', () => ({ useCan: () => state.owner }));
vi.mock('../hooks/useArtists', () => ({ useArtistsList: () => ({ data: undefined, isLoading: false }) }));
vi.mock('../hooks/useLibrary', () => ({ useAlbums: () => ({ data: undefined }), useScanRoots: () => ({ data: [{ writable: true }] }) }));
vi.mock('../hooks/useNaming', () => ({ useNaming: () => ({ data: { saved: true } }) }));
vi.mock('../hooks/useAlbumSplit', () => ({
  useAlbumSplit: () => ({ data: state.split }),
  useAnalyzeSplit: () => ({ mutate: state.analyze, isPending: false }),
}));
vi.mock('../hooks/usePlanWizard', () => ({
  useCreateTagPlan: () => ({ isPending: false, mutateAsync: vi.fn() }),
  useAddToTagPlan: () => ({ isPending: false, mutateAsync: vi.fn() }),
  useLibrarySettings: () => ({ data: state.settings }),
  useOpenTagPlans: () => ({ data: { items: state.openPlans, total: state.openPlans.length } }),
}));

import { TagSheet } from './TagSheet';
import { createPayload, enterIsPrimary, policySummary, primaryAction, releaseSummary, scopeSummary, suggestedName } from './tagSheetModel';
import { albumPickMeta, defaultPresetOf, planIncludesAll } from './tagPlanControls';

const ID = '22222222-2222-4222-8222-222222222222';
const matched = {
  id: ID, state: 'matched', title: 'OK Computer', artistCredit: 'Radiohead', trackCount: 12, tracks: [], candidates: [],
  release: { title: 'OK Computer', date: '1997-05-21', country: 'GB', labels: [{ name: 'Parlophone' }] },
};
const render = () => renderToStaticMarkup(<TagSheet open onOpenChange={() => undefined} libraryId="lib" albums={{ ids: [ID], labels: { [ID]: 'Radiohead — OK Computer' } }} />);
const rowValues = (html: string) => [...html.matchAll(/data-row="([a-z]+)"[^]*?class="[^"]*rowLabel[^"]*">([^<]*)<\/span><span class="[^"]*">([^<]*)<\/span>/g)].map((m) => [m[1], m[3]]);
const plan = (over: Partial<TagPlan>): TagPlan => ({
  id: 'p1', libraryId: 'lib', name: 'Jazz tags', scope: { type: 'albumIds', albumIds: ['a'] },
  policy: { preset: 'canonical_ids_and_fill', id3Version: '2.4', multiValueSeparator: '; ' }, status: 'previewed',
  stats: { filesTouched: 0, fieldsModified: 0, lockedFieldsRespected: 0, filesSkipped: [] }, createdBy: 'u', createdAt: '2026-09-01T00:00:00.000Z', ...over,
});

describe('the Tag sheet', () => {
  beforeEach(() => {
    state.album = matched;
    state.split = { split: null, eligible: false, writable: true, localTrackId: null, tracks: null };
    state.openPlans = [];
    state.owner = true;
    state.analyze.mockClear();
  });

  it('opens on the defaults: one Preview, every row collapsed with its value', () => {
    const html = render();
    expect(html.match(/data-tag-primary=""[^>]*>[^]*?<\/button>/)?.[0]).toContain('Preview');
    expect(html.match(/data-tag-primary/g)).toHaveLength(1);
    expect(rowValues(html)).toEqual([
      ['albums', 'Radiohead — OK Computer'],
      ['release', 'OK Computer (1997, GB, Parlophone)'],
      // the owner's saved default (Settings › Tag preferences) is not seeded on the first render; the wizard's was the same
      ['fields', 'Canonical IDs + fill · ID3 v2.4'],
      ['paths', 'Organize · On'],
      ['name', 'Radiohead — OK Computer tags'],
    ]);
    expect(html).not.toContain('aria-expanded="true"');
    expect(html).not.toContain('data-line=');
  });

  it('without a match: one line, and the button picks a release', () => {
    state.album = { ...matched, state: 'review', release: null };
    const html = render();
    expect(html).toContain('data-line="no-match"');
    expect(html).toContain('No release matched');
    expect(html.match(/data-tag-primary=""[^>]*>[^]*?<\/button>/)?.[0]).toContain('Pick a release');
    expect(rowValues(html)).toContainEqual(['release', 'None']);
  });

  it('one file holding the whole album: the split line with the track count, and Split first On', () => {
    state.split = { split: null, eligible: true, writable: true, localTrackId: 't', tracks: 11 };
    const html = render();
    expect(html).toContain('One file holds the whole album. Tagging splits it into 11 tracks first.');
    expect(rowValues(html)).toContainEqual(['split', 'On · 11 tracks']);
  });

  it('a plan not applied yet: a Plan row, New plan by default', () => {
    state.openPlans = [plan({})];
    expect(rowValues(render())[0]).toEqual(['plan', 'New plan']);
  });

  it('Paths is the owner\'s; an editor has no Split first either', () => {
    state.owner = false;
    state.split = undefined;
    const rows = rowValues(render()).map((r) => r[0]);
    expect(rows).not.toContain('paths');
    expect(rows).not.toContain('split');
  });
});

describe('the Tag sheet words and payload', () => {
  const scope = { scopeType: 'albumIds' as const, albumIds: [ID], albumLabels: { [ID]: 'Radiohead — OK Computer' } };
  const policy = { preset: 'canonical_ids_and_fill' as const, id3Version: '2.4' as const, multiValueSeparator: '; ' };

  it('names a release by year, country and label', () => {
    expect(releaseSummary({ title: 'OK Computer', date: '1997-05-21', country: 'GB', labels: [{ name: 'Parlophone' }] })).toBe('OK Computer (1997, GB, Parlophone)');
    expect(releaseSummary({ title: 'Demo', date: null, country: null, labels: null })).toBe('Demo');
    expect(releaseSummary(null)).toBeNull();
  });

  it('summarises scope and policy', () => {
    expect(scopeSummary(scope)).toBe('Radiohead — OK Computer');
    expect(scopeSummary({ scopeType: 'albumIds', albumIds: ['a', 'b'] })).toBe('2 albums');
    expect(scopeSummary({ scopeType: null })).toBeNull();
    expect(suggestedName({ scopeType: 'library' })).toBe('Whole library tags');
    expect(policySummary(policy)).toBe('Canonical IDs + fill · ID3 v2.4');
  });

  it('sends Organize only when changed and Split first only when off', () => {
    expect(createPayload({ scope, policy, name: '', organize: null, split: true })).toEqual({
      name: 'Radiohead — OK Computer tags', scope: { type: 'albumIds', albumIds: [ID] }, policy,
    });
    expect(createPayload({ scope, policy, name: ' Mine ', organize: false, split: false })?.policy).toEqual({ ...policy, organize: false, split: false });
    expect(createPayload({ scope: { scopeType: null }, policy, name: '', organize: null, split: true })).toBeNull();
  });

  it('one primary action: pick a release, pick what it covers, add, or Preview', () => {
    expect(primaryAction({ unmatched: true, scopeReady: true, addTo: false }).kind).toBe('pick-release');
    expect(primaryAction({ unmatched: false, scopeReady: false, addTo: false }).kind).toBe('pick-scope');
    expect(primaryAction({ unmatched: false, scopeReady: true, addTo: true }).label).toBe('Add to plan');
    expect(primaryAction({ unmatched: false, scopeReady: true, addTo: false }).label).toBe('Preview');
  });

  it('Enter is the primary action except on buttons, links, lists and search boxes', () => {
    expect(enterIsPrimary(null)).toBe(true);
    expect(enterIsPrimary({ tagName: 'DIV' })).toBe(true);
    expect(enterIsPrimary({ tagName: 'INPUT', type: 'text' })).toBe(true);
    expect(enterIsPrimary({ tagName: 'INPUT', type: 'radio' })).toBe(true);
    for (const t of [{ tagName: 'BUTTON' }, { tagName: 'A' }, { tagName: 'SELECT' }, { tagName: 'INPUT', type: 'search' }]) expect(enterIsPrimary(t)).toBe(false);
  });

  it('keeps the wizard\'s small labels', () => {
    expect(albumPickMeta({ year: null, trackCount: 1, formats: ['mp3'] })).toBe('1 track · mp3');
    expect(defaultPresetOf({ preset: 'manual' })).toBe('canonical_ids_and_fill');
    const p = plan({ scope: { type: 'albumIds', albumIds: ['a', 'b'] } });
    expect(planIncludesAll(p, ['a'])).toBe(true);
    expect(planIncludesAll(p, ['a', 'c'])).toBe(false);
    expect(planIncludesAll(plan({ scope: { type: 'library' } }), ['a'])).toBe(false);
  });
});
