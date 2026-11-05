/**
 * The one Web Audio graph of the page, shared by the DJ module and the
 * equalizer glow (adaptive/levels.ts):
 *
 *   <audio> ─ MediaElementSource ─ gain ─┐
 *   <audio> ─ MediaElementSource ─ gain ─┴─ master ─ destination
 *                                              └──── the glow's analyser
 *
 * createMediaElementSource is once per element for the life of the page, so
 * an element routed here stays routed until a reload: DJ turned off sets the
 * gains to 1 and keeps the graph. Elements join only once the context runs
 * (a suspended context would silence them), which takes a play gesture the
 * first time. A context the browser stops later (a call, the lock screen, a
 * Bluetooth switch) is resumed while something plays, and on the next play
 * gesture; the engine hears of it (onContextTrouble) and puts the gains back
 * to 1 so nothing stays half faded. Never built in an iOS home-screen app
 * (djSettings.ts › djAvailableHere; levels.ts never routes on iOS).
 */

let ctx: AudioContext | null = null;
let master: GainNode | null = null;
const gains = new Map<HTMLMediaElement, GainNode>();
const graphWatchers = new Set<(master: GainNode) => void>();
const troubleWatchers = new Set<(state: string) => void>();

/** The page's context, made on first ask (it may start suspended until a gesture). */
export function sharedContext(): AudioContext | null {
  if (ctx) return ctx;
  if (typeof globalThis.AudioContext === 'undefined') return null;
  try {
    ctx = new AudioContext({ latencyHint: 'playback' });
  } catch {
    try { ctx = new AudioContext(); } catch { return null; }
  }
  ctx.addEventListener('statechange', onStateChange);
  return ctx;
}

/** The context if one was made. */
export function existingContext(): AudioContext | null {
  return ctx;
}

/** Resumes the context (from a gesture where one is needed); whether it runs. */
export async function startContext(): Promise<boolean> {
  const c = sharedContext();
  if (!c) return false;
  if (c.state === 'running') return true;
  try { await c.resume(); } catch { /* not without a gesture */ }
  return (c.state as string) === 'running';
}

/** The master bus once some element is routed, else null (the glow then keeps its own way). */
export function graphMaster(): GainNode | null {
  return master;
}

export function isRouted(el: HTMLMediaElement): boolean {
  return gains.has(el);
}

/** Every element routed. */
export function allRouted(els: readonly HTMLMediaElement[]): boolean {
  return els.length > 0 && els.every((e) => gains.has(e));
}

/** The element's own gain (the fades move it), or null when it is not routed. */
export function elementGain(el: HTMLMediaElement | null | undefined): GainNode | null {
  return el ? gains.get(el) ?? null : null;
}

/**
 * Routes the elements through the graph, once the context runs. Resolves to
 * whether all of them are routed; false leaves them exactly as they were.
 */
export async function routeElements(els: readonly HTMLMediaElement[]): Promise<boolean> {
  if (allRouted(els)) return true;
  if (!(await startContext()) || !ctx) return false;
  try {
    if (!master) {
      master = ctx.createGain();
      master.connect(ctx.destination);
    }
    for (const el of els) {
      if (gains.has(el)) continue;
      const g = ctx.createGain();
      g.connect(master);
      ctx.createMediaElementSource(el).connect(g);
      gains.set(el, g);
      el.addEventListener('play', wake);
    }
  } catch {
    return allRouted(els);
  }
  const m = master;
  graphWatchers.forEach((w) => w(m));
  return true;
}

/** Calls `watch` with the master bus once it exists (now, if it does). */
export function onGraph(watch: (master: GainNode) => void): () => void {
  graphWatchers.add(watch);
  if (master) watch(master);
  return () => { graphWatchers.delete(watch); };
}

/** Called when the context stops while routed elements play (the engine puts the gains back). */
export function onContextTrouble(watch: (state: string) => void): () => void {
  troubleWatchers.add(watch);
  return () => { troubleWatchers.delete(watch); };
}

/** Every element at full gain, nothing scheduled: what plays is heard as is. */
export function resetGains(): void {
  for (const g of gains.values()) setGainNow(g, 1);
}

export function setGainNow(g: GainNode, value: number): void {
  try {
    const t = g.context.currentTime;
    g.gain.cancelScheduledValues(0);
    g.gain.setValueAtTime(value, t);
  } catch { /* a closed context */ }
  try { g.gain.value = value; } catch { /* automation owns it */ }
}

function playing(): boolean {
  for (const el of gains.keys()) if (!el.paused) return true;
  return false;
}

function wake() {
  if (ctx && ctx.state !== 'running') void ctx.resume().catch(() => undefined);
}

function onStateChange() {
  if (!ctx || ctx.state === 'running' || gains.size === 0 || !playing()) return;
  troubleWatchers.forEach((w) => w(ctx!.state));
  wake();
}
