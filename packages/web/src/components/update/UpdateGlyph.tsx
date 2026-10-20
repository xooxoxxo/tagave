/**
 * The update's glyph on a canvas: ripple contours seeded by the target
 * version that grow with the run's progress (easing toward it) and drift
 * outward slowly while `moving`. Reduced motion, a hidden tab or a fixed
 * `phase` (stories) paint still frames only. Decoration: hidden from
 * assistive technology; the run's text says everything.
 */
import { useEffect, useRef } from 'react';
import { fillerDpr } from '../../pages/albumFlow';
import { paintGlyph } from './glyphPaint';

export type GlyphTone = 'live' | 'ok' | 'warn' | 'error';

const INK: Record<GlyphTone, string> = { live: '--dew', ok: '--dew', warn: '--warn', error: '--danger' };

/** Radians a second the ripples drift outward while the run runs. */
const DRIFT = 0.55;
/** Frames a second: calm motion needs few. */
const FPS = 20;

export function UpdateGlyph({ seed, progress, tone = 'live', moving = true, phase, strength = 1, step = 3, className }: {
  seed: string;
  progress: number;
  tone?: GlyphTone;
  moving?: boolean;
  /** a fixed phase: one still frame (stories, screenshots) */
  phase?: number | undefined;
  strength?: number;
  step?: number;
  className?: string | undefined;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const state = useRef({ reach: phase === undefined ? Math.max(0, progress - 0.08) : progress, phase: phase ?? 0, target: progress });
  state.current.target = progress;

  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    const g = cv.getContext('2d');
    if (!g) return;
    const reduce = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    const still = phase !== undefined || reduce;
    const s = state.current;
    if (still) { s.reach = s.target; if (phase !== undefined) s.phase = phase; }
    let raf = 0, last = 0;
    const paint = () => {
      const dpr = fillerDpr(globalThis.devicePixelRatio);
      const w = cv.clientWidth, h = cv.clientHeight;
      if (!w || !h) return;
      if (cv.width !== Math.round(w * dpr)) cv.width = Math.round(w * dpr);
      if (cv.height !== Math.round(h * dpr)) cv.height = Math.round(h * dpr);
      const ink = getComputedStyle(cv).getPropertyValue(INK[tone]).trim() || '#276a82';
      paintGlyph(g, { w, h, dpr, seed, ink, reach: s.reach, phase: s.phase, strength, step });
    };
    const frame = (t: number) => {
      raf = requestAnimationFrame(frame);
      if (t - last < 1000 / FPS) return;
      const dt = last ? Math.min(0.2, (t - last) / 1000) : 0;
      last = t;
      if (document.hidden) return;
      const settled = Math.abs(s.target - s.reach) < 0.002;
      s.reach += (s.target - s.reach) * Math.min(1, dt * 1.6);
      if (moving) s.phase += DRIFT * dt;
      if (!moving && settled) { paint(); cancelAnimationFrame(raf); return; }
      paint();
    };
    paint();
    if (!still) raf = requestAnimationFrame(frame);
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(paint) : null;
    ro?.observe(cv);
    const themeWatch = typeof MutationObserver !== 'undefined' ? new MutationObserver(paint) : null;
    themeWatch?.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => { cancelAnimationFrame(raf); ro?.disconnect(); themeWatch?.disconnect(); };
  }, [seed, tone, moving, phase, strength, step, progress]);

  return <canvas ref={ref} className={className} aria-hidden="true" data-update-glyph="" />;
}
