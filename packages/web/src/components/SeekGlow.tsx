/**
 * The equalizer glow (Settings › Appearance › Equalizer glow, off by
 * default): a soft light along the played part of the seek bar, brightest in
 * a halo round the playhead. On desktop and Android it follows the music
 * (adaptive/levels.ts: low band → the halo, mid → the line, high → the halo's
 * brightness), one rAF loop writing opacity and scale on two spans, nothing
 * re-renders. On iOS, or where Web Audio cannot start, it breathes slowly in
 * CSS. Paused, it settles low and still; reduced motion keeps it still.
 * It sits under the track only, never under text.
 */
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { BANDS, analyserAllowed, bandReader, playerAnalyser } from '../adaptive/levels';
import styles from './PlayerBar.module.css';

const reduceQuery = '(prefers-reduced-motion: reduce)';
function subscribeReduce(cb: () => void) {
  const mq = globalThis.matchMedia?.(reduceQuery);
  mq?.addEventListener('change', cb);
  return () => mq?.removeEventListener('change', cb);
}
export function useReducedMotion(): boolean {
  return useSyncExternalStore(subscribeReduce, () => !!globalThis.matchMedia?.(reduceQuery).matches, () => false);
}

export interface SeekGlowProps {
  playing: boolean;
  /** 'auto' tries the analyser and falls back to calm; stories pin 'calm' or pass their own node */
  source?: 'auto' | 'calm' | AnalyserNode;
}

export function SeekGlow({ playing, source = 'auto' }: SeekGlowProps) {
  const reduce = useReducedMotion();
  const [node, setNode] = useState<AnalyserNode | null>(typeof source === 'object' ? source : null);
  const line = useRef<HTMLSpanElement>(null);
  const halo = useRef<HTMLSpanElement>(null);

  // the analyser, first asked for once something plays (Play was a gesture, so the context may start)
  useEffect(() => {
    if (typeof source === 'object') { setNode(source); return; }
    if (source !== 'auto' || !playing || node || reduce || !analyserAllowed()) return;
    let live = true;
    void playerAnalyser().then((n) => { if (live) setNode(n); });
    return () => { live = false; };
  }, [source, playing, node, reduce]);

  const live = !!node && !reduce && source !== 'calm';
  useEffect(() => {
    if (!live || !playing || !node) return;
    const read = bandReader(node);
    const lv = new Float32Array(BANDS);
    let raf = 0;
    const tick = () => {
      read(lv);
      const [low = 0, mid = 0, high = 0] = lv;
      if (halo.current) {
        halo.current.style.opacity = (0.35 + Math.max(low, high * 0.7) * 0.65).toFixed(3);
        halo.current.style.transform = `translate(-50%, -50%) scale(${(0.7 + low * 0.5).toFixed(3)})`;
      }
      if (line.current) line.current.style.opacity = (0.3 + mid * 0.6).toFixed(3);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    const h = halo.current, l = line.current;
    return () => {
      cancelAnimationFrame(raf);
      h?.style.removeProperty('opacity');
      h?.style.removeProperty('transform');
      l?.style.removeProperty('opacity');
    };
  }, [live, playing, node]);

  return (
    <span className={styles.glow} data-mode={live ? 'live' : 'calm'} data-playing={playing} aria-hidden="true">
      <span ref={line} className={styles.glowLine} />
      <span ref={halo} className={styles.glowHalo} />
    </span>
  );
}
