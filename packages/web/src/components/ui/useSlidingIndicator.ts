import { useLayoutEffect, useRef, useState } from 'react';

/**
 * The selected pill of a tab strip or segmented control is one shape that
 * flows from the old choice to the new one, like a raindrop running along
 * the track, instead of the bubble jumping between items.
 *
 * The pill is drawn in three parts so it can move with transforms alone (no
 * layout or paint per frame, so a busy main thread cannot make it stutter):
 *
 *   ( left cap )[ middle, stretched with scaleX ]( right cap )
 *
 * The caps are circles as tall as the pill and only ever translate, so the
 * round ends never squash; the middle is a plain band whose horizontal
 * stretch cannot be seen. A change of selection is a FLIP: the parts are set
 * at the new item, then animated (Web Animations, composited) from where they
 * were, on a soft spring-like curve that settles with a slight overshoot.
 *
 * - The first placement, and any re-placement after a resize or a font load,
 *   is instant: only a change of selection animates. A resize that lands
 *   while the pill is still moving retargets it smoothly instead of snapping.
 * - Reduced motion: always instant.
 * - Until the pill is placed (no JS, server markup, tests), the track has no
 *   data-indicator attribute and the active item paints its own bubble.
 */
export const INDICATOR_MS = 300;
/** Soft spring: a quick start, a long settle and a ~4% overshoot. */
export const INDICATOR_EASE = 'cubic-bezier(0.2, 0.9, 0.25, 1.15)';

export interface IndicatorBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Transforms of the three parts of the pill. */
export interface IndicatorParts {
  left: string;
  mid: string;
  right: string;
}

/** Width of the pill's middle band (between the centres of the two caps). */
export function midWidth(box: IndicatorBox): number {
  return Math.max(box.width - box.height, 0);
}

const px = (n: number) => `${Math.round(n * 100) / 100}px`;

/**
 * Where each part sits for the pill at `box`, as transforms only. `midBase`
 * is the middle band's laid-out width (the target's), so the scale is 1 at
 * rest and the band stretches or shrinks in flight.
 */
export function indicatorParts(box: IndicatorBox, midBase: number): IndicatorParts {
  const r = box.height / 2;
  const scale = midBase > 0 ? midWidth(box) / midBase : 1;
  return {
    left: `translate(${px(box.x)}, ${px(box.y)})`,
    mid: `translate(${px(box.x + r)}, ${px(box.y)}) scaleX(${Math.round(scale * 1e6) / 1e6})`,
    right: `translate(${px(box.x + box.width - box.height)}, ${px(box.y)})`,
  };
}

/** The keyframes of one slide: from the pill at `from` to the pill at `to`, transforms only. */
export function indicatorFrames(from: IndicatorBox, to: IndicatorBox): { left: [string, string]; mid: [string, string]; right: [string, string]; midBase: number } {
  const midBase = midWidth(to);
  const a = indicatorParts(from, midBase);
  const b = indicatorParts(to, midBase);
  return { left: [a.left, b.left], mid: [a.mid, b.mid], right: [a.right, b.right], midBase };
}

/** Whether a placement animates: only a change of selection, never the first placement, never with reduced motion. */
export function shouldAnimate(changed: boolean, placedBefore: boolean, reducedMotion: boolean): boolean {
  return changed && placedBefore && !reducedMotion;
}

/** Translation of a computed transform ("none", matrix(...) or matrix3d(...)). */
export function translationOf(transform: string): { x: number; y: number } | null {
  const m = /^matrix\(([^)]+)\)$/.exec(transform);
  if (m) {
    const v = m[1]!.split(',').map(Number);
    return { x: v[4] ?? 0, y: v[5] ?? 0 };
  }
  const m3 = /^matrix3d\(([^)]+)\)$/.exec(transform);
  if (m3) {
    const v = m3[1]!.split(',').map(Number);
    return { x: v[12] ?? 0, y: v[13] ?? 0 };
  }
  return null;
}

