/**
 * Library care's tabs (spec §4): who sees which, the counts, the tab a link
 * may open, and where a link to a module that is off goes (the modules rule).
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { allowedTab, parseWorkSearch, workTabGate, workTabs } from './workTabs';

const source = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');

const counts = { queue: 0, identify: 0, attention: 0, tasks: 0, inbox: 0 };
const editor = { owner: false, editor: true, lidarrOn: false, autotaggerOn: false, counts };
const owner = { owner: true, editor: true, lidarrOn: false, autotaggerOn: false, counts };
const values = (o: Parameters<typeof workTabs>[0]) => workTabs(o).map((t) => t.value);

describe('Library care tabs', () => {
  it('an editor gets Genre mapping and Background activity, last', () => {
    const tabs = workTabs(editor);
    expect(tabs.slice(-2).map((t) => t.value)).toEqual(['genres', 'activity']);
    expect(tabs.slice(-2).map((t) => t.label)).toEqual(['Genre mapping', 'Background activity']);
  });

  it("the owner's tabs stay the owner's", () => {
    const mine = ['deleting', 'moved', 'organize', 'inbox'];
    for (const v of mine) expect(values(editor)).not.toContain(v);
    expect(values(owner)).toEqual(['review', 'identify', 'attention', 'tasks', ...mine, 'genres', 'activity']);
  });

  it('Autotagger while the module is on, for everyone', () => {
    expect(values({ ...editor, autotaggerOn: true })).toContain('autotagger');
    expect(values({ ...owner, autotaggerOn: true })).toContain('autotagger');
    for (const autotaggerOn of [false, null]) {
      expect(values({ ...editor, autotaggerOn })).not.toContain('autotagger');
      expect(values({ ...owner, autotaggerOn })).not.toContain('autotagger');
    }
  });

  it("Getting is the owner's while Lidarr is on", () => {
    expect(values({ ...owner, lidarrOn: true })).toContain('getting');
    expect(values({ ...owner, lidarrOn: null })).not.toContain('getting');
    expect(values({ ...owner, lidarrOn: false })).not.toContain('getting');
    expect(values({ ...editor, lidarrOn: true })).not.toContain('getting');
  });

  it('a count only when there is one', () => {
    const withQueue = workTabs({ ...editor, counts: { ...counts, queue: 3 } });
    expect(withQueue.find((t) => t.value === 'review')).toMatchObject({ count: 3 });
    expect(workTabs(editor).find((t) => t.value === 'review')).not.toHaveProperty('count');
  });

  it('a tab the person lacks opens Review', () => {
    const tabs = workTabs(editor);
    expect(allowedTab('deleting', tabs)).toBe('review');
    expect(allowedTab(undefined, tabs)).toBe('review');
    expect(allowedTab('activity', tabs)).toBe('activity');
  });
});

describe('a tab mapped to a module', () => {
  it('an Autotagger link with the module off takes the owner to Modules', () => {
    expect(workTabGate({ tab: 'autotagger', search: { tab: 'autotagger' }, owner: true, modules: { autotagger: false } }))
      .toEqual({ to: '/settings/modules', search: {} });
  });

  it('an Autotagger link with the module off opens Review for others', () => {
    expect(workTabGate({ tab: 'autotagger', search: { tab: 'autotagger', job: 'j1' }, owner: false, modules: { autotagger: false } }))
      .toEqual({ to: '/work', search: { job: 'j1' } });
  });

  it('Getting with Lidarr off goes the same way', () => {
    expect(workTabGate({ tab: 'getting', search: { tab: 'getting' }, owner: true, modules: { lidarr: false } }))
      .toEqual({ to: '/settings/modules', search: {} });
  });

  it('a module still loading holds the tab', () => {
    expect(workTabGate({ tab: 'autotagger', search: {}, owner: true, modules: { autotagger: null } })).toEqual({ wait: true });
    expect(workTabGate({ tab: 'autotagger', search: {}, owner: true, modules: { autotagger: true } })).toBeNull();
    for (const autotagger of [true, false, null]) {
      expect(workTabGate({ tab: 'genres', search: {}, owner: false, modules: { autotagger } })).toBeNull();
    }
  });

  it('the page obeys the gate', () => {
    const tsx = source('./WorkPage.tsx');
    expect(tsx).toMatch(/workTabGate\(/);
    expect(tsx).toMatch(/<Navigate\b[^>]*\breplace\b/);
  });
});

describe('the address', () => {
  it('?job= survives', () => {
    expect(parseWorkSearch({ tab: 'activity', job: 'j1' })).toEqual({ tab: 'activity', job: 'j1' });
    expect(parseWorkSearch({ tab: 'activity', job: '' })).toEqual({ tab: 'activity' });
    expect(() => parseWorkSearch({ tab: 'nope' })).toThrow();
  });

  it('the router reads the tabs from workTabs', () => {
    const router = source('../router.tsx');
    expect(router).toMatch(/import \{[^}]*\bparseWorkSearch\b[^}]*\} from '\.\/pages\/workTabs'/);
    expect(router).not.toContain("'getting', 'autotagger'].includes");
  });
});
