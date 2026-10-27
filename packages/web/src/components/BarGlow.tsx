/**
 * The equalizer glow (Settings › Appearance › Equalizer glow, off by
 * default): a neon horizon inside the player bar, behind its content and
 * clipped to it. Seven wide lobes rise from the bar's bottom edge, the lows
 * in the middle, the highs at the ends; loud peaks reach about half the
 * bar's height, quiet music stays a low line. On desktop and Android it
 * follows the music (adaptive/levels.ts), one rAF loop writing transform and
 * opacity on seven spans, nothing re-renders. On iOS, or where Web Audio
 * cannot start, it breathes slowly in CSS; reduced motion holds it still.
 * Paused, it settles to the low line. Its colour is --seek-glow (the cover's
 * --ad-glow, or the theme's), a tone chosen so the bar's text, keys and seek
 * line keep their contrast over it at its peak (adaptive/barGlow.ts).
 */
import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties } from 'react';
import { BANDS, analyserAllowed, bandReader, playerAnalyser } from '../adaptive/levels';
import styles from './BarGlow.module.css';

const reduceQuery = '(prefers-reduced-motion: reduce)';
function subscribeReduce(cb: () => void) {
  const mq = globalThis.matchMedia?.(reduceQuery);
  mq?.addEventListener('change', cb);
  return () => mq?.removeEventListener('change', cb);
}
export function useReducedMotion(): boolean {
  return useSyncExternalStore(subscribeReduce, () => !!globalThis.matchMedia?.(reduceQuery).matches, () => false);
}

export const LOBES = 7;
/** The low line quiet music keeps, and the full height a loud peak reaches (the lobe is half the bar tall). */
const LOW = 0.14;

/**
 * A lobe's level from the three bands: the middle lobe the lows, the next
 * ones the mids, the outer ones the highs, blended between.
 */
export function lobeLevel(j: number, bands: ArrayLike<number>): number {
  const d = Math.abs(j - (LOBES - 1) / 2) / ((LOBES - 1) / 2);
  const [low = 0, mid = 0, high = 0] = Array.from(bands);
  return d < 0.5 ? low + (mid - low) * d * 2 : mid + (high - mid) * (d - 0.5) * 2;
}

/** The lobe's transform and opacity for a level, 0 to 1. */
export function lobeStyle(level: number): { transform: string; opacity: string } {
  const e = Math.min(1, Math.max(0, level));
  return { transform: `scaleY(${(LOW + (1 - LOW) * e).toFixed(3)})`, opacity: (0.55 + 0.45 * e).toFixed(3) };
}

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
  const lobes = useRef<Array<HTMLSpanElement | null>>([]);

  // the analyser, first asked for once something plays (Play was a gesture, so the context may start)
  useEffect(() => {
    if (isNode(source)) { setNode(source); return; }
    if (source !== 'auto' || !playing || node || reduce || !analyserAllowed()) return;
    let live = true;
    void playerAnalyser().then((n) => { if (live) setNode(n); });
    return () => { live = false; };
  }, [source, playing, node, reduce]);

  const nodeReader = useMemo(() => (node ? bandReader(node) : null), [node]);
  const reader = typeof source === 'function' ? source : nodeReader;
  const live = level === undefined && !!reader && !reduce && source !== 'calm';
  const readerRef = useRef(reader);
  readerRef.current = reader;
  useEffect(() => {
    if (!live || !playing) return;
    const lv = new Float32Array(BANDS);
    const held = new Float32Array(LOBES);
    let raf = 0;
    const tick = () => {
      readerRef.current?.(lv);
      for (let j = 0; j < LOBES; j++) {
        const e = lobeLevel(j, lv);
        // up with the beat, slower down: it breathes rather than flickers
        held[j] = e > held[j]! ? e : held[j]! + (e - held[j]!) * 0.08;
        const el = lobes.current[j];
        if (!el) continue;
        const st = lobeStyle(held[j]!);
        el.style.transform = st.transform;
        el.style.opacity = st.opacity;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    const els = [...lobes.current];
    return () => {
      cancelAnimationFrame(raf);
      for (const el of els) { el?.style.removeProperty('transform'); el?.style.removeProperty('opacity'); }
    };
  }, [live, playing]);

  return (
    <span className={styles.glow} data-mode={level !== undefined ? 'still' : live ? 'live' : 'calm'} data-playing={playing} aria-hidden="true" data-bar-glow="">
      {Array.from({ length: LOBES }, (_, j) => (
        <span
          key={j}
          ref={(el) => { lobes.current[j] = el; }}
          className={styles.lobe}
          style={{
            '--x': `${((j + 0.5) / LOBES) * 100}%`,
            '--i': Math.abs(j - (LOBES - 1) / 2),
            ...(level === undefined ? {} : lobeStyle(level * (1 - 0.25 * (Math.abs(j - (LOBES - 1) / 2) / ((LOBES - 1) / 2))))),
          } as CSSProperties}
        />
      ))}
    </span>
  );
}
