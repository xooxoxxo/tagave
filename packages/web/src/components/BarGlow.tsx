/**
 * The equalizer glow (Settings › Appearance › Equalizer glow, off by
 * default): an aurora along the foot of the window, in the player bar and,
 * on a desktop, the sidebar's account row beside it, as one (each is a
 * piece of the same curtains, laid out across the window; glowDriver.ts
 * moves them all), and in the phone's mini bar. Behind each piece's content
 * and clipped to it. Three curtains of soft colour in three hues blending
 * into each other (adaptive/aurora.ts), streaked and fading upward, drift
 * sideways at their own slow paces and fold through one another. The music
 * breathes through it: brighter, higher and drifting faster when loud,
 * never jumping. Paused, it dims and settles to a low ember. On iOS, or
 * where Web Audio cannot start, it drifts slowly in CSS; reduced motion
 * holds it still. The bright cores stay along the bottom edge; what rises
 * behind the text is colour at the bar's own lightness, so the text reads.
 */
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type CSSProperties } from 'react';
import { analyserAllowed, playerAnalyser } from '../adaptive/levels';
import { CURTAINS, auroraNow, curtainOf, setSource, subscribe, type AuroraState } from './glowDriver';
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
  /** 'auto' tries the analyser and falls back to calm; stories pin 'calm' or pass their own levels */
  source?: 'auto' | 'calm' | AnalyserNode | ((out: Float32Array) => void);
  /** a fixed level, 0 to 1, held still whatever the motion setting (stories, screenshots: 1 is loud) */
  level?: number | undefined;
}

const isNode = (s: unknown): s is AnalyserNode => typeof AnalyserNode !== 'undefined' && s instanceof AnalyserNode;

/** How a curtain is drawn: its height and brightness (the outer layer), its place and lean (the inner one). */
function paint(outer: HTMLElement | null, inner: HTMLElement | null, i: number, s: AuroraState, width: number) {
  const c = curtainOf(CURTAINS[i]!.reach, s.level);
  if (outer) {
    outer.style.transform = `scaleY(${c.height.toFixed(3)})`;
    outer.style.opacity = c.bright.toFixed(3);
  }
  if (inner) inner.style.transform = `translateX(${(-(s.phase[i] ?? 0) * width).toFixed(1)}px) skewX(${(s.lean[i] ?? 0).toFixed(2)}deg)`;
}

export function BarGlow({ playing, source = 'auto', level }: BarGlowProps) {
  const reduce = useReducedMotion();
  const [node, setNode] = useState<AnalyserNode | null>(isNode(source) ? source : null);
  const ref = useRef<HTMLSpanElement>(null);
  const outers = useRef<Array<HTMLSpanElement | null>>([]);
  const inners = useRef<Array<HTMLSpanElement | null>>([]);
  const [box, setBox] = useState({ left: 0, width: 0 });

  // the analyser, first asked for once something plays (Play was a gesture, so the context may start)
  useEffect(() => {
    if (isNode(source)) { setNode(source); return; }
    if (source !== 'auto' || !playing || node || reduce || !analyserAllowed()) return;
    let live = true;
    void playerAnalyser().then((n) => { if (live) setNode(n); });
    return () => { live = false; };
  }, [source, playing, node, reduce]);

  // where this piece sits in the window: the curtains are laid out across the whole width
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      const r = el.getBoundingClientRect();
      const width = document.documentElement.clientWidth || globalThis.innerWidth || r.width;
      setBox((b) => (b.left === r.left && b.width === width ? b : { left: r.left, width }));
    };
    measure();
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null;
    ro?.observe(el);
    globalThis.addEventListener?.('resize', measure);
    return () => { ro?.disconnect(); globalThis.removeEventListener?.('resize', measure); };
  }, []);

  const feed = typeof source === 'function' ? source : node;
  const live = level === undefined && !!feed && !reduce && source !== 'calm';

  // a still frame (stories) or where the curtains are now (a paused or reduced-motion aurora)
  useLayoutEffect(() => {
    if (live && playing) return;
    const s = level === undefined ? auroraNow() : { ...auroraNow(), level, phase: CURTAINS.map((_, i) => i * 0.31), lean: CURTAINS.map(() => 0) };
    for (let i = 0; i < CURTAINS.length; i++) {
      // only the place: height and brightness are the CSS's (paused, calm, reduced) unless held still
      if (level !== undefined) paint(outers.current[i]!, inners.current[i]!, i, s, box.width);
      else paint(null, inners.current[i]!, i, s, box.width);
    }
  }, [live, playing, level, box.width]);

  useEffect(() => {
    if (!live || !playing || !feed || !box.width) return;
    setSource(feed);
    const os = outers.current.slice(), is = inners.current.slice();
    const off = subscribe((s) => { for (let i = 0; i < CURTAINS.length; i++) paint(os[i]!, is[i]!, i, s, box.width); });
    return () => {
      off();
      // the height and brightness go back to the CSS, which settles them to the ember; the place stays
      for (const o of os) { o?.style.removeProperty('transform'); o?.style.removeProperty('opacity'); }
    };
  }, [live, playing, feed, box.width]);

  // iOS and the like: the CSS drift starts where every piece's does, so the pieces stay one aurora
  const [epoch] = useState(() => Date.now() / 1000);

  return (
    <span
      ref={ref}
      className={styles.glow}
      data-mode={level !== undefined ? 'still' : live ? 'live' : 'calm'}
      data-playing={playing}
      aria-hidden="true"
      data-bar-glow=""
      style={{ '--x0': `${-box.left}px`, '--vw': `${box.width}px` } as CSSProperties}
    >
      {CURTAINS.map((_, i) => (
        <span key={i} ref={(el) => { outers.current[i] = el; }} className={styles.curtain} data-curtain={i + 1}>
          <span ref={(el) => { inners.current[i] = el; }} className={styles.drift} style={{ animationDelay: `${-((epoch % (70 + 23 * i)))}s` }}>
            <span className={styles.veil} />
            <span className={styles.core} />
          </span>
        </span>
      ))}
    </span>
  );
}
