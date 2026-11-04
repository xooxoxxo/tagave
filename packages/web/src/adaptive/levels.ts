/**
 * Levels for the equalizer glow, from the music itself: the player's two
 * <audio> elements read by one Web Audio AnalyserNode.
 *
 * - The stream is same-origin (/api/v1/player/stream/:id, proxied by the api),
 *   so the analyser reads real samples.
 * - Where the browser can copy an element's sound (captureStream: Chrome,
 *   Edge, Chrome on Android), the analyser reads the copy and the music never
 *   passes through Web Audio. A context the browser suspends (the phone
 *   locked, a call, a Bluetooth switch in a car) then only stills the glow;
 *   it can never silence the music. This is the only way it runs on a phone.
 * - Elsewhere on a desktop (Firefox, Safari), the elements are routed through
 *   the context (createMediaElementSource, one-way for the life of the page),
 *   and the context is resumed whenever it stops while music plays.
 * - Never on iOS or iPadOS, nor on another phone without captureStream: the
 *   glow there, and wherever a context cannot start, is the calm one.
 * - Elements join only once the context is running.
 */
import { mediaElements } from '../player/engine';
import { isAppleMobile } from '../player/platform';

/** The equalizer glow's bands: log-spaced from LOW_HZ to HIGH_HZ. */
export const BANDS = 32;
export const LOW_HZ = 40;
export const HIGH_HZ = 14000;

let ctx: AudioContext | null = null;
let analyser: AnalyserNode | null = null;
const joined = new WeakSet<HTMLMediaElement>();
/** some element's sound runs through the context (the analyser then feeds the speakers) */
let routing = false;

type Capturable = HTMLMediaElement & { captureStream?: () => MediaStream };

/** The element's sound can be copied without taking it off the speakers. */
export function canCapture(el: HTMLMediaElement | undefined = globalThis.HTMLMediaElement?.prototype as HTMLMediaElement | undefined): boolean {
  return typeof (el as Capturable | undefined)?.captureStream === 'function';
}

/** A phone or tablet: Android's "Mobi"/"Android", or iOS. */
export function isMobile(nav: Pick<Navigator, 'userAgent' | 'platform' | 'maxTouchPoints'> | undefined = globalThis.navigator): boolean {
  if (!nav) return false;
  return isAppleMobile(nav) || /Android|Mobi/i.test(nav.userAgent);
}

export function analyserAllowed(): boolean {
  if (typeof AudioContext === 'undefined' || isAppleMobile()) return false;
  return canCapture() || !isMobile();
}

/** The analyser reads a copy of the element's sound; the element plays on as before. */
function captureInto(el: HTMLMediaElement, context: AudioContext, node: AnalyserNode) {
  const stream = (el as Capturable).captureStream!();
  const sources = new Map<string, MediaStreamAudioSourceNode>();
  // a new src gives the stream a new track; the old one is removed
  const add = (track: MediaStreamTrack) => {
    if (track.kind !== 'audio' || sources.has(track.id)) return;
    const source = context.createMediaStreamSource(new MediaStream([track]));
    source.connect(node);
    sources.set(track.id, source);
  };
  const drop = (track: MediaStreamTrack) => {
    sources.get(track.id)?.disconnect();
    sources.delete(track.id);
  };
  stream.getAudioTracks().forEach(add);
  stream.addEventListener('addtrack', (e) => add(e.track));
  stream.addEventListener('removetrack', (e) => drop(e.track));
}

/** The elements' sound runs through the context: it must never stay stopped while they play. */
function routeInto(el: HTMLMediaElement, context: AudioContext, node: AnalyserNode) {
  const wake = () => { if (context.state !== 'running') void context.resume().catch(() => undefined); };
  if (!routing) {
    routing = true;
    node.connect(context.destination);
    context.addEventListener('statechange', () => { if (mediaElements().some((m) => !m.paused)) wake(); });
  }
  context.createMediaElementSource(el).connect(node);
  el.addEventListener('play', wake);
}

/**
 * The analyser on the player's elements, or null (the still glow): not
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
      // 4096 points: about 12 Hz a bin, so the lowest bands have bins of their own
      analyser.fftSize = 4096;
      // the glow keeps its own attack and release (components/glowDriver.ts)
      analyser.smoothingTimeConstant = 0;
    }
    for (const el of els) {
      if (joined.has(el)) continue;
      if (canCapture(el)) captureInto(el, ctx, analyser);
      else routeInto(el, ctx, analyser);
      joined.add(el);
    }
    return analyser;
  } catch {
    return null;
  }
}

/** The BANDS + 1 edges (Hz), log-spaced: every band the same share of an octave. */
export function bandEdges(bands = BANDS, low = LOW_HZ, high = HIGH_HZ): number[] {
  return Array.from({ length: bands + 1 }, (_, i) => low * (high / low) ** (i / bands));
}

/**
 * Each band's bins [from, to): at least one each, in order, so the lowest
 * bands (narrower than a bin) take the next bins up rather than share one.
 */
export function binRanges(edges: number[], hzPerBin: number, bins: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let next = 1;
  for (let i = 0; i < edges.length - 1; i++) {
    const from = Math.min(bins - 1, Math.max(next, Math.floor(edges[i]! / hzPerBin)));
    const to = Math.min(bins, Math.max(from + 1, Math.ceil(edges[i + 1]! / hzPerBin)));
    out.push([from, to]);
    next = to;
  }
  return out;
}

/** dB an octave added going up: music thins out toward the treble, the glow should not. */
const TILT = 3;
/** The range shown (dB) under the loudest recent moment. */
const RANGE = 42;
/** How fast the loudest recent moment lets go (dB a read, about 7 dB a second at 30 reads). */
const LET_GO = 0.24;

type FloatSource = Pick<AnalyserNode, 'frequencyBinCount' | 'fftSize' | 'getFloatFrequencyData'> & { context: { sampleRate: number } };

/**
 * A reader that fills `out` with BANDS levels from 0 to 1: each band's
 * loudest bin, tilted up toward the treble, within RANGE dB of the loudest
 * recent moment across all bands, so a quiet master and a loud one both
 * fill the glow and the bands keep their shape against each other. Raw:
 * the attack and release are the glow's (components/glowDriver.ts).
 */
export function bandReader(node: FloatSource): (out: Float32Array) => void {
  const db = new Float32Array(node.frequencyBinCount);
  const hzPerBin = node.context.sampleRate / node.fftSize;
  const edges = bandEdges();
  const ranges = binRanges(edges, hzPerBin, node.frequencyBinCount);
  const tilt = ranges.map((_, i) => TILT * Math.log2(Math.sqrt(edges[i]! * edges[i + 1]!) / LOW_HZ));
  const band = new Float32Array(ranges.length);
  let top = -60;
  return (out) => {
    node.getFloatFrequencyData(db);
    let loudest = -Infinity;
    ranges.forEach(([a, b], i) => {
      let m = -Infinity;
      for (let k = a; k < b; k++) if (db[k]! > m) m = db[k]!;
      band[i] = Number.isFinite(m) ? m + tilt[i]! : -200;
      if (band[i]! > loudest) loudest = band[i]!;
    });
    top = Math.max(loudest, top - LET_GO, -60);
    for (let i = 0; i < band.length; i++) out[i] = Math.min(1, Math.max(0, (band[i]! - (top - RANGE)) / RANGE)) ** 1.4;
  };
}
