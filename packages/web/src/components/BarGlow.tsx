/**
 * The equalizer glow (Settings › Appearance › Equalizer glow, off by
 * default): a row of soft columns rising from the bottom edge of the window's
 * foot, the player bar and, on a desktop, the sidebar's account row beside
 * it, edge to edge (each is a piece of one glow: the columns sit on one grid
 * across the window, glowDriver.ts drives them all). Behind each piece's
 * content and clipped to it. Fullest in the middle, short and faint towards
 * both edges; a loud peak reaches half the bar, quiet music a low line; a
 * paused track settles to it. On desktop and Android it follows the music
 * (adaptive/levels.ts, compressed and smoothed), one rAF loop writing a
 * transform per column, nothing re-renders. On iOS, or where Web Audio
 * cannot start, it breathes slowly in CSS; reduced motion holds it still. Its
 * colour is --seek-glow (the cover's --ad-glow, or the theme's), apart from
 * the bar but kept off its text (adaptive/barGlow.ts).
 */
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type CSSProperties } from 'react';
import { analyserAllowed, playerAnalyser } from '../adaptive/levels';
import { SPAN, envelope, setSource, subscribe } from './glowDriver';
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

/** The columns' grid across the window (px): one every PITCH, COLUMN wide. */
export const PITCH = 14;
export const COLUMN = 10;
/** The low line quiet music keeps, as a share of the column's full height. */
const LOW = 0.14;

interface Column { left: number; env: number; k: number }

/** The columns of a piece of the strip from `left` to `right` (px in the window) in a window `width` wide. */
export function columnsOf(left: number, right: number, width: number): Column[] {
  const out: Column[] = [];
  if (width <= 0 || right <= left) return out;
  for (let i = Math.floor(left / PITCH); i * PITCH < right; i++) {
    const centre = i * PITCH + PITCH / 2;
    if (centre + COLUMN / 2 <= left || centre - COLUMN / 2 >= right) continue;
    const x = centre / width;
    out.push({ left: centre - COLUMN / 2 - left, env: envelope(x), k: Math.round(Math.min(1, Math.max(0, x)) * (SPAN - 1)) });
  }
  return out;
}

/** A column's scale for a level, 0 to 1, under its envelope. */
export const columnScale = (env: number, level: number) => env * Math.max(LOW, Math.min(1, level));

export interface BarGlowProps {
  playing: boolean;
  /** 'auto' tries the analyser and falls back to calm; stories pin 'calm' or pass their own levels */
  source?: 'auto' | 'calm' | AnalyserNode | ((out: Float32Array) => void);
  /** a fixed level, 0 to 1, held still whatever the motion setting (stories, screenshots: 1 is a loud peak) */
  level?: number | undefined;
}

const isNode = (s: unknown): s is AnalyserNode => typeof AnalyserNode !== 'undefined' && s instanceof AnalyserNode;

export function BarGlow({ playing, source = 'auto', level }: BarGlowProps) {
  const reduce = useReducedMotion();
  const [node, setNode] = useState<AnalyserNode | null>(isNode(source) ? source : null);
  const ref = useRef<HTMLSpanElement>(null);
  const spans = useRef<Array<HTMLSpanElement | null>>([]);
  const [columns, setColumns] = useState<Column[]>([]);

  // the analyser, first asked for once something plays (Play was a gesture, so the context may start)
  useEffect(() => {
    if (isNode(source)) { setNode(source); return; }
    if (source !== 'auto' || !playing || node || reduce || !analyserAllowed()) return;
    let live = true;
    void playerAnalyser().then((n) => { if (live) setNode(n); });
    return () => { live = false; };
  }, [source, playing, node, reduce]);

  // the columns this piece holds, on the window's grid
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      const r = el.getBoundingClientRect();
      const next = columnsOf(r.left, r.right, document.documentElement.clientWidth || globalThis.innerWidth);
      setColumns((prev) => (prev.length === next.length && prev.every((c, i) => c.left === next[i]!.left && c.env === next[i]!.env) ? prev : next));
    };
    measure();
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null;
    ro?.observe(el);
    globalThis.addEventListener?.('resize', measure);
    return () => { ro?.disconnect(); globalThis.removeEventListener?.('resize', measure); };
  }, []);

  const feed = typeof source === 'function' ? source : node;
  const live = level === undefined && !!feed && !reduce && source !== 'calm';
  useEffect(() => {
    if (!live || !playing || !feed) return;
    setSource(feed);
    const cols = columns;
    const els = spans.current.slice(0, cols.length);
    const shown = new Float32Array(cols.length).fill(-1);
    const off = subscribe((levels) => {
      for (let j = 0; j < cols.length; j++) {
        const el = els[j];
        const v = columnScale(cols[j]!.env, levels[cols[j]!.k]!);
        // a column that has not moved visibly keeps its style: fewer writes, less style work
        if (!el || Math.abs(v - shown[j]!) < 0.006) continue;
        shown[j] = v;
        el.style.transform = `scaleY(${v.toFixed(3)})`;
      }
    });
    return () => {
      off();
      for (const el of els) el?.style.removeProperty('transform');
    };
  }, [live, playing, feed, columns]);

  return (
    <span ref={ref} className={styles.glow} data-mode={level !== undefined ? 'still' : live ? 'live' : 'calm'} data-playing={playing} aria-hidden="true" data-bar-glow="">
      {columns.map((c, j) => (
        <span
          key={`${c.left}-${j}`}
          ref={(el) => { spans.current[j] = el; }}
          className={styles.column}
          style={{
            left: `${c.left}px`,
            opacity: (0.35 + 0.65 * c.env).toFixed(3),
            '--env': c.env.toFixed(3),
            '--i': c.k % 16,
            ...(level === undefined ? {} : { transform: `scaleY(${columnScale(c.env, level).toFixed(3)})` }),
          } as CSSProperties}
        />
      ))}
    </span>
  );
}
