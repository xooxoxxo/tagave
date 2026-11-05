/**
 * Synthetic music for the DJ analysis tests (core and the worker's
 * dj.analyze test): a kick on the beat, optional backbeat snare and
 * eighth-note hats, a held chord, noise, silence before and after. Seeded,
 * so every run is the same signal. Not used at run time.
 */

export interface SynthSpec {
  bpm: number;
  /** length of the music, after the intro silence */
  seconds: number;
  sampleRate?: number;
  /** digital silence before the music (the first kick is at its end, plus firstBeatS) */
  introSilenceS?: number;
  outroSilenceS?: number;
  /** the first kick, after the intro silence (a pad may play before it) */
  firstBeatS?: number;
  /** a kick on every beat (default) or only on 1 and 3, with a snare on 2 and 4 */
  pattern?: 'four' | 'backbeat';
  /** eighth-note hi-hats, this loud against the kick (0: none) */
  hats?: number;
  /** a held chord under it all, from the very first sample of the music */
  pad?: number;
  /** white noise floor */
  noise?: number;
  /** how loud the kicks are */
  kick?: number;
  /** a drummer, not a machine: each hit up to this far off the grid, and up to ±30 % louder or softer */
  jitterMs?: number;
  seed?: number;
}

export interface Synth {
  pcm: Float32Array;
  sampleRate: number;
  /** each kick's start, in seconds from the start of the signal */
  beats: number[];
  /** where the music starts and ends */
  soundStartS: number;
  soundEndS: number;
}

function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return ((s >>> 0) / 4294967296) * 2 - 1;
  };
}

export function synthTrack(spec: SynthSpec): Synth {
  const sr = spec.sampleRate ?? 11025;
  const intro = spec.introSilenceS ?? 0;
  const outro = spec.outroSilenceS ?? 0;
  const first = spec.firstBeatS ?? 0;
  const total = Math.round((intro + spec.seconds + outro) * sr);
  const musicStart = Math.round(intro * sr);
  const musicEnd = Math.round((intro + spec.seconds) * sr);
  const out = new Float32Array(total);
  const rand = rng(spec.seed ?? 7);
  const beatS = 60 / spec.bpm;
  const kick = spec.kick ?? 0.8;
  const hats = spec.hats ?? 0;
  const beats: number[] = [];

  const addKick = (at: number, amp: number) => {
    let phase = 0;
    const len = Math.min(Math.round(0.35 * sr), musicEnd - at);
    for (let i = 0; i < len; i++) {
      const t = i / sr;
      const f = 50 + 70 * Math.exp(-t / 0.03);
      phase += (2 * Math.PI * f) / sr;
      const env = Math.exp(-t / 0.12) * Math.min(1, t / 0.001);
      const click = i < sr * 0.002 ? rand() * 0.5 : 0;
      out[at + i]! += amp * (Math.sin(phase) * env + click);
    }
  };
  const addNoiseHit = (at: number, amp: number, decay: number, tone: number) => {
    let prev = 0;
    const len = Math.min(Math.round(decay * 6 * sr), musicEnd - at);
    for (let i = 0; i < len; i++) {
      const t = i / sr;
      const w = rand();
      const hp = w - prev; // brighter
      prev = w;
      const env = Math.exp(-t / decay);
      out[at + i]! += amp * env * (hp * 0.5 + (tone ? 0.5 * Math.sin(2 * Math.PI * tone * t) : 0));
    }
  };

  const jitter = (spec.jitterMs ?? 0) / 1000;
  for (let k = 0; ; k++) {
    const tS = first + k * beatS + (k > 0 ? rand() * jitter : 0);
    const at = musicStart + Math.round(tS * sr);
    const amp = jitter ? 1 + 0.3 * rand() : 1;
    if (at >= musicEnd - Math.round(0.05 * sr)) break;
    const pattern = spec.pattern ?? 'four';
    if (pattern === 'four' || k % 2 === 0) {
      addKick(at, kick * amp);
      beats.push(at / sr);
    } else {
      addNoiseHit(at, kick * 0.7 * amp, 0.07, 190);
      beats.push(at / sr);
    }
    if (hats > 0) {
      const off = at + Math.round((beatS / 2) * sr);
      if (off < musicEnd) addNoiseHit(off, kick * hats, 0.015, 0);
      addNoiseHit(at, kick * hats * 0.6, 0.015, 0);
    }
  }
  if (spec.pad) {
    const freqs = [220, 277.18, 329.63];
    for (let i = musicStart; i < musicEnd; i++) {
      const t = (i - musicStart) / sr;
      let s = 0;
      for (const f of freqs) s += Math.sin(2 * Math.PI * f * t);
      out[i]! += (spec.pad * s) / freqs.length * (0.8 + 0.2 * Math.sin(2 * Math.PI * 0.1 * t));
    }
  }
  if (spec.noise) for (let i = musicStart; i < musicEnd; i++) out[i]! += spec.noise * rand();
  // normalise the music to −1 dBFS peak
  let pk = 0;
  for (let i = 0; i < total; i++) pk = Math.max(pk, Math.abs(out[i]!));
  if (pk > 0) for (let i = 0; i < total; i++) out[i]! *= 0.89 / pk;
  return { pcm: out, sampleRate: sr, beats, soundStartS: musicStart / sr, soundEndS: musicEnd / sr };
}

/** Signed distance from t to the nearest beat of the grid (ms). */
export function gridError(firstBeatMs: number, bpm: number, beatMs: number): number {
  const p = 60000 / bpm;
  const d = (((beatMs - firstBeatMs) % p) + p) % p;
  return d > p / 2 ? d - p : d;
}
