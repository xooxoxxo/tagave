/**
 * The artist page's scrolling, without a scroll handler: the header docks
 * when the name passes under it, and the section navigation follows the
 * section being read (scroll-spy). Both are IntersectionObservers on the
 * scroll pane, so scrolling costs no main-thread work beyond the browser's
 * own intersection checks; React state changes only when the docked state or
 * the current section actually changes. (A freeze in 0.7.4 came from work on
 * every scroll and resize; none is done here.)
 */
import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';

/** the docked header's height (AlbumFlowHeader) */
export const HEADER = 64;
/** single column (≤900px): the section row sticks under the header */
export const ONE_COLUMN = '(max-width: 900px)';
const SECTION_ROW = 52;

const reducedMotion = () => !!globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
const oneColumn = () => !!globalThis.matchMedia?.(ONE_COLUMN).matches;

/** The scroll pane the page lives in (the app frame's main). */
function scrollerOf(el: HTMLElement | null): HTMLElement | null {
  return (el?.closest('main') as HTMLElement | null) ?? document.getElementById('main-content');
}

/** Where a section's top comes to rest: under the header, and under the section row on one column. */
const restOffset = () => HEADER + (oneColumn() ? SECTION_ROW : 0) + 20;

export interface ArtistFlow {
  docked: boolean;
  active: string | null;
  /** smooth-scroll to a section (instant with reduced motion) and mark it current */
  goTo: (id: string) => void;
  toTop: () => void;
}

/**
 * @param root    the page root (inside the scroll pane)
 * @param name    the artist's name heading: the header docks once it is under the header
 * @param ids     the section ids in page order (empty: no section tracking)
 * @param end     an element after the last section: in view, the last section is current
 */
export function useArtistFlow(
  root: RefObject<HTMLElement | null>,
  name: RefObject<HTMLElement | null>,
  ids: string[],
  end: RefObject<HTMLElement | null>,
  ready: boolean,
): ArtistFlow {
  const [docked, setDocked] = useState(false);
  const [active, setActive] = useState<string | null>(ids[0] ?? null);
  /** a click's target: the spy holds still until the smooth scroll reaches it */
  const pending = useRef<{ id: string; until: number } | null>(null);
  const key = ids.join('|');

  // dock: the name heading leaves the band below the header
  useEffect(() => {
    if (!ready) return;
    const el = name.current;
    const sc = scrollerOf(root.current);
    if (!el || !sc || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver(([entry]) => {
      if (!entry) return;
      // rootBounds is the pane less the header (the margin): above it is under the header
      const bandTop = entry.rootBounds?.top ?? HEADER;
      setDocked(!entry.isIntersecting && entry.boundingClientRect.bottom <= bandTop + 1);
    }, { root: sc, rootMargin: `-${HEADER}px 0px 0px 0px`, threshold: 0 });
    io.observe(el);
    return () => io.disconnect();
  }, [ready, root, name]);

  // scroll-spy: the current section is the first one crossing the reading
  // band (from under the header to 40% down the pane)
  useEffect(() => {
    setActive((cur) => (cur && ids.includes(cur) ? cur : ids[0] ?? null));
    if (!ready || ids.length < 2) return;
    const sc = scrollerOf(root.current);
    if (!sc || typeof IntersectionObserver === 'undefined') return;
    const sections = ids.map((id) => document.getElementById(id)).filter((el): el is HTMLElement => !!el);
    const inBand = new Set<string>();
    let atEnd = false;
    const pick = () => {
      const p = pending.current;
      if (p) {
        if ((inBand.has(p.id) || (atEnd && p.id === ids[ids.length - 1])) || performance.now() > p.until) pending.current = null;
        else return;
      }
      const next = atEnd ? ids[ids.length - 1]! : ids.find((id) => inBand.has(id));
      if (next) setActive((cur) => (cur === next ? cur : next));
    };
    let band: IntersectionObserver | null = null;
    let tail: IntersectionObserver | null = null;
    const observe = () => {
      band?.disconnect();
      inBand.clear();
      band = new IntersectionObserver((entries) => {
        for (const e of entries) {
          if (e.isIntersecting) inBand.add(e.target.id);
          else inBand.delete(e.target.id);
        }
        pick();
      }, { root: sc, rootMargin: `-${restOffset() - 4}px 0px -60% 0px`, threshold: 0 });
      sections.forEach((s) => band!.observe(s));
    };
    observe();
    // the page's end in view: the last section, however short, is current
    if (end.current) {
      tail = new IntersectionObserver(([e]) => { atEnd = !!e?.isIntersecting; pick(); }, { root: sc, threshold: 0 });
      tail.observe(end.current);
    }
    // the band's top moves when the layout switches to one column
    const mq = globalThis.matchMedia?.(ONE_COLUMN);
    mq?.addEventListener?.('change', observe);
    return () => {
      band?.disconnect();
      tail?.disconnect();
      mq?.removeEventListener?.('change', observe);
    };
  }, [ready, key, root, end]); // eslint-disable-line react-hooks/exhaustive-deps

  const goTo = useCallback((id: string) => {
    const el = document.getElementById(id);
    const sc = scrollerOf(root.current);
    if (!el || !sc) return;
    const top = el.getBoundingClientRect().top - sc.getBoundingClientRect().top + sc.scrollTop - restOffset();
    const smooth = !reducedMotion();
    pending.current = { id, until: performance.now() + (smooth ? 1500 : 0) };
    setActive(id);
    sc.scrollTo({ top: Math.max(0, top), behavior: smooth ? 'smooth' : 'auto' });
    // the heading takes focus (keyboard and screen readers land in the section)
    const heading = el.querySelector<HTMLElement>('h2');
    heading?.focus({ preventScroll: true });
  }, [root]);

  const toTop = useCallback(() => {
    scrollerOf(root.current)?.scrollTo({ top: 0, behavior: reducedMotion() ? 'auto' : 'smooth' });
  }, [root]);

  return { docked, active, goTo, toTop };
}
