/**
 * Wires the album page flow (albumFlow.ts) to the scroll pane: measures the
 * page, then on every scroll frame fades the cover, shrinks the names,
 * straightens TRACKLIST's caret and docks the header. Styles are written
 * straight to the elements (no re-render per frame); only the docked state,
 * the title's glide and the pane height are React state.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { HEADER, caretPath, flowState, type FlowGeometry } from './albumFlow';

export interface AlbumFlowRefs {
  root: RefObject<HTMLElement | null>;
  hero: RefObject<HTMLElement | null>;
  cover: RefObject<HTMLElement | null>;
  names: RefObject<HTMLElement | null>;
  nameA: RefObject<HTMLElement | null>;
  nameB: RefObject<HTMLElement | null>;
  tl: RefObject<HTMLElement | null>;
  caret: RefObject<SVGPathElement | null>;
  tracks: RefObject<HTMLElement | null>;
}

/** Phone layout: the album, then TRACKLIST and the tracks right after it. */
const PHONE = '(max-width: 720px)';
const reducedMotion = () => !!globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

export function useAlbumFlow(refs: AlbumFlowRefs, ready: boolean) {
  const [docked, setDocked] = useState(false);
  const [glide, setGlide] = useState({ x: 0, y: 51 });
  /** the scroll pane's height, for the hero's floor */
  const [pane, setPane] = useState({ height: 0, phone: false, tlHeight: 0 });
  const geo = useRef<FlowGeometry | null>(null);
  const scroller = useRef<HTMLElement | null>(null);
  const dockedRef = useRef(false);

  const layout = useCallback(() => {
    const g = geo.current;
    const sc = scroller.current;
    if (!g || !sc) return;
    const s = flowState(sc.scrollTop, g, HEADER);
    if (refs.cover.current) refs.cover.current.style.opacity = String(s.coverOpacity);
    // the title (nameB) on top, the artist (nameA) under it, both shrinking from their top centre
    if (refs.nameB.current) refs.nameB.current.style.transform = `scale(${s.albumScale})`;
    if (refs.nameA.current) refs.nameA.current.style.transform = `translateY(${s.artistShift}px) scale(${s.artistScale})`;
    if (refs.names.current) refs.names.current.style.visibility = s.docked ? 'hidden' : 'visible';
    refs.caret.current?.setAttribute('d', caretPath(s.caretProgress));
    if (s.docked !== dockedRef.current) {
      dockedRef.current = s.docked;
      setDocked(s.docked);
    }
  }, [refs]);

  const measure = useCallback(() => {
    const sc = scroller.current;
    const { hero, cover, names, tl, root } = refs;
    if (!sc || !hero.current || !cover.current || !names.current || !tl.current || !root.current) return;
    const scRect = sc.getBoundingClientRect();
    const st = sc.scrollTop;
    const top = (el: Element) => el.getBoundingClientRect().top - scRect.top + st;
    const b = refs.nameB.current;
    const a = refs.nameA.current;
    geo.current = {
      coverBottom: top(cover.current) + cover.current.offsetHeight,
      namesTop: top(names.current),
      // TRACKLIST follows the hero; measured from the hero, since a stuck label is not where it flows
      tlTop: top(hero.current) + hero.current.offsetHeight,
      // offsetTop/offsetHeight ignore the transforms the scroll writes
      ...(b ? { titleHeight: b.offsetHeight, titleSize: parseFloat(getComputedStyle(b).fontSize) || 0 } : {}),
      ...(a ? { artistTop: a.offsetTop - (b?.offsetTop ?? 0), artistSize: parseFloat(getComputedStyle(a).fontSize) || 0 } : {}),
    };
    // where the lines meet the header, relative to the title's spot in the header: centred
    // lines (a phone) glide straight down; left-aligned ones from their left edge
    const mid = root.current.querySelector<HTMLElement>('[data-album-header] [data-top-key]');
    const first = mid?.querySelector<HTMLElement>('[data-header-title], [data-header-artist]');
    if (mid && first) {
      const midStyle = getComputedStyle(mid);
      const m = mid.getBoundingClientRect();
      const n = names.current.getBoundingClientRect();
      const pad = parseFloat(midStyle.paddingLeft) || 0;
      const x = midStyle.textAlign === 'center'
        ? Math.round((n.left + n.width / 2) - (m.left + m.width / 2))
        : Math.round(n.left - (m.left + pad));
      const y = Math.round(HEADER - first.offsetTop);
      setGlide((cur) => (cur.x === x && cur.y === y ? cur : { x, y }));
    }
    const next = {
      height: sc.clientHeight,
      phone: !!globalThis.matchMedia?.(PHONE).matches,
      tlHeight: tl.current.offsetHeight,
    };
    setPane((cur) => (cur.height === next.height && cur.phone === next.phone && cur.tlHeight === next.tlHeight ? cur : next));
    layout();
  }, [refs, layout]);

  useLayoutEffect(() => {
    if (!ready) return;
    const root = refs.root.current;
    const sc = (root?.closest('main') as HTMLElement | null) ?? document.getElementById('main-content');
    if (!root || !sc) return;
    scroller.current = sc;
    measure();
    let frame = 0;
    const onScroll = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => { frame = 0; layout(); });
    };
    sc.addEventListener('scroll', onScroll, { passive: true });
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => measure()) : null;
    ro?.observe(sc);
    ro?.observe(root);
    window.addEventListener('resize', measure);
    void document.fonts?.ready.then(() => measure());
    return () => {
      sc.removeEventListener('scroll', onScroll);
      ro?.disconnect();
      window.removeEventListener('resize', measure);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [ready, refs, measure, layout]);

  // the hero's floor changes the geometry: measure again once it applies
  useEffect(() => { if (ready) measure(); }, [ready, pane.height, pane.phone, pane.tlHeight, measure]);

  const glideTo = useCallback((top: number) => {
    scroller.current?.scrollTo({ top: Math.max(0, top), behavior: reducedMotion() ? 'auto' : 'smooth' });
  }, []);
  const toTop = useCallback(() => glideTo(0), [glideTo]);
  const toTracklist = useCallback(() => { if (geo.current) glideTo(geo.current.tlTop - HEADER); }, [glideTo]);
  /** bring an element in the page to just under the stuck header and TRACKLIST */
  const toElement = useCallback((el: HTMLElement | null) => {
    const sc = scroller.current;
    if (!sc || !el) return;
    const t = el.getBoundingClientRect().top - sc.getBoundingClientRect().top + sc.scrollTop;
    glideTo(t - HEADER - (refs.tl.current?.offsetHeight ?? 0));
  }, [glideTo, refs]);

  return { docked, glide, pane, toTop, toTracklist, toElement, measure };
}
