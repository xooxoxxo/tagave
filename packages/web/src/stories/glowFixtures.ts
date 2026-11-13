/**
 * The equalizer glow's stand-ins for music (stories): a frame held mid-beat,
 * for screenshots, and a beat that moves, for looking at the motion. Both in
 * the shape the analyser's bands have (adaptive/levels.ts: BANDS from 40 Hz
 * to 14 kHz, 0 to 1 each).
 */
import { BANDS } from '../adaptive/levels';

const bump = (i: number, at: number, width: number) => Math.exp(-(((i - at) / width) ** 2));

/** One beat's bands at a moment `t` seconds in (112 bpm: kick and bass, a snare on 2 and 4, hats on the eighths). */
export function beatAt(t: number, out: Float32Array | number[] = new Array<number>(BANDS).fill(0)): Float32Array | number[] {
  const beat = 60 / 112;
  const inBeat = t % beat, inBar = t % (beat * 4), eighth = t % (beat / 2);
  const kick = Math.exp(-inBeat / 0.11);
  const snareOn = Math.floor(inBar / beat) % 2 === 1;
  const snare = snareOn ? Math.exp(-inBeat / 0.09) : 0;
  const hat = Math.exp(-eighth / 0.04);
  const bassNote = 4 + (Math.floor(t / (beat * 2)) % 4) * 1.5;
  for (let i = 0; i < BANDS; i++) {
    const v =
      0.95 * kick * bump(i, 2, 3)
      + 0.55 * bump(i, bassNote, 2.2) * (0.6 + 0.4 * Math.exp(-inBeat / 0.3))
      + 0.4 * bump(i, 12, 6) * (0.75 + 0.25 * Math.sin(t * 1.7 + i))
      + 0.6 * snare * bump(i, 19, 6)
      + 0.45 * hat * bump(i, 28, 4);
    out[i] = Math.min(1, v);
  }
  return out;
}

/** A frame held just after a kick on the snare's beat: the bass high, the mids and treble alive. */
export const BEAT_LEVELS: number[] = beatAt((60 / 112) * 1.06) as number[];

/** A source for BarGlow that plays the beat in real time. */
export const demoBeat = () => {
  const t0 = performance.now();
  return (out: Float32Array) => { beatAt((performance.now() - t0) / 1000, out); };
};
