/**
 * The phone compact pass (owner, 2026-11-03, on a Galaxy S25+: "there is an
 * immense clutter on top ... it feels dumb to have two searches ... there
 * is a gap at the bottom between bottom bar and the main content").
 *
 *   one search      the header's search narrows the list page it opens on
 *                   ("In albums"), so the pages carry no search field
 *   one toolbar     the count, then Sort, Filter and Grid/List as icon keys
 *   chips           the value alone where it is unambiguous
 *   no bottom band  a list page's shell leaves no padding under its list
 *   no stuck hover  a card's hover paint is a pointer's only
 *   selection       a finger holds an album to select it
 */
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pageSearchScope } from '../utils/pageSearch';
import { chipText } from './albumsSearch';
import { searchRows, type SearchResult } from '../components/SearchModal';
import { createLongPress, LONG_PRESS_MS } from '../hooks/useLongPress';

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const stripComments = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, '');

describe('one search', () => {
  it('narrows the list page it opens on, and no other page', () => {
    expect(pageSearchScope('/albums')).toEqual({ label: 'In albums', path: '/albums' });
    expect(pageSearchScope('/albums/')).toEqual({ label: 'In albums', path: '/albums' });
    expect(pageSearchScope('/artists')).toEqual({ label: 'In artists', path: '/artists' });
    expect(pageSearchScope('/albums/0190-abc')).toBeNull();
    expect(pageSearchScope('/artists/0190-abc')).toBeNull();
    expect(pageSearchScope('/')).toBeNull();
    expect(pageSearchScope('/settings/updates')).toBeNull();
  });

  const data: SearchResult = {
    albums: [{ id: 'a1', title: 'As As', artist: 'Paper', year: 2007, trackCount: 9 }],
    artists: [{ id: 'r1', name: 'Asa', albumCount: 2 }],
    tracks: [],
  };

  it('offers the page list first, as soon as a word is typed', () => {
    expect(searchRows(undefined, 'a', false, true)).toEqual([{ type: 'scope', primary: '“a”', secondary: '' }]);
    const rows = searchRows(data, 'asas', true, true);
    expect(rows.map((r) => r.type)).toEqual(['scope', 'album', 'artist']);
    expect(rows[0]).toMatchObject({ primary: '“asas”' });
  });

  it('leaves it out where the page has no list of its own', () => {
    expect(searchRows(undefined, 'a', false, false)).toEqual([]);
    expect(searchRows(data, 'asas', true, false).map((r) => r.type)).toEqual(['album', 'artist']);
  });

  it('shows no stale results while the box differs from what was searched', () => {
    expect(searchRows(data, 'asas', false, true).map((r) => r.type)).toEqual(['scope']);
  });

  it('the list pages carry no search field of their own', () => {
    for (const page of ['./AlbumsPage.tsx', './ArtistsPage.tsx']) {
      const tsx = read(page);
      expect(tsx).not.toMatch(/SearchField|placeholder="Search/);
      expect(tsx).toMatch(/<ListToolbar\b/);
    }
  });

  it('the header passes the page scope to the search dialog', () => {
    const layout = read('../components/Layout.tsx');
    expect(layout).toMatch(/pageSearchScope\(pathname\)/);
    expect(layout).toMatch(/<SearchModal onClose=\{closeSearch\} scope=\{searchScope\} \/>/);
  });

  it('the artists list reads its words from the URL', () => {
    expect(read('../router.tsx')).toMatch(/path: '\/artists',\n\s+component: ArtistsPage,\n[\s\S]*?validateSearch/);
  });
});

describe('chips', () => {
  it('say the value alone where it cannot be mistaken', () => {
    expect(chipText('q', 'asas')).toBe('“asas”');
    expect(chipText('format', 'lossless')).toBe('lossless');
    expect(chipText('decade', 2000)).toBe('2000s');
    expect(chipText('genre', 'electronic')).toBe('electronic');
  });

  it('name the filter where the value alone could be another one', () => {
    expect(chipText('artist', 'Low')).toBe('artist: Low');
    expect(chipText('label', 'Warp')).toBe('label: Warp');
    expect(chipText('state', 'needs_review')).toBe('state: Needs review');
  });

  it('are one row that scrolls sideways on a phone, Clear at its end', () => {
    const css = stripComments(read('./AlbumsPage.module.css'));
    const phone = css.slice(css.indexOf('@media (max-width: 720px)'));
    expect(phone).toMatch(/\.chips \{[^}]*flex-wrap: nowrap;[^}]*overflow-x: auto;/);
    expect(read('./AlbumsPage.tsx')).toMatch(/className=\{styles\.clearChips\} onClick=\{clearAll\}>Clear</);
  });
});

