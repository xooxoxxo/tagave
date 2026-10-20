/**
 * The update's glyph on a canvas: lava-lamp contours seeded by the target
 * version (glyphPaint.ts). While `moving` the blobs drift, swell, merge and
 * part, slowly (tens of seconds a loop), at most 30 frames a second, and
 * only while the tab is visible; a finished run stops where it is and the
 * size settles on its progress. Reduced motion or a fixed `time` (stories)
 * paint one still frame. Painted in a worker where the browser can hand the
 * canvas over (as the short albums' filler is), else on the page.
 * Decoration: hidden from assistive technology and in forced colours.
 */
import { useEffect, useRef } from 'react';
import { fillerDpr } from '../../pages/albumFlow';
import { GlyphPainter, seedTime, type GlyphParams } from './glyphPaint';
import type { GlyphMessage } from './glyphWorker';

export type GlyphTone = 'live' | 'ok' | 'warn' | 'error';

const INK: Record<GlyphTone, string> = { live: '--dew', ok: '--dew', warn: '--warn', error: '--danger' };

interface Painter {
  send(p: GlyphParams): void;
  costs(): Promise<number[]>;
  end(): void;
}

function painterFor(cv: HTMLCanvasElement): Painter {
  if (typeof Worker !== 'undefined' && typeof cv.transferControlToOffscreen === 'function') {
    try {
      const worker = new Worker(new URL('./glyphWorker.ts', import.meta.url), { type: 'module' });
      const offscreen = cv.transferControlToOffscreen();
      worker.postMessage({ canvas: offscreen } satisfies GlyphMessage, [offscreen]);
      return {
        send: (params) => worker.postMessage({ params } satisfies GlyphMessage),
        costs: () => new Promise((ok) => {
          worker.addEventListener('message', (e: MessageEvent<{ costs: number[] }>) => ok(e.data.costs), { once: true });
          worker.postMessage({ stats: true } satisfies GlyphMessage);
        }),
        end: () => worker.terminate(),
      };
    } catch {
      /* fall through: paint on the page */
    }
  }
  const local = new GlyphPainter(cv, true);
  return { send: (p) => local.update(p), costs: () => Promise.resolve([...local.costs]), end: () => local.stop() };
}

/** A canvas's painter: a canvas can be handed to a worker only once, so it stays with it. */
const painters = new WeakMap<HTMLCanvasElement, Painter>();

/** The recent paint times (ms) of a glyph canvas: what the lamp costs. */
export function glyphCosts(cv: HTMLCanvasElement): Promise<number[]> {
  return painters.get(cv)?.costs() ?? Promise.resolve([]);
}

export function UpdateGlyph({ seed, progress, tone = 'live', moving = true, time, strength = 1, step = 3, className }: {
  seed: string;
  progress: number;
  tone?: GlyphTone;
  moving?: boolean;
  /** a fixed lamp clock (s): one still frame (stories, screenshots) */
  time?: number | undefined;
  strength?: number;
  step?: number;
  className?: string | undefined;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const live = useRef({ seed, progress, tone, moving, time, strength, step });
  live.current = { seed, progress, tone, moving, time, strength, step };
  const sendRef = useRef<() => void>(() => undefined);

  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    let painter = painters.get(cv);
    if (!painter) painters.set(cv, (painter = painterFor(cv)));
    const motion = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)');
    const send = () => {
      const p = live.current;
      const css = getComputedStyle(cv);
      const boost = Number(css.getPropertyValue('--glyph-boost').trim()) || 1;
      const still = p.time !== undefined || !!motion?.matches;
      painter!.send({
        w: cv.clientWidth,
        h: cv.clientHeight,
        dpr: fillerDpr(globalThis.devicePixelRatio),
        seed: p.seed,
        ink: css.getPropertyValue(INK[p.tone]).trim() || '#276a82',
        strength: p.strength * boost,
        step: p.step,
        progress: p.progress,
        moving: p.moving && !still && document.visibilityState !== 'hidden',
        time: p.time ?? (still ? seedTime(p.seed) : null),
      });
    };
    sendRef.current = send;
    send();
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(send) : null;
    ro?.observe(cv);
    const themeWatch = typeof MutationObserver !== 'undefined' ? new MutationObserver(send) : null;
    themeWatch?.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    const scheme = globalThis.matchMedia?.('(prefers-color-scheme: dark)');
    scheme?.addEventListener('change', send);
    motion?.addEventListener('change', send);
    document.addEventListener('visibilitychange', send);
    return () => {
      ro?.disconnect();
      themeWatch?.disconnect();
      scheme?.removeEventListener('change', send);
      motion?.removeEventListener('change', send);
      document.removeEventListener('visibilitychange', send);
      // the canvas leaving the page ends its painter; a re-run (StrictMode) keeps it
      setTimeout(() => {
        if (!cv.isConnected && painters.get(cv) === painter) {
          painter!.end();
          painters.delete(cv);
        }
      }, 0);
    };
  }, []);

  useEffect(() => { sendRef.current(); }, [seed, progress, tone, moving, time, strength, step]);

  return <canvas ref={ref} className={className} aria-hidden="true" data-update-glyph="" />;
}
