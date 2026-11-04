/**
 * The equalizer glow (Settings › Appearance › Equalizer glow, off by
 * default): a bright line along the player bar's top edge and, rising from
 * it into the page, an equalizer of soft columns of light, one hue, the
 * playing album's accent (glowDriver.ts lays them out and moves them). On a
 * desktop it comes from the bar's right side and falls off toward the left;
 * on a phone it spans the mini bar. It stays within the bar's own column.
 *
 * Only while music plays here: paused, stopped or casting it fades out in
 * 400 ms and its loop stops. Reduced motion, and where the music cannot be
 * read (iOS, or Web Audio would not start), it is still: a gentle, fixed
 * equalizer and a half-lit line while playing, nothing moving.
 */
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { BANDS, analyserAllowed, bandReader, playerAnalyser } from '../adaptive/levels';
import {
  STRENGTH, Y_SCALE, canvasScale, emptySpectrum, heldSpectrum, layoutColumns, paintColumns, stepSpectrum, stillSpectrum,
  type Anchor, type Colours, type Layout, type Spectrum,
} from './glowDriver';
import styles from './BarGlow.module.css';

const reduceQuery = '(prefers-reduced-motion: reduce)';
function subscribeReduce(cb: () => void) {
  const mq = globalThis.matchMedia?.(reduceQuery);
  mq?.addEventListener('change', cb);
  return () => mq?.removeEventListener('change', cb);
}
function useReducedMotion(): boolean {
  return useSyncExternalStore(subscribeReduce, () => !!globalThis.matchMedia?.(reduceQuery).matches, () => false);
}

export interface BarGlowProps {
  playing: boolean;
  /** where the light comes from: the bar's right side (a desktop) or its middle (the phone's mini bar) */
  anchor?: Anchor;
  /** 'auto' reads the player's analyser (else still); 'still' pins the still glow; stories pass their own levels */
  source?: 'auto' | 'still' | AnalyserNode | ((out: Float32Array) => void);
  /** the bands held still, 0 to 1 each, whatever the motion setting (stories, screenshots) */
  levels?: ArrayLike<number> | undefined;
}

const isNode = (s: unknown): s is AnalyserNode => typeof AnalyserNode !== 'undefined' && s instanceof AnalyserNode;
const FPS = 30;
/** the fade out (BarGlow.module.css); the canvas is cleared once it is over */
const FADE_MS = 400;

interface Surface { ctx: CanvasRenderingContext2D; layout: Layout; scale: number }

export function BarGlow({ playing, anchor = 'centre', source = 'auto', levels }: BarGlowProps) {
  const reduce = useReducedMotion();
  const [node, setNode] = useState<AnalyserNode | null>(isNode(source) ? source : null);
  const root = useRef<HTMLSpanElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const line = useRef<HTMLSpanElement>(null);
  const surface = useRef<Surface | null>(null);
  const spectrum = useRef<Spectrum>(emptySpectrum());
  const [size, setSize] = useState(0);

  // the analyser, first asked for once something plays (Play was a gesture, so the context may start)
  useEffect(() => {
    if (isNode(source)) { setNode(source); return; }
    if (source !== 'auto' || !playing || node || reduce || !analyserAllowed()) return;
    let live = true;
    void playerAnalyser().then((n) => { if (live) setNode(n); });
    return () => { live = false; };
  }, [source, playing, node, reduce]);

  const feed = typeof source === 'function' ? source : node;
  const mode: 'held' | 'live' | 'still' = levels ? 'held' : feed && !reduce && source !== 'still' ? 'live' : 'still';

  // the bar's width: the columns, and a canvas of about four px a column (smoothed up, a soft glow)
  useLayoutEffect(() => {
    const el = root.current, cv = canvas.current;
    if (!el || !cv) return;
    const measure = () => {
      const { width, height } = el.getBoundingClientRect();
      const layout = layoutColumns(width, anchor);
      const scale = canvasScale(layout.pitch);
      const w = Math.max(1, Math.ceil(width / scale)), h = Math.max(1, Math.ceil(height / Y_SCALE));
      if (cv.width !== w) cv.width = w;
      if (cv.height !== h) cv.height = h;
      let ctx: CanvasRenderingContext2D | null = null;
      try { ctx = cv.getContext('2d'); } catch { /* no canvas (tests) */ }
      surface.current = ctx ? { ctx, layout, scale } : null;
      setSize((n) => n + 1);
    };
    measure();
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null;
    ro?.observe(el);
    return () => ro?.disconnect();
  }, [anchor]);

  useEffect(() => {
    const el = root.current, cv = canvas.current, ln = line.current;
    const sf = surface.current;
    if (!el || !cv || !ln || !sf) return;
    // the colours: the canvas's and the line's own `color` (BarGlow.module.css), read as rgb
    const read = (): { colours: Colours; dark: boolean } => {
      const body = getComputedStyle(cv).color, core = getComputedStyle(ln).color;
      return { colours: { body, core }, dark: getComputedStyle(el).getPropertyValue('--glow-scheme').trim() !== 'light' };
    };
    const draw = (s: Spectrum, look: ReturnType<typeof read>) => {
      paintColumns(sf.ctx, sf.layout, s, look.colours, STRENGTH[look.dark ? 'dark' : 'light'], sf.scale);
      ln.style.opacity = (0.35 + 0.65 * s.loud).toFixed(3);
    };

    if (!playing && mode !== 'held') {
      // fading out: clear once it is gone, so the next play starts from nothing
      const t = setTimeout(() => {
        sf.ctx.clearRect(0, 0, cv.width, cv.height);
        spectrum.current = emptySpectrum();
      }, FADE_MS + 50);
      return () => clearTimeout(t);
    }

    if (mode !== 'live') {
      // one frame, drawn again only when the colours change (a new cover fades in over 600 ms)
      const s = mode === 'held' ? heldSpectrum(levels!) : stillSpectrum();
      draw(s, read());
      const timers: ReturnType<typeof setTimeout>[] = [];
      const redraw = () => { timers.forEach(clearTimeout); timers.length = 0; for (const ms of [0, 300, 700]) timers.push(setTimeout(() => draw(s, read()), ms)); };
      const mo = typeof MutationObserver !== 'undefined' ? new MutationObserver(redraw) : null;
      mo?.observe(document.documentElement, { attributes: true, attributeFilter: ['style', 'data-theme', 'data-adaptive', 'data-themed'] });
      const mq = globalThis.matchMedia?.('(prefers-color-scheme: dark)');
      mq?.addEventListener('change', redraw);
      return () => { mo?.disconnect(); mq?.removeEventListener('change', redraw); timers.forEach(clearTimeout); };
    }

    // live: one loop, at most 30 frames a second, while music plays
    const readBands = typeof feed === 'function' ? feed : bandReader(feed!);
    const raw = new Float32Array(BANDS);
    let look = read();
    let raf = 0, last = 0, frames = 0;
    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      if (last && now - last < 1000 / FPS - 2) return;
      const dt = last ? Math.min(0.1, (now - last) / 1000) : 1 / FPS;
      last = now;
      // the colours again every half second or so: a new cover's fade
      if (++frames % 15 === 0) look = read();
      readBands(raw);
      draw(stepSpectrum(spectrum.current, raw, dt), look);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [playing, mode, feed, levels, size]);

  return (
    <span ref={root} className={styles.glow} data-on={playing} data-mode={mode} aria-hidden="true" data-bar-glow="" data-anchor={anchor}>
      <canvas ref={canvas} className={styles.columns} />
      <span ref={line} className={styles.line} />
    </span>
  );
}
