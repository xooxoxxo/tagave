import { useLayoutEffect, useRef, useState } from 'react';

/**
 * The selected pill of a tab strip or segmented control is one element that
 * slides (and resizes) from the old choice to the new one, instead of the
 * bubble jumping between items. The track marks its current item with
 * data-active="true"; this hook measures it and moves the indicator there.
 *
 * - The first placement, and any re-placement after a resize or a font load,
 *   is instant: only a change of selection animates.
 * - Reduced motion: always instant.
 * - Until the indicator is placed (no JS, server markup, tests), the track has
 *   no data-indicator attribute and the active item paints its own bubble.
 */
export const INDICATOR_MS = 250;
export const INDICATOR_EASE = 'cubic-bezier(0.2, 0.8, 0.2, 1)';

export interface IndicatorBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The CSS transition for one placement: none for the first, a resize or reduced motion. */
export function indicatorTransition(animate: boolean, reducedMotion: boolean): string {
  if (!animate || reducedMotion) return 'none';
  return ['transform', 'width', 'height'].map((p) => `${p} ${INDICATOR_MS}ms ${INDICATOR_EASE}`).join(', ');
}

/** Inline style for the indicator at a box. */
export function indicatorStyle(box: IndicatorBox, transition: string): { transform: string; width: string; height: string; transition: string } {
  return {
    transform: `translate(${box.x}px, ${box.y}px)`,
    width: `${box.width}px`,
    height: `${box.height}px`,
    transition,
  };
}

function prefersReducedMotion(): boolean {
  try {
    return globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
  } catch {
    return false;
  }
}

/**
 * Returns a callback ref for the track (it must be position: relative, so
 * offsetLeft is measured from it) and a ref for the indicator element.
 */
export function useSlidingIndicator<T extends HTMLElement>(activeKey: unknown) {
  const [track, setTrack] = useState<T | null>(null);
  const indicator = useRef<HTMLSpanElement | null>(null);
  const last = useRef<{ key: unknown; box: IndicatorBox | null }>({ key: undefined, box: null });
  const place = useRef<(animate: boolean) => void>(() => undefined);

  place.current = (animate: boolean) => {
    const el = indicator.current;
    if (!el || !track) return;
    const active = track.querySelector<HTMLElement>('[data-active="true"]');
    if (!active) {
      el.style.opacity = '0';
      delete track.dataset.indicator;
      last.current.box = null;
      return;
    }
    const box = { x: active.offsetLeft, y: active.offsetTop, width: active.offsetWidth, height: active.offsetHeight };
    if (box.width === 0) return; // not laid out yet (a hidden panel); the resize observer comes back
    const prev = last.current.box;
    // a re-measure that lands where the pill already is changes nothing (and
    // must not touch a slide that is still running)
    if (!animate && prev && prev.x === box.x && prev.y === box.y && prev.width === box.width && prev.height === box.height) return;
    Object.assign(el.style, indicatorStyle(box, indicatorTransition(animate && prev !== null, prefersReducedMotion())));
    el.style.opacity = '1';
    last.current.box = box;
    track.dataset.indicator = 'ready';
  };

  // a change of selection slides
  useLayoutEffect(() => {
    const changed = last.current.key !== activeKey;
    last.current.key = activeKey;
    place.current(changed);
  }, [track, activeKey]);

  // a resize, a font load or a label change re-places it at once
  useLayoutEffect(() => {
    if (!track || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => place.current(false));
    observer.observe(track);
    for (const child of Array.from(track.children)) observer.observe(child);
    return () => observer.disconnect();
  }, [track]);

  return { trackRef: setTrack, indicatorRef: indicator };
}
