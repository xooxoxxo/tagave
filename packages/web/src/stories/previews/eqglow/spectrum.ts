/**
 * A synthetic spectrum for the equalizer-glow previews (rr55, branch-local):
 * 24 bands, low to high, 0 to 1, at a time t (s), so the glow moves without
 * audio and a still at a given t repeats. A 118 bpm kick in the lows, a
 * snare on the off-beat in the mids, a slow swell, and hats flickering in the
 * highs. useSpectrum smooths it like a real analyser (fast attack, slow
 * release) and holds a calm, still spectrum under reduced motion.
 */
import { useEffect, useRef } from 'react';
import { useReducedMotion } from '../../../components/SeekGlow';

export const BANDS = 24;
const BEAT = 60 / 118;

function hash(n: number): number {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}

/** Smooth value noise in 0..1. */
function noise(x: number): number {
  const i = Math.floor(x);
  const f = x - i;
  const u = f * f * (3 - 2 * f);
  return hash(i) * (1 - u) + hash(i + 1) * u;
}

export function spectrumAt(t: number, out = new Float32Array(BANDS)): Float32Array {
  const beat = (t / BEAT) % 1;
  const kick = Math.exp(-beat * 7);
  const snare = Math.exp(-((beat + 0.5) % 1) * 10) * (Math.floor(t / BEAT) % 2 === 0 ? 1 : 0.6);
  const swell = 0.5 + 0.5 * Math.sin(t * 0.21);
  for (let b = 0; b < BANDS; b++) {
    const x = b / (BANDS - 1);
    const low = Math.max(0, 1 - x * 3.2);
    const mid = Math.exp(-((x - 0.45) ** 2) / 0.04);
    const high = Math.max(0, (x - 0.6) / 0.4);
    const body = 0.28 + 0.3 * noise(t * 1.7 + b * 3.1) * (1 - x * 0.5);
    const hats = high * (0.25 + 0.55 * noise(t * 11 + b * 7.3));
    const v = body * (0.75 + 0.25 * swell) + kick * low * 0.75 + snare * mid * 0.45 + hats * 0.6;
    out[b] = Math.min(1, Math.max(0, v * (1 - x * 0.35)));
  }
  return out;
}

/** What a calm, still glow shows (reduced motion): low, even, a little higher in the middle. */
export function calmSpectrum(out = new Float32Array(BANDS)): Float32Array {
  for (let b = 0; b < BANDS; b++) out[b] = 0.3 - 0.12 * (b / (BANDS - 1));
  return out;
}

/**
 * The spectrum each frame, smoothed (attack 0.6, release 0.12 per frame at
 * 60 fps), handed to `paint` without a React render. A fixed `time` (stills)
 * paints once at that time; reduced motion paints the calm spectrum once.
 */
export function useSpectrum(paint: (bands: Float32Array, t: number) => void, time?: number): boolean {
  const reduce = useReducedMotion();
  const ref = useRef(paint);
  ref.current = paint;
  useEffect(() => {
    const smooth = new Float32Array(BANDS);
    const raw = new Float32Array(BANDS);
    if (reduce) { ref.current(calmSpectrum(smooth), 0); return; }
    if (time !== undefined) {
      // let the smoothing settle on the frames before `time`
      for (let k = 90; k >= 0; k--) {
        spectrumAt(time - k / 60, raw);
        for (let b = 0; b < BANDS; b++) smooth[b]! += (raw[b]! - smooth[b]!) * (raw[b]! > smooth[b]! ? 0.6 : 0.12);
      }
      ref.current(smooth, time);
      return;
    }
    let frame = 0;
    let last = 0;
    const start = performance.now();
    const loop = (now: number) => {
      const dt = last ? Math.min(0.1, (now - last) / 1000) : 1 / 60;
      last = now;
      const k = dt * 60;
      spectrumAt((now - start) / 1000, raw);
      for (let b = 0; b < BANDS; b++) {
        const up = raw[b]! > smooth[b]!;
        smooth[b]! += (raw[b]! - smooth[b]!) * Math.min(1, (up ? 0.6 : 0.12) * k);
      }
      ref.current(smooth, (now - start) / 1000);
      frame = requestAnimationFrame(loop);
    };
    frame = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(frame);
  }, [reduce, time]);
  return reduce;
}
