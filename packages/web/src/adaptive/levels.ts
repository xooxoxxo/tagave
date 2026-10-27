/**
 * Levels for the equalizer glow, from the music itself: the player's two
 * <audio> elements routed through one Web Audio AnalyserNode.
 *
 * - The stream is same-origin (/api/v1/player/stream/:id, proxied by the api),
 *   so the analyser reads real samples.
 * - Routing is one-way: createMediaElementSource keeps an element on the
 *   AudioContext for the life of the page. Turning the glow off stops reading
 *   levels; the sound keeps flowing through the context untouched.
 * - Never on iOS or iPadOS: there the context is suspended in the background
 *   and the music would stop (player/engine.ts keeps plain elements for this).
 *   The glow there, and wherever a context cannot start, is the calm one.
 * - An element is routed only once the context is running, so a context the
 *   browser holds suspended can never silence playback.
 */
import { mediaElements } from '../player/engine';

export const BANDS = 3;

let ctx: AudioContext | null = null;
let analyser: AnalyserNode | null = null;
const routed = new WeakSet<HTMLMediaElement>();

/** iPhone, iPod, iPad, and an iPad that reports itself as a Mac. */
export function isAppleMobile(nav: Pick<Navigator, 'userAgent' | 'platform' | 'maxTouchPoints'> | undefined = globalThis.navigator): boolean {
  if (!nav) return false;
  return /iP(hone|ad|od)/.test(nav.userAgent) || (nav.platform === 'MacIntel' && nav.maxTouchPoints > 1);
}

export function analyserAllowed(): boolean {
  return typeof AudioContext !== 'undefined' && !isAppleMobile();
}

/**
 * The analyser on the player's elements, or null (the calm glow): not
 * allowed here, no elements yet, or a context that does not start.
 */
export async function playerAnalyser(): Promise<AnalyserNode | null> {
  if (!analyserAllowed()) return null;
  const els = mediaElements();
  if (!els.length) return null;
  try {
    ctx ??= new AudioContext();
    if (ctx.state !== 'running') await ctx.resume();
    if (ctx.state !== 'running') return null;
    if (!analyser) {
      analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      analyser.smoothingTimeConstant = 0.7;
      analyser.connect(ctx.destination);
    }
    for (const el of els) {
      if (routed.has(el)) continue;
      ctx.createMediaElementSource(el).connect(analyser);
      routed.add(el);
    }
    return analyser;
  } catch {
    return null;
  }
}

/** Band edges in Hz: low (kick, bass), mid (voice, keys), high (cymbals, air). */
const EDGES = [40, 250, 2000, 12000];

/**
 * A reader that fills `out` with BANDS levels from 0 to 1. Each band sits
 * between its running average and its recent peak, so a quiet master and a
 * loud one both pulse and a held bass note does not pin the glow at full;
 * fast attack, slow release, so it swells on a beat and settles.
 */
export function bandReader(node: AnalyserNode): (out: Float32Array) => void {
  const bins = new Uint8Array(node.frequencyBinCount);
  const hzPerBin = node.context.sampleRate / node.fftSize;
  const ranges = EDGES.slice(0, -1).map((lo, i) => [Math.max(1, Math.floor(lo / hzPerBin)), Math.max(2, Math.ceil(EDGES[i + 1]! / hzPerBin))] as const);
  const peaks = new Float32Array(ranges.length).fill(0.2);
  const avgs = new Float32Array(ranges.length);
  return (out) => {
    node.getByteFrequencyData(bins);
    ranges.forEach(([a, b], i) => {
      let sum = 0;
      for (let k = a; k < b && k < bins.length; k++) sum += bins[k]!;
      const raw = sum / Math.max(1, b - a) / 255;
      avgs[i]! += (raw - avgs[i]!) * 0.03;
      peaks[i] = Math.max(raw, peaks[i]! * 0.993, 0.05);
      const floor = avgs[i]! * 0.9;
      const v = Math.min(1, Math.max(0, (raw - floor) / Math.max(0.02, peaks[i]! - floor))) ** 1.5;
      const prev = out[i] ?? 0;
      out[i] = v > prev ? prev + (v - prev) * 0.6 : prev + (v - prev) * 0.12;
    });
  };
}
