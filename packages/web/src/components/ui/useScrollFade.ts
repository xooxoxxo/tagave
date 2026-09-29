import { useLayoutEffect, useState } from 'react';
import { centeredScrollLeft } from '../../utils/scroll';

export type ScrollFade = 'none' | 'start' | 'end' | 'both';

/** Which edges of a horizontal scroller have more content past them. */
export function scrollFadeEdges(scrollLeft: number, scrollWidth: number, clientWidth: number): ScrollFade {
  const max = scrollWidth - clientWidth;
  if (max <= 1) return 'none';
  const start = scrollLeft > 1;
  const end = scrollLeft < max - 1;
  return start && end ? 'both' : start ? 'start' : end ? 'end' : 'none';
}

/**
 * For a strip of tabs or links that scrolls sideways on a phone: sets
 * data-scroll-fade on the element so index.css fades the edge that hides
 * more items (a cut label then reads as "more this way", not as a bug), and
 * scrolls the current item (aria-selected or aria-current) into the middle.
 * Only the strip scrolls; the page never moves. The element must be
 * positioned so offsetLeft is measured from it. Returns a callback ref, so a
 * strip that mounts after the first render (behind a loading state) is
 * picked up too.
 */
export function useScrollFade<T extends HTMLElement>(activeKey?: unknown) {
  const [el, setEl] = useState<T | null>(null);
  useLayoutEffect(() => {
    if (!el) return;
    const update = () => {
      el.dataset.scrollFade = scrollFadeEdges(el.scrollLeft, el.scrollWidth, el.clientWidth);
    };
    const active = el.querySelector<HTMLElement>('[aria-selected="true"], [aria-current="page"]');
    if (active && el.scrollWidth > el.clientWidth) {
      el.scrollLeft = centeredScrollLeft(el.scrollWidth, el.clientWidth, active.offsetLeft, active.offsetWidth);
    }
    update();
    el.addEventListener('scroll', update, { passive: true });
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update);
    observer?.observe(el);
    return () => {
      el.removeEventListener('scroll', update);
      observer?.disconnect();
    };
  }, [el, activeKey]);
  return setEl;
}