function prefersReducedMotion(): boolean {
  try {
    return globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
  } catch {
    return false;
  }
}

const sameBox = (a: IndicatorBox, b: IndicatorBox) => a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;

/**
 * Returns a callback ref for the track (it must be position: relative, so
 * offsetLeft is measured from it) and a ref for the pill element (SlidingPill),
 * whose parts are marked data-part="left" | "mid" | "right".
 */
export function useSlidingIndicator<T extends HTMLElement>(activeKey: unknown) {
  const [track, setTrack] = useState<T | null>(null);
  const indicator = useRef<HTMLSpanElement | null>(null);
  const last = useRef<{ key: unknown; box: IndicatorBox | null; animations: Animation[] }>({ key: undefined, box: null, animations: [] });
  const place = useRef<(animate: boolean) => void>(() => undefined);

  place.current = (animate: boolean) => {
    const el = indicator.current;
    if (!el || !track) return;
    const part = (name: string) => el.querySelector<HTMLElement>(`[data-part="${name}"]`);
    const left = part('left');
    const mid = part('mid');
    const right = part('right');
    if (!left || !mid || !right) return;
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
    const running = last.current.animations.some((a) => a.playState === 'running');
    // a re-measure that lands where the pill already is changes nothing (and
    // must not touch a slide that is still running)
    if (!animate && prev && sameBox(prev, box)) return;

    // where the pill is on screen right now: mid-flight, read it off the caps
    let from = prev;
    if (running && prev) {
      const l = translationOf(getComputedStyle(left).transform);
      const r = translationOf(getComputedStyle(right).transform);
      if (l && r) from = { x: l.x, y: l.y, width: r.x - l.x + prev.height, height: prev.height };
    }
    for (const a of last.current.animations) a.cancel();
    last.current.animations = [];

    // the final state goes in the style (the "last" of FLIP)
    const midBase = midWidth(box);
    const rest = indicatorParts(box, midBase);
    left.style.transform = rest.left;
    mid.style.transform = rest.mid;
    right.style.transform = rest.right;
    el.style.setProperty('--pill-h', `${box.height}px`);
    mid.style.width = `${midBase}px`;
    el.style.opacity = '1';
    last.current.box = box;
    track.dataset.indicator = 'ready';

    const slide = (animate || running) && from !== null && !sameBox(from, box) && typeof left.animate === 'function' && !prefersReducedMotion();
    if (!slide || !from) {
      delete el.dataset.moving;
      return;
    }
    // ...then it plays from where it was (the "invert, play")
    const frames = indicatorFrames(from, box);
    const timing: KeyframeAnimationOptions = { duration: INDICATOR_MS, easing: INDICATOR_EASE };
    el.dataset.moving = 'true';
    const animations = [
      left.animate([{ transform: frames.left[0] }, { transform: frames.left[1] }], timing),
      mid.animate([{ transform: frames.mid[0] }, { transform: frames.mid[1] }], timing),
      right.animate([{ transform: frames.right[0] }, { transform: frames.right[1] }], timing),
    ];
    last.current.animations = animations;
    void animations[0]!.finished.then(() => {
      if (last.current.animations === animations) delete el.dataset.moving;
    }, () => undefined);
  };

  // a change of selection slides
  useLayoutEffect(() => {
    const changed = last.current.key !== activeKey;
    last.current.key = activeKey;
    place.current(shouldAnimate(changed, last.current.box !== null, false));
  }, [track, activeKey]);

  // a resize, a font load or a label change re-places it at once
  useLayoutEffect(() => {
    if (!track || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => place.current(false));
    observer.observe(track);
    for (const child of Array.from(track.children)) observer.observe(child);
    return () => observer.disconnect();
  }, [track]);

  // nothing keeps running after the strip goes away
  useLayoutEffect(() => () => {
    for (const a of last.current.animations) a.cancel();
  }, []);

  return { trackRef: setTrack, indicatorRef: indicator };
}
