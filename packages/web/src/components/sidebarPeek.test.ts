/**
 * Auto-hide's logic apart from the DOM: when it applies, which pointer
 * positions reveal the sidebar, the reveal and hide delays, focus and
 * Escape (show and hide at once), and the pin. Chrome measures
 * the real thing (the Sidebar · Auto-hide stories).
 */
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { EDGE_PX, HIDE_MS, REVEAL_MS, armsReveal, barBand, createPeek, inSidebar, sidebarMenuOpen, sidebarMode } from './sidebarPeek';
import { PeekMark, SidebarPin } from './SidebarPin';

describe('when Auto-hide applies', () => {
  it('Always by default, and always below the desktop query whatever is stored', () => {
    expect(sidebarMode({ sidebarAutoHide: false, sidebarPinned: false }, true)).toBe('always');
    expect(sidebarMode({ sidebarAutoHide: false, sidebarPinned: true }, true)).toBe('always');
    expect(sidebarMode({ sidebarAutoHide: true, sidebarPinned: false }, false)).toBe('always');
    expect(sidebarMode({ sidebarAutoHide: true, sidebarPinned: true }, false)).toBe('always');
  });
  it('on a desktop: hidden until pinned', () => {
    expect(sidebarMode({ sidebarAutoHide: true, sidebarPinned: false }, true)).toBe('peek');
    expect(sidebarMode({ sidebarAutoHide: true, sidebarPinned: true }, true)).toBe('pinned');
  });
});

describe('the zone', () => {
  const band = { top: 64, bottom: 820 };
  const at = (overControl = false, overPlayer = false) => ({ width: 248, band, overControl, overPlayer });
  it('is the sidebar’s own width', () => {
    expect(armsReveal(0, 400, at())).toBe(true);
    expect(armsReveal(120, 400, at())).toBe(true);
    expect(armsReveal(247, 400, at())).toBe(true);
    expect(armsReveal(248, 400, at())).toBe(false);
    expect(armsReveal(900, 400, at())).toBe(false);
    expect(armsReveal(-1, 400, at())).toBe(false);
  });
  it('lies between the bars: never over the top bar or the player bar', () => {
    expect(armsReveal(0, 63, at())).toBe(false);
    expect(armsReveal(0, 64, at())).toBe(true);
    expect(armsReveal(0, 819, at())).toBe(true);
    expect(armsReveal(0, 820, at())).toBe(false);
  });
  it('sits under the page’s own controls, except in the leftmost few px', () => {
    expect(armsReveal(40, 400, at(true))).toBe(false);
    expect(armsReveal(EDGE_PX + 1, 400, at(true))).toBe(false);
    expect(armsReveal(EDGE_PX, 400, at(true))).toBe(true);
    expect(armsReveal(0, 400, at(true))).toBe(true);
  });
  it('never over the player bar’s own dock (the strip above it included)', () => {
    expect(armsReveal(0, 400, at(false, true))).toBe(false);
    expect(armsReveal(100, 400, at(false, true))).toBe(false);
  });
});

describe('the band between the bars', () => {
  const r = (top: number, height: number) => ({ top, bottom: top + height, height });
  it('the whole height with no bars', () => {
    expect(barBand([], null, 900)).toEqual({ top: 0, bottom: 900 });
  });
  it('under the lowest top bar, above the player bar', () => {
    expect(barBand([r(0, 64), r(0, 56)], { top: 820 }, 900)).toEqual({ top: 64, bottom: 820 });
  });
  it('ignores a bar that takes no room or sits down the page', () => {
    expect(barBand([r(0, 0), r(500, 80)], { top: 820 }, 900)).toEqual({ top: 0, bottom: 820 });
  });
  it('never starts below a quarter of the window', () => {
    expect(barBand([r(100, 300)], null, 800)).toEqual({ top: 200, bottom: 800 });
  });
});

