import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react';

/**
 * The title a detail page lends the app bar. The page marks its big heading
 * with the ref this hook returns; once that heading scrolls under the bar,
 * the bar fades the title in (Spotify, Qobuz), and out again on the way back.
 */
interface BarTitle {
  title: string | null;
  shown: boolean;
}

let state: BarTitle = { title: null, shown: false };
const listeners = new Set<() => void>();
function set(next: BarTitle) {
  if (next.title === state.title && next.shown === state.shown) return;
  state = next;
  listeners.forEach((l) => l());
}
function subscribe(l: () => void) {
  listeners.add(l);
  return () => { listeners.delete(l); };
}
const snapshot = () => state;
const server = (): BarTitle => ({ title: null, shown: false });

export function useAppBarTitle(): BarTitle {
  return useSyncExternalStore(subscribe, snapshot, server);
}

/** Height the sticky bar covers at the top of the scroll area, per layout. */
function barOffset(): number {
  const phone = globalThis.matchMedia?.('(max-width: 720px)').matches;
  return phone ? 0 : 56;
}

export function useBarTitle(title: string | null) {
  const observer = useRef<IntersectionObserver | null>(null);
  const titleRef = useRef(title);
  titleRef.current = title;

  useEffect(() => {
    set({ title, shown: state.title === title ? state.shown : false });
  }, [title]);
  useEffect(() => () => {
    observer.current?.disconnect();
    set({ title: null, shown: false });
  }, []);

  return useCallback((el: HTMLElement | null) => {
    observer.current?.disconnect();
    observer.current = null;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    const root = document.getElementById('main-content');
    const offset = barOffset();
    observer.current = new IntersectionObserver(
      ([entry]) => {
        if (!entry) return;
        const rootTop = entry.rootBounds?.top ?? 0;
        // gone above the bar, not below the fold
        const above = !entry.isIntersecting && entry.boundingClientRect.bottom <= rootTop + offset + 1;
        set({ title: titleRef.current, shown: above });
      },
      { root, rootMargin: `-${offset}px 0px 0px 0px`, threshold: 0 },
    );
    observer.current.observe(el);
  }, []);
}
