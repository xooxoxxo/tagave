/**
 * Settings › Appearance › Sidebar › Auto-hide, on a desktop: the sidebar is
 * hidden and the page takes the whole width; a faint accent mark sits on the
 * left edge. When the pointer comes to where the sidebar sits it slides in
 * over the page (no layout shift) after REVEAL_MS, and slides out HIDE_MS
 * after the pointer leaves it. It opens between the bars: under the page's
 * top bar (an album's or a detail page's header, Settings' sticky header)
 * and above the player bar, which both stay whole. Tab into it shows it;
 * Escape, focus leaving or another page hides it. Pin keeps it in place,
 * pushing the page as Always does. Phones and tablets keep their own bar and
 * menu sheet.
 *
 * The zone is the sidebar's own width between the bars, but it sits under
 * the page's controls: nothing covers the page, the pointer is read from
 * document-wide pointer moves. Over the page's own buttons, links and fields
 * in that strip (a list's first column) the pointer does nothing, so they
 * stay clickable; over anything else there, and always in the leftmost
 * EDGE_PX, it reveals. Over a top bar or the player bar it never does.
 */
import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';

/** Where auto-hide applies: a desktop window with a pointer that hovers. Layout.module.css repeats it. */
export const PEEK_QUERY = '(min-width: 1024px) and (hover: hover)';
export const REVEAL_MS = 140;
export const HIDE_MS = 320;
/** The leftmost strip that reveals the sidebar whatever is under the pointer. */
export const EDGE_PX = 8;
/** The sidebar's width (Layout.module.css .nav), until it can be measured. */
export const SIDEBAR_PX = 248;

/** A page's top bar: the sidebar opens under it. */
export const TOP_BAR = '[data-top-bar]';
/** The player bar's dock (<html> carries the same attribute while the bar is there). */
export const PLAYER_BAR = ':not(html)[data-player-bar]';

/** What the page's own controls are: under the pointer, they win over the zone. */
export const PAGE_CONTROL = 'a[href], button, input, select, textarea, summary, label, [role="button"], [role="link"], [role="slider"], [role="tab"], [role="checkbox"], [role="radio"], [role="switch"], [role="menuitem"], [role="option"], [contenteditable=""], [contenteditable="true"], [tabindex]:not([tabindex="-1"])';

export type SidebarMode = 'always' | 'peek' | 'pinned';

/** How the desktop sidebar shows: Always below the desktop query whatever the preference says. */
export function sidebarMode(prefs: { sidebarAutoHide: boolean; sidebarPinned: boolean }, desktop: boolean): SidebarMode {
  if (!prefs.sidebarAutoHide || !desktop) return 'always';
  return prefs.sidebarPinned ? 'pinned' : 'peek';
}

/** Where the sidebar opens, in viewport px: from `top` (under the top bar) down to `bottom` (the player bar's top edge). */
export interface Band { top: number; bottom: number }

/**
 * The band between the bars. A top bar counts when it sits in the top
 * quarter of the window (a sticky header, not one scrolled down the page);
 * the lowest one wins. Without a player bar the band reaches the bottom.
 */
export function barBand(tops: ReadonlyArray<{ top: number; bottom: number; height: number }>, player: { top: number } | null, viewportH: number): Band {
  let top = 0;
  for (const r of tops) if (r.height > 0 && r.top < viewportH / 4) top = Math.max(top, Math.min(r.bottom, viewportH / 4));
  const bottom = player ? Math.max(top, Math.min(player.top, viewportH)) : viewportH;
  return { top: Math.round(top), bottom: Math.round(bottom) };
}

/** Whether the pointer, at (x, y), asks for the hidden sidebar. */
export function armsReveal(x: number, y: number, at: { width: number; band: Band; overControl: boolean; overPlayer: boolean }): boolean {
  if (x < 0 || x >= at.width || at.overPlayer) return false;
  if (y < at.band.top || y >= at.band.bottom) return false;
  return x <= EDGE_PX || !at.overControl;
}

export interface Timers { set: (run: () => void, ms: number) => unknown; clear: (id: unknown) => void }
const realTimers: Timers = {
  set: (run, ms) => globalThis.setTimeout(run, ms),
  clear: (id) => globalThis.clearTimeout(id as ReturnType<typeof setTimeout>),
};

export interface Peek {
  readonly shown: boolean;
  /** The pointer is in the zone or on the sidebar: reveal after REVEAL_MS (once), cancel a pending hide. */
  pointerIn(): void;
  /** The pointer left both: hide after HIDE_MS (once), cancel a pending reveal. */
  pointerOut(): void;
  /** Focus came in: now. */
  show(): void;
  /** Escape, focus leaving, another page: now. */
  hide(): void;
  dispose(): void;
}

/** The reveal and hide delays, apart from the DOM. */
export function createPeek(onChange: (shown: boolean) => void, timers: Timers = realTimers): Peek {
  let shown = false;
  let revealing: unknown = null;
  let hiding: unknown = null;
  const cancel = () => {
    if (revealing !== null) timers.clear(revealing);
    if (hiding !== null) timers.clear(hiding);
    revealing = hiding = null;
  };
  const set = (next: boolean) => {
    if (next === shown) return;
    shown = next;
    onChange(next);
  };
  return {
    get shown() { return shown; },
    pointerIn() {
      if (hiding !== null) { timers.clear(hiding); hiding = null; }
      if (shown || revealing !== null) return;
      revealing = timers.set(() => { revealing = null; set(true); }, REVEAL_MS);
    },
    pointerOut() {
      if (revealing !== null) { timers.clear(revealing); revealing = null; }
      if (!shown || hiding !== null) return;
      hiding = timers.set(() => { hiding = null; set(false); }, HIDE_MS);
    },
    show() { cancel(); set(true); },
    hide() { cancel(); set(false); },
    dispose: cancel,
  };
}

