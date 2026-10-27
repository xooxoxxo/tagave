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

export const BANDS = 3;

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