describe('toolbar', () => {
  it('is the count and three icon keys: sort, filter, grid or list', () => {
    const tsx = read('../components/ListToolbar.tsx');
    expect(tsx).toMatch(/icon=\{<SortIcon \/>\}/);
    expect(tsx).toMatch(/<FilterIcon \/>/);
    expect(tsx).toMatch(/toList \? <ListIcon \/> : <GridIcon \/>/);
    // the current sort is the key's name
    expect(tsx).toMatch(/label=\{`Sort \$\{sort\.noun\}: \$\{current\?\.label/);
    expect(tsx).toMatch(/checked: o\.value === sort\.value/);
    // keys in the emboss convention, no circles
    expect(tsx).toMatch(/embossClassName\('page'/);
    expect(stripComments(read('../components/ListToolbar.module.css'))).toMatch(/\.key \{\s*width: 40px;\s*height: 40px;/);
  });

  it('opens the filters as a sheet on a phone and as the rail beside the list wider', () => {
    const tsx = read('./AlbumsPage.tsx');
    expect(tsx).toMatch(/\{railOpen && !phone && <FilterRail \{\.\.\.railProps\} \/>\}/);
    expect(tsx).toMatch(/<AlbumsFilterSheet \{\.\.\.railProps\} open=\{railOpen\}/);
    expect(read('./AlbumsFilterSheet.tsx')).toMatch(/<FilterRail \{\.\.\.rail\} variant="sheet" \/>/);
  });
});

describe('no band under a list', () => {
  it('a list page shell has no bottom padding; the scroller pads its last row', () => {
    const shell = stripComments(read('../components/ui/PageShell.module.css'));
    expect(shell).toMatch(/\.pageShellFill \.content \{\s*min-height: 0;\s*padding: 0 var\(--shell-gutter\);/);
    expect(stripComments(read('./AlbumsPage.module.css'))).toMatch(/\.gridContainer \{[^}]*padding-bottom: var\(--space-md\);/);
    expect(stripComments(read('./ArtistsPage.module.css'))).toMatch(/padding: 4px 4px var\(--space-md\);\s*margin: -4px -4px 0;/);
  });
});

describe('touch', () => {
  it('paints a card hover only for a pointer that hovers', () => {
    const css = stripComments(read('./AlbumsPage.module.css'));
    // every :hover rule on a card or a row sits inside @media (hover: hover)
    const outside = css.replace(/@media \(hover: hover\) \{(?:[^{}]*\{[^}]*\})*[^{}]*\}/g, '');
    expect(outside).not.toMatch(/\.(albumCard|albumCardSelected|listRow|listRowSelected):hover/);
  });

  it('shows the grid checkboxes on a touch screen only while selecting', () => {
    const css = stripComments(read('./AlbumsPage.module.css'));
    expect(css).not.toMatch(/@media \(hover: none\) \{ \.cardCheck \{ opacity: 1; \} \}/);
    expect(css).toMatch(/\[data-selecting\] \.cardCheck \{\s*opacity: 1;/);
    expect(css).toMatch(/\.gridContainer:not\(\[data-selecting\]\) \.rowCheck \{ display: none; \}/);
  });

  describe('long press', () => {
    beforeEach(() => { vi.useFakeTimers(); });
    afterEach(() => { vi.useRealTimers(); });
    const finger = { pointerType: 'touch', clientX: 10, clientY: 10 };

    it('a finger held still selects, and the click after the lift is swallowed once', () => {
      const vibrate = vi.fn();
      const press = createLongPress(vibrate);
      const onLong = vi.fn();
      const h = press.bind(onLong);
      h.onPointerDown(finger);
      vi.advanceTimersByTime(LONG_PRESS_MS - 1);
      expect(onLong).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(onLong).toHaveBeenCalledTimes(1);
      expect(vibrate).toHaveBeenCalledWith(10);
      h.onPointerUp();
      expect(press.consumeClick()).toBe(true);
      expect(press.consumeClick()).toBe(false);
      expect(press.wasTouch()).toBe(true);
    });

    it('swallows the click the lift makes wherever it lands, once', () => {
      const listeners = new Set<(e: Event) => void>();
      const clicks = {
        addEventListener: (_t: 'click', fn: (e: Event) => void) => { listeners.add(fn); },
        removeEventListener: (_t: 'click', fn: (e: Event) => void) => { listeners.delete(fn); },
      };
      const press = createLongPress(() => undefined, clicks);
      const h = press.bind(() => undefined);
      h.onPointerDown(finger);
      vi.advanceTimersByTime(LONG_PRESS_MS);
      expect(listeners.size).toBe(1);
      h.onPointerUp();
      const click = { preventDefault: vi.fn(), stopPropagation: vi.fn() } as unknown as Event;
      for (const fn of [...listeners]) fn(click);
      expect(click.preventDefault).toHaveBeenCalled();
      expect(click.stopPropagation).toHaveBeenCalled();
      expect(listeners.size).toBe(0);
      // the item's own guard does not swallow the next, real tap
      expect(press.consumeClick()).toBe(false);
      // a lift with no click after it stops waiting
      h.onPointerDown(finger);
      vi.advanceTimersByTime(LONG_PRESS_MS);
      h.onPointerUp();
      vi.advanceTimersByTime(400);
      expect(listeners.size).toBe(0);
    });

    it('a finger that moves is scrolling; a quick tap opens', () => {
      const press = createLongPress(() => undefined);
      const onLong = vi.fn();
      const h = press.bind(onLong);
      h.onPointerDown(finger);
      h.onPointerMove({ ...finger, clientY: 30 });
      vi.advanceTimersByTime(LONG_PRESS_MS * 2);
      expect(onLong).not.toHaveBeenCalled();
      h.onPointerDown(finger);
      h.onPointerUp();
      vi.advanceTimersByTime(LONG_PRESS_MS * 2);
      expect(onLong).not.toHaveBeenCalled();
      expect(press.consumeClick()).toBe(false);
    });

    it('leaves a mouse alone, and keeps the browser menu off only for a finger', () => {
      const press = createLongPress(() => undefined);
      const onLong = vi.fn();
      const h = press.bind(onLong);
      h.onPointerDown({ pointerType: 'mouse', clientX: 0, clientY: 0 });
      vi.advanceTimersByTime(LONG_PRESS_MS * 2);
      expect(onLong).not.toHaveBeenCalled();
      expect(press.wasTouch()).toBe(false);
      const mouseMenu = { preventDefault: vi.fn() };
      h.onContextMenu(mouseMenu);
      expect(mouseMenu.preventDefault).not.toHaveBeenCalled();
      h.onPointerDown(finger);
      const fingerMenu = { preventDefault: vi.fn() };
      h.onContextMenu(fingerMenu);
      expect(fingerMenu.preventDefault).toHaveBeenCalled();
    });
  });
});

describe('the phone menu', () => {
  it('is the whole screen under the bar, down to the player bar, the account at its foot', () => {
    const css = stripComments(read('../components/Layout.module.css'));
    expect(css).toMatch(/\.navOpen \.navSheet \{[^}]*position: fixed;[^}]*top: var\(--nav-bar-h, 3\.5rem\);[^}]*bottom: 0;/);
    expect(css).toMatch(/:global\(html\[data-player-bar\]\) \.navOpen \.navSheet \{ bottom: var\(--player-bar-h, 0px\); \}/);
    expect(css).toMatch(/\.navOpen \.account \{ display: flex; position: sticky; bottom: 0; margin: auto 0 0; \}/);
    expect(read('../components/Layout.tsx')).toMatch(/setProperty\('--nav-bar-h'/);
  });
});