/**
 * The behaviour on the real sidebar: `enabled` is Auto-hide on a desktop
 * (pinned or not), `pinned` whether it is pinned now. Returns whether the
 * hidden sidebar is shown, and a way to hide it at once (another page).
 * `focusAway` takes focus out of a sidebar that hid with focus in it.
 */
export function useSidebarPeek(nav: RefObject<HTMLElement | null>, enabled: boolean, pinned: boolean, focusAway: () => void, initialShown = false): { shown: boolean; hideNow: () => void } {
  const [shown, setShown] = useState(false);
  const peek = useRef<Peek | null>(null);
  const pinnedRef = useRef(pinned);
  // the pointer is in the zone or on the sidebar (read when unpinning)
  const pointerHere = useRef(false);
  const away = useRef(focusAway);
  away.current = focusAway;

  const focusInside = () => {
    const active = globalThis.document?.activeElement;
    return !!active && !!nav.current?.contains(active);
  };

  useEffect(() => {
    if (!enabled) return;
    const p = createPeek((next) => {
      setShown(next);
      // hidden by the pointer with a clicked control still focused: let it go
      // (a keyboard's focus stays and Tab brings the sidebar back)
      const active = globalThis.document?.activeElement;
      if (!next && active instanceof HTMLElement && nav.current?.contains(active) && !active.matches(':focus-visible')) active.blur();
    });
    peek.current = p;
    if (initialShown && !pinnedRef.current) p.show();
    const doc = globalThis.document;
    const el = () => nav.current;
    // the band between the bars, written onto the sidebar for its CSS
    let band: Band = { top: 0, bottom: globalThis.innerHeight ?? 0 };
    const measure = () => {
      const vh = globalThis.innerHeight ?? 0;
      const tops = [...(doc?.querySelectorAll(TOP_BAR) ?? [])].map((n) => n.getBoundingClientRect());
      const player = doc?.querySelector(PLAYER_BAR)?.getBoundingClientRect() ?? null;
      const next = barBand(tops, player, vh);
      const side = el();
      if (side && (next.top !== band.top || next.bottom !== band.bottom || !side.style.getPropertyValue('--peek-top'))) {
        side.style.setProperty('--peek-top', `${next.top}px`);
        side.style.setProperty('--peek-bottom', `${Math.max(0, vh - next.bottom)}px`);
      }
      band = next;
    };
    measure();
    const onMove = (e: PointerEvent) => {
      if (e.pointerType === 'touch') return;
      const t = e.target instanceof Element ? e.target : null;
      const onSidebar = !!t && !!el()?.contains(t);
      const width = el()?.offsetWidth || SIDEBAR_PX;
      // only near the left edge is it worth a look at where the bars are
      if (!p.shown && e.clientX < width) measure();
      const here = (p.shown && onSidebar) || armsReveal(e.clientX, e.clientY, {
        width,
        band,
        overControl: !!t?.closest(PAGE_CONTROL) && !onSidebar,
        overPlayer: !!t?.closest(PLAYER_BAR),
      });
      pointerHere.current = here;
      if (pinnedRef.current) return;
      if (here) p.pointerIn(); else p.pointerOut();
    };
    // the pointer left the window
    const onOut = (e: PointerEvent) => {
      if (e.relatedTarget) return;
      pointerHere.current = false;
      if (!pinnedRef.current) p.pointerOut();
    };
    const onFocusIn = (e: FocusEvent) => {
      if (pinnedRef.current) return;
      if (e.target instanceof Node && el()?.contains(e.target)) { measure(); p.show(); }
    };
    const onFocusOut = (e: FocusEvent) => {
      if (pinnedRef.current || !(e.target instanceof Node) || !el()?.contains(e.target)) return;
      const to = e.relatedTarget;
      if (to instanceof Node && el()?.contains(to)) return;
      // a click inside the sidebar on something that takes no focus, or the pointer still on it
      if (!pointerHere.current) p.hide();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented || pinnedRef.current || !p.shown) return;
      const inside = focusInside();
      p.hide();
      if (inside) away.current();
    };
    globalThis.addEventListener?.('resize', measure, { passive: true });
    doc?.addEventListener('pointermove', onMove, { passive: true });
    doc?.addEventListener('pointerout', onOut, { passive: true });
    doc?.addEventListener('focusin', onFocusIn);
    doc?.addEventListener('focusout', onFocusOut);
    globalThis.addEventListener?.('keydown', onKey);
    return () => {
      p.dispose();
      peek.current = null;
      setShown(false);
      doc?.removeEventListener('pointermove', onMove);
      doc?.removeEventListener('pointerout', onOut);
      doc?.removeEventListener('focusin', onFocusIn);
      doc?.removeEventListener('focusout', onFocusOut);
      globalThis.removeEventListener?.('keydown', onKey);
      globalThis.removeEventListener?.('resize', measure);
      el()?.style.removeProperty('--peek-top');
      el()?.style.removeProperty('--peek-bottom');
    };
    // initialShown is for stories: read once
  }, [enabled, nav]);

  // pinning: the layout takes over; unpinning: stays shown if the pointer or focus is on it
  useEffect(() => {
    pinnedRef.current = pinned;
    const p = peek.current;
    if (!p) return;
    if (pinned) p.hide();
    else if (pointerHere.current || focusInside()) p.show();
  }, [pinned]);

  const hideNow = useCallback(() => {
    const p = peek.current;
    if (!p || pinnedRef.current || !p.shown) return;
    const inside = focusInside();
    p.hide();
    if (inside) away.current();
  }, []);

  return { shown, hideNow };
}
