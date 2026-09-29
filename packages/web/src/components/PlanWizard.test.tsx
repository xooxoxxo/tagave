/**
 * Which first step the tag plan wizard shows. From the album page ("Fix
 * tags") with plans that have not been applied yet, it asks where the fixes
 * go; with none, it goes straight to a new plan, as before.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { TagPlan } from '@liner/shared';

const openPlans = vi.hoisted(() => ({
  current: { isSuccess: true, isError: false, data: { items: [] as unknown[], total: 0, limit: 200, offset: 0 } as unknown },
}));

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => () => undefined,
  Link: ({ children }: { children: unknown }) => children,
}));
vi.mock('../hooks', () => ({ useCurrentLibrary: () => ({ libraryId: 'lib' }) }));
vi.mock('../hooks/useArtists', () => ({ useArtistsList: () => ({ data: undefined, isLoading: false }) }));
vi.mock('../hooks/useLibrary', () => ({
  useAlbums: () => ({ data: undefined, isLoading: false }),
  useScanRoots: () => ({ data: [{ writable: true }] }),
}));
vi.mock('../hooks/usePlanWizard', () => ({
  useCreateTagPlan: () => ({ isPending: false, mutateAsync: vi.fn() }),
  useAddToTagPlan: () => ({ isPending: false, mutateAsync: vi.fn() }),
  useLibrarySettings: () => ({ data: { tagWritesEnabled: true } }),
  useOpenTagPlans: () => openPlans.current,
}));

import { PlanWizard, planIncludesAll } from './PlanWizard';

const plan = (over: Partial<TagPlan>): TagPlan => ({
  id: 'p1',
  libraryId: 'lib',
  name: 'Jazz tags',
  scope: { type: 'albumIds', albumIds: ['11111111-1111-4111-8111-111111111111'] },
  policy: { preset: 'canonical_ids_and_fill', id3Version: '2.4', multiValueSeparator: '; ' },
  status: 'previewed',
  stats: { filesTouched: 0, fieldsModified: 0, lockedFieldsRespected: 0, filesSkipped: [] },
  createdBy: 'u',
  createdAt: '2026-09-01T00:00:00.000Z',
  ...over,
});

const album = '22222222-2222-4222-8222-222222222222';
const fromAlbumPage = { albumIds: [album], albumLabels: { [album]: 'Miles Davis — Kind of Blue' } };
const render = (props: { initialScope?: typeof fromAlbumPage } = {}) =>
  renderToStaticMarkup(<PlanWizard libraryId="lib" onClose={() => undefined} {...props} />);

describe('PlanWizard first step', () => {
  beforeEach(() => {
    openPlans.current = { isSuccess: true, isError: false, data: { items: [], total: 0, limit: 200, offset: 0 } };
  });

  it('from the album page with open plans, offers each plan and a new plan, album already chosen', () => {
    openPlans.current = {
      isSuccess: true,
      isError: false,
      data: {
        items: [
          plan({ id: 'p1', name: 'Jazz tags', scopeLabel: '3 albums', status: 'previewed' }),
          plan({ id: 'p2', name: 'Miles', scopeLabel: '1 album', status: 'draft', scope: { type: 'albumIds', albumIds: [album] } }),
        ],
        total: 2,
        limit: 200,
        offset: 0,
      },
    };
    const html = render({ initialScope: fromAlbumPage });
    expect(html).toContain('Where should the tag fixes for Miles Davis — Kind of Blue go?');
    expect(html).toContain('Add to a plan you have not applied yet');
    expect(html).toContain('Jazz tags');
    expect(html).toContain('3 albums · Preview ready');
    expect(html).toContain('1 album · Preview not run yet');
    expect(html).toContain('Already includes this album');
    // the plan that already has the album cannot be picked; the other can
    expect(html).toMatch(/<input(?=[^>]*value="p2")[^>]*disabled/);
    expect(html).not.toMatch(/<input(?=[^>]*value="p1")[^>]*disabled/);
    expect(html).toContain('Start a new plan');
    expect(html).not.toContain('How should the tags be fixed?');
    expect(html).not.toContain('undefined');
  });

  it('from the album page with no open plans, goes straight to the policy step and shows step 1 done', () => {
    const html = render({ initialScope: fromAlbumPage });
    expect(html).toContain('How should the tags be fixed?');
    expect(html).toContain('aria-label="Step 2 of 2"');
    // step 1 is shown as done, with the album it holds, and can be reopened
    expect(html).toContain('What it covers');
    expect(html).toContain('Miles Davis — Kind of Blue');
    expect(html).toMatch(/<button[^>]*class="[^"]*stepButton[^"]*"[^>]*>.*What it covers/);
    expect(html).not.toContain('Add to a plan you have not applied yet');
  });

  it('lays each preset out as radio plus one text column', () => {
    const html = render({ initialScope: fromAlbumPage });
    expect(html).toMatch(/<label class="[^"]*presetCard[^"]*"><input[^>]*value="fill_blanks_only"[^>]*\/><span class="[^"]*choiceText/);
  });

  it('from the plans page with no open plans, starts at the scope step with no extra choice', () => {
    const html = render();
    expect(html).toContain('What should the plan cover?');
    expect(html).toContain('aria-label="Step 1 of 2"');
    expect(html).not.toContain('Start a new plan');
  });

  it('from the plans page with open plans, asks first', () => {
    openPlans.current = { isSuccess: true, isError: false, data: { items: [plan({})], total: 1, limit: 200, offset: 0 } };
    const html = render();
    expect(html).toContain('Start a new plan, or add albums to one you have not applied yet?');
    expect(html).not.toContain('What should the plan cover?');
  });

  it('waits for the plan list instead of guessing', () => {
    openPlans.current = { isSuccess: false, isError: false, data: undefined };
    expect(render({ initialScope: fromAlbumPage })).toContain('Loading your plans…');
  });

  it('treats a failed plan list as nothing to add to', () => {
    openPlans.current = { isSuccess: false, isError: true, data: undefined };
    expect(render({ initialScope: fromAlbumPage })).toContain('How should the tags be fixed?');
  });

  it('has no stray separator when a plan has no scope label, and says when the list is cut short', () => {
    openPlans.current = {
      isSuccess: true,
      isError: false,
      data: { items: [plan({ name: '', status: 'previewed' })], total: 250, limit: 200, offset: 0 },
    };
    const html = render({ initialScope: fromAlbumPage });
    expect(html).toContain('Untitled plan');
    expect(html).toMatch(/>Preview ready</);
    expect(html).toContain('Showing the 1 newest of 250 plans you have not applied yet.');
  });
});

describe('planIncludesAll', () => {
  const p = plan({ scope: { type: 'albumIds', albumIds: ['a', 'b'] } });
  it('is true only when every album is already in an album-list plan', () => {
    expect(planIncludesAll(p, ['a'])).toBe(true);
    expect(planIncludesAll(p, ['a', 'b'])).toBe(true);
    expect(planIncludesAll(p, ['a', 'c'])).toBe(false);
    expect(planIncludesAll(p, [])).toBe(false);
    expect(planIncludesAll(plan({ scope: { type: 'library' } }), ['a'])).toBe(false);
  });
});