describe('the delays', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });
  const make = () => {
    const changes: boolean[] = [];
    const peek = createPeek((shown) => changes.push(shown));
    return { peek, changes };
  };

  it('reveals REVEAL_MS (about 140 ms) after the pointer comes in, and moving on in the zone does not restart it', () => {
    const { peek, changes } = make();
    expect(REVEAL_MS).toBe(140);
    peek.pointerIn();
    vi.advanceTimersByTime(100);
    peek.pointerIn();
    vi.advanceTimersByTime(39);
    expect(peek.shown).toBe(false);
    vi.advanceTimersByTime(1);
    expect(peek.shown).toBe(true);
    expect(changes).toEqual([true]);
  });

  it('a pointer that passes through the zone in under REVEAL_MS reveals nothing', () => {
    const { peek, changes } = make();
    peek.pointerIn();
    vi.advanceTimersByTime(REVEAL_MS - 1);
    peek.pointerOut();
    vi.advanceTimersByTime(1000);
    expect(changes).toEqual([]);
  });

  it('hides HIDE_MS (about 320 ms) after the pointer leaves; coming back before then cancels the hide', () => {
    const { peek, changes } = make();
    expect(HIDE_MS).toBe(320);
    peek.show();
    peek.pointerOut();
    vi.advanceTimersByTime(300);
    peek.pointerIn();
    vi.advanceTimersByTime(1000);
    expect(peek.shown).toBe(true);
    peek.pointerOut();
    vi.advanceTimersByTime(100);
    peek.pointerOut();
    vi.advanceTimersByTime(HIDE_MS - 100 - 1);
    expect(peek.shown).toBe(true);
    vi.advanceTimersByTime(1);
    expect(peek.shown).toBe(false);
    expect(changes).toEqual([true, false]);
  });

  it('focus shows it at once and cancels a pending hide; Escape, focus leaving or another page hide it at once', () => {
    const { peek } = make();
    peek.pointerIn();
    peek.show();
    expect(peek.shown).toBe(true);
    peek.pointerOut();
    peek.show();
    vi.advanceTimersByTime(1000);
    expect(peek.shown).toBe(true);
    peek.pointerIn();
    peek.hide();
    expect(peek.shown).toBe(false);
    // the reveal that was pending when it hid does not bring it back
    peek.pointerIn();
    peek.hide();
    vi.advanceTimersByTime(1000);
    expect(peek.shown).toBe(false);
  });

  it('dispose leaves no timer running', () => {
    const { peek, changes } = make();
    peek.pointerIn();
    peek.dispose();
    vi.advanceTimersByTime(1000);
    expect(changes).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('the pin', () => {
  it('the item says what it will do, and names the sidebar for a screen reader', () => {
    const off = renderToStaticMarkup(createElement(SidebarPin, { pinned: false, onToggle: () => undefined }));
    expect(off).toMatch(/aria-label="Pin the sidebar"/);
    expect(off).toMatch(/<span>Pin<\/span>/);
    expect(off).not.toMatch(/aria-keyshortcuts|<kbd/);
    const on = renderToStaticMarkup(createElement(SidebarPin, { pinned: true, onToggle: () => undefined }));
    expect(on).toMatch(/aria-label="Unpin the sidebar"/);
    expect(on).toMatch(/<span>Unpin<\/span>/);
  });
  it('the edge mark is decoration only: no button, no icon, no name', () => {
    const html = renderToStaticMarkup(createElement(PeekMark));
    expect(html).toMatch(/^<span[^>]*aria-hidden="true"[^>]*><\/span>$/);
    expect(html).not.toMatch(/button|svg|aria-label/);
  });
});

describe('a menu opened from the sidebar (portalled to <body>)', () => {
  // just enough of the DOM: the sidebar holds the monogram, the list sits in <body>
  type Fake = { id?: string; attrs: Record<string, string>; parent: Fake | null; kids: Fake[] };
  const node = (attrs: Record<string, string> = {}, parent: Fake | null = null): Fake => {
    const n: Fake = { attrs, parent, kids: [] };
    if (attrs.id) n.id = attrs.id;
    parent?.kids.push(n);
    return n;
  };
  const all = (n: Fake): Fake[] => n.kids.flatMap((k) => [k, ...all(k)]);
  const matches = (n: Fake, sel: string) => [...sel.matchAll(/\[([\w-]+)(?:="([^"]*)")?\]/g)].every(([, k, v]) => k! in n.attrs && (v === undefined || n.attrs[k!] === v));
  const asEl = (n: Fake): Element => ({
    id: n.id ?? '',
    contains: (o: unknown) => { for (let c = (o as { _fake?: Fake } | null)?._fake ?? null; c; c = c.parent) if (c === n) return true; return false; },
    closest: (sel: string) => { for (let c: Fake | null = n; c; c = c.parent) if (matches(c, sel)) return asEl(c); return null; },
    querySelector: (sel: string) => { const f = all(n).find((k) => matches(k, sel)); return f ? asEl(f) : null; },
    querySelectorAll: (sel: string) => all(n).filter((k) => matches(k, sel)).map(asEl),
    getAttribute: (k: string) => n.attrs[k] ?? null,
    _fake: n,
  }) as unknown as Element;

  const body = node();
  const nav = node({}, body);
  const trigger = node({ 'aria-haspopup': 'menu', 'aria-expanded': 'true', 'aria-controls': ':r7:' }, nav);
  const list = node({ role: 'menu', id: ':r7:' }, body);
  const item = node({ role: 'menuitem' }, list);
  const other = node({ role: 'menu', id: ':r9:' }, body);
  const page = node({}, body);

  it('its list counts as the sidebar, so the pointer or focus on it keeps the sidebar shown', () => {
    expect(inSidebar(asEl(nav), asEl(trigger))).toBe(true);
    expect(inSidebar(asEl(nav), asEl(item))).toBe(true);
  });
  it('another menu, or the page, does not', () => {
    expect(inSidebar(asEl(nav), asEl(node({ role: 'menuitem' }, other)))).toBe(false);
    expect(inSidebar(asEl(nav), asEl(page))).toBe(false);
    expect(inSidebar(null, asEl(item))).toBe(false);
  });
  it('the sidebar holds while that menu is open, and lets go when it closes', () => {
    expect(sidebarMenuOpen(asEl(nav))).toBe(true);
    trigger.attrs['aria-expanded'] = 'false';
    expect(sidebarMenuOpen(asEl(nav))).toBe(false);
  });
  it('the hook reads both', () => {
    const src = readFileSync(new URL('./sidebarPeek.ts', import.meta.url), 'utf8');
    expect(src).toMatch(/const onSidebar = inSidebar\(el\(\), t\)/);
    expect(src).toMatch(/p\.shown && \(onSidebar \|\| sidebarMenuOpen\(el\(\)\)\)/);
    expect(src).toMatch(/to instanceof Node && inSidebar\(el\(\), to\)/);
  });
});
