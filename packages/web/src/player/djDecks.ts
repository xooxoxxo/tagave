/**
 * The DJ view's two decks (Advanced mode, vault "tagave - DJ Module"):
 * deck A is the player's first <audio> element, deck B its second, both in
 * the page's graph (audioGraph.ts), each with its own effects (deckFx.ts)
 * before its crossfade gain.
 *
 *   Play, Cue      Cue: the first beat after the sound starts (deckMath.ts)
 *   Pitch ±8 %     playbackRate, the pitch kept (preservesPitch)
 *   Sync           this deck takes the other's tempo (within ±8 %), follows
 *                  it, and is held on its beat: a slight rate nudge, never
 *                  heard as a pitch change
 *   Crossfader     equal power; the deck it favours is the one heard
 *   Auto mix       Simple mode's Auto with beat alignment (djPlan.ts): the
 *                  next track comes in on the beat at the outgoing tempo,
 *                  the crossfader moves by itself, then the incoming track
 *                  eases back to its own tempo over 8 bars
 *
 * The queue stays tagave's: the next queue track loads into the free deck by
 * itself, and the bar, Now playing, the queue, the play events and the
 * Media Session show the deck heard (engine.ts › showDeck). Its time counts
 * as heard only while it is the deck heard (deckMath.ts › releaseEvent).
 * Leaving the view hands playback back to the engine: the heard deck plays
 * on, the other stops, the effects are bypassed (their settings stay for
 * the page's life, as do the crossfader and Auto mix).
 */
import { create } from 'zustand';
import type { DjPeaks, DjTrackInfo, StreamFormat } from '@tagave/shared';
import { api, type ApiError } from '../services/api';
import { chooseFormat, heardDelta, nextPlayable, previousPlayable, streamUrl, type CanPlay } from './logic';
import { getPlayerQuality } from './quality';
import { allRouted, deckEffects, elementGain, existingContext, routeElements, startContext } from './audioGraph';
import { EQ_BANDS, FX_DEFAULTS, cloneFx, type DeckFxSettings, type EqBand } from './deckFx';
import { RAMP_BEATS, beatGrid, clamp, expectedIncoming, lockRate, planTransition, rampRate, snapToBeat, trackFacts, type DjTrackFacts } from './djPlan';
import { alignedPosition, clampRate, crossfadeGains, cuePoint, heardDeck, phaseError, releaseEvent, syncRate, PITCH_RANGE } from './deckMath';
import { deckClaim, deckEvent, enterDecks, leaveDecks, showDeck, usePlayerStore, type DeckEventType, type DeckOwner, type PlayerStatus, type QueueEntry } from './engine';

export type DeckIndex = 0 | 1;

/** What the view shows of a deck (positions are read each frame: deckPosition). */
export interface DeckView {
  uid: string | null;
  trackId: string | null;
  title: string;
  artist: string;
  album: string;
  coverUrl: string | null;
  durationSec: number | null;
  bpm: number | null;
  firstBeatSec: number | null;
  bpmConfidence: number | null;
  /** the rate set by Pitch or Sync */
  rate: number;
  sync: boolean;
  playing: boolean;
  loading: boolean;
  cue: number;
  /** the waveform: null while asked for, [] while the track is being measured */
  peaks: number[] | null;
  fx: DeckFxSettings;
}

export interface DecksState {
  open: boolean;
  /** 0: deck A only … 1: deck B only */
  x: number;
  heard: DeckIndex;
  auto: boolean;
  /** Auto mix moves the crossfader now */
  mixing: boolean;
  decks: [DeckView, DeckView];
}

const emptyView = (fx: DeckFxSettings): DeckView => ({
  uid: null, trackId: null, title: '', artist: '', album: '', coverUrl: null, durationSec: null, bpm: null, firstBeatSec: null, bpmConfidence: null,
  rate: 1, sync: false, playing: false, loading: false, cue: 0, peaks: null, fx,
});

/** Per deck for the page's life: a reload starts them over. */
const fxMemory: [DeckFxSettings, DeckFxSettings] = [cloneFx(FX_DEFAULTS), cloneFx(FX_DEFAULTS)];

export const useDecks = create<DecksState>()(() => ({
  open: false, x: 0, heard: 0, auto: false, mixing: false,
  decks: [emptyView(fxMemory[0]), emptyView(fxMemory[1])],
}));
const view = () => useDecks.getState();

// ---- the decks ----

interface Deck {
  el: HTMLAudioElement | null;
  entry: QueueEntry | null;
  format: StreamFormat;
  base: number;
  /** heard while playing (now_playing was sent) */
  started: boolean;
  heardSec: number;
  lastTime: number | null;
  reachedEnd: boolean;
  /** loaded from a queue row (stays until it plays), not by itself */
  byHand: boolean;
  /** the rate Pitch or Sync set (the element's own may be nudged around it) */
  rate: number;
  sync: boolean;
  /** Sync's beat hold may jump this deck once it has just started */
  startedAt: number;
  /** where to go once the element knows its length */
  pendingSeek: number | null;
  /** the position follows the cue until the analysis arrives */
  atCue: boolean;
  /** not heard and done since (performance.now()) */
  freeSince: number | null;
  /** after Auto mix: easing back to its own tempo */
  ramp: { fromRate: number; startPos: number; lengthSec: number } | null;
}

const newDeck = (): Deck => ({
  el: null, entry: null, format: 'original', base: 0, started: false, heardSec: 0, lastTime: null, reachedEnd: false, byHand: false,
  rate: 1, sync: false, startedAt: 0, pendingSeek: null, atCue: false, freeSince: null, ramp: null,
});
const decks: [Deck, Deck] = [newDeck(), newDeck()];
let x = 0;
let heard: DeckIndex = 0;
let auto = false;
let timer: ReturnType<typeof setInterval> | null = null;
let isOpen = false;

const other = (i: DeckIndex): DeckIndex => (i === 0 ? 1 : 0);
const pos = (d: Deck) => (d.el ? d.base + (d.el.currentTime || 0) : 0);
const queueTracks = (): readonly QueueEntry[] => usePlayerStore.getState().queue?.tracks ?? [];
const indexOf = (d: Deck) => (d.entry ? queueTracks().findIndex((t) => t.uid === d.entry!.uid) : -1);
const canPlayOf = (a: HTMLAudioElement): CanPlay => (type) => { try { return a.canPlayType(type); } catch { return ''; } };

/** The deck's position in its track, seconds (for the waveform's playhead each frame). */
export function deckPosition(i: DeckIndex): number {
  return pos(decks[i]);
}

/** el.play() to sound (Chrome, measured for rr82). */
const START_LATENCY_SEC = 0.03;
/** Auto mix starts the incoming deck this long before its fade, silent. */
const PREROLL_SEC = 0.6;
/** How far Sync's beat hold may nudge the rate around the synced tempo. */
const HOLD_SLEW = 0.04;
/** Right after a synced deck starts, further off its beat than this: it jumps there once. */
const HOLD_JUMP_SEC = 0.06;
/**
 * A deck playing at a rate other than 1 sounds this much earlier than its
 * clock says (Chrome's time-stretcher; measured for rr82 and rr83: 12 to
 * 18 ms early at 120/123): Sync and Auto mix hold it this far behind.
 */
const STRETCH_LEAD_SEC = 0.012;
const leadFor = (rate: number) => (Math.abs(rate - 1) > 0.002 ? STRETCH_LEAD_SEC * rate : 0);
/** A free deck waits this long before the next track loads into it (a crossfader moved back and forth does not). */
const AUTOLOAD_AFTER_MS = 1500;
const TICK_MS = 20;

// ---- the analysis (GET /me/dj/tracks) and the waveforms (GET /me/dj/peaks/:id) ----

const infos = new Map<string, DjTrackInfo | null>();
const infoAsked = new Map<string, number>();
const peaks = new Map<string, number[]>();
const peaksAsked = new Map<string, number>();
const ASK_AGAIN_MS = 20_000;
let serverOff = false;

function askInfo(ids: readonly string[]) {
  if (serverOff) return;
  const now = Date.now();
  const want = [...new Set(ids)].filter((id) => {
    const i = infos.get(id);
    if (i && (i.bpm != null || i.trimEndMs != null)) return false;
    const at = infoAsked.get(id);
    return at == null || now - at > ASK_AGAIN_MS;
  });
  if (want.length === 0) return;
  for (const id of want) infoAsked.set(id, now);
  void api.get<Array<DjTrackInfo | null>>(`/me/dj/tracks?ids=${want.map(encodeURIComponent).join(',')}`).then(
    (list) => {
      for (const info of Array.isArray(list) ? list : []) if (info?.localTrackId) infos.set(info.localTrackId, info);
      for (const i of [0, 1] as const) onInfo(i);
      refresh();
    },
    (err: ApiError) => { if (err?.status === 404) serverOff = true; },
  );
}

function askPeaks(id: string) {
  if (serverOff || peaks.has(id)) return;
  const at = peaksAsked.get(id);
  if (at != null && Date.now() - at < ASK_AGAIN_MS) return;
  peaksAsked.set(id, Date.now());
  void api.get<DjPeaks>(`/me/dj/peaks/${encodeURIComponent(id)}`).then(
    (r) => { if (Array.isArray(r?.peaks) && r.peaks.length > 0) peaks.set(id, r.peaks); refresh(); },
    (err: ApiError) => { if (err?.status === 404) serverOff = true; },
  );
}

function factsOf(d: Deck): DjTrackFacts | null {
  if (!d.entry) return null;
  const elDur = d.format === 'original' && d.el && Number.isFinite(d.el.duration) ? d.el.duration : null;
  return trackFacts(d.entry, infos.get(d.entry.localTrackId), elDur);
}

const gridOf = (d: Deck) => { const f = factsOf(d); return f ? beatGrid(f) : null; };
const bpmOf = (d: Deck) => { const f = factsOf(d); return f && beatGrid(f) ? f.bpm : null; };
const cueOf = (d: Deck) => { const f = factsOf(d); return f ? cuePoint(f) : 0; };

/** The analysis arrived: a deck still waiting at its start moves to its cue. */
function onInfo(i: DeckIndex) {
  const d = decks[i];
  if (!d.entry || !d.atCue || !d.el || !d.el.paused) return;
  const c = cueOf(d);
  if (Math.abs(pos(d) - c) > 0.01) seekTo(i, c);
}

// ---- the graph ----

/** Routes both elements (from a gesture: the context starts), puts the effects in, sets the crossfader. */
async function ensureGraph(): Promise<boolean> {
  const els = decks.map((d) => d.el).filter((e): e is HTMLAudioElement => !!e);
  if (els.length !== 2) return false;
  const ok = allRouted(els) ? await startContext() : await routeElements(els);
  if (!ok || !isOpen) return ok;
  decks.forEach((d, i) => deckEffects(d.el)?.apply(fxMemory[i]!));
  applyCrossfader();
  return true;
}

let scheduled = false;
/** The gains as the crossfader says (unless Auto mix has them on the audio clock). */
function applyCrossfader(tau = 0.008) {
  if (scheduled) return;
  const c = existingContext();
  const g = crossfadeGains(x);
  decks.forEach((d, i) => {
    const gain = elementGain(d.el);
    if (!gain || !c) return;
    try {
      gain.gain.cancelScheduledValues(0);
      gain.gain.setTargetAtTime(g[i]!, c.currentTime, tau);
    } catch { /* a closed context */ }
  });
}

// ---- loading, playing, seeking ----

function setPitchKept(a: HTMLAudioElement) {
  try { a.preservesPitch = true; } catch { /* not settable here */ }
  try { (a as HTMLAudioElement & { webkitPreservesPitch?: boolean }).webkitPreservesPitch = true; } catch { /* older Safari */ }
}

function setRate(d: Deck, rate: number) {
  if (!d.el) return;
  if (Math.abs(d.el.playbackRate - rate) > 0.0004) {
    try { d.el.playbackRate = rate; } catch { /* out of range */ }
  }
}

/** A deck lets its track go: its play event, if it was heard. */
function letGo(i: DeckIndex) {
  const d = decks[i];
  if (!d.entry) return;
  const f = factsOf(d);
  const kind = releaseEvent({ started: d.started, heardSec: d.heardSec, reachedEnd: d.reachedEnd, durationSec: f?.durationSec ?? null });
  if (kind) deckEvent(kind, d.entry.localTrackId, d.heardSec, pos(d));
  d.started = false;
  d.heardSec = 0;
}

function loadDeck(i: DeckIndex, index: number, opts: { offset?: number; autoplay?: boolean; byHand?: boolean } = {}) {
  const d = decks[i];
  const entry = queueTracks()[index];
  if (!d.el || !entry) return;
  letGo(i);
  if (trans && (trans.inc === i || trans.out === i)) cancelTransition();
  const a = d.el;
  try { a.pause(); } catch { /* not loaded */ }
  d.entry = entry;
  d.byHand = !!opts.byHand;
  d.reachedEnd = false;
  d.lastTime = null;
  d.freeSince = null;
  d.ramp = null;
  d.sync = false;
  d.rate = 1;
  d.format = chooseFormat(getPlayerQuality(), entry.mime, canPlayOf(a));
  d.atCue = opts.offset == null;
  const at = Math.max(0, opts.offset ?? cueOf(d));
  d.base = d.format === 'original' ? 0 : Math.floor(at);
  d.pendingSeek = d.format === 'original' && at > 0 ? at : null;
  a.preload = 'auto';
  setPitchKept(a);
  a.src = streamUrl(entry.localTrackId, d.format, getPlayerQuality().bitrate, d.base);
  try { a.load(); } catch { /* loads on play */ }
  a.playbackRate = 1;
  const next = queueTracks()[nextPlayable(queueTracks(), index)];
  askInfo([entry.localTrackId, ...(next ? [next.localTrackId] : [])]);
  askPeaks(entry.localTrackId);
  if (opts.autoplay) void playDeck(i);
  refresh();
}

function seekTo(i: DeckIndex, sec: number) {
  const d = decks[i];
  const a = d.el;
  if (!a || !d.entry) return;
  const f = factsOf(d);
  const t = clamp(sec, 0, Math.max(0, (f?.durationSec ?? Number.POSITIVE_INFINITY) - 0.05));
  d.lastTime = null;
  d.reachedEnd = false;
  if (d.format === 'original') {
    if (a.readyState < 1) { d.pendingSeek = t; return; }
    try { a.currentTime = t; } catch { d.pendingSeek = t; }
    return;
  }
  // a transcode loads again from that second
  const playing = !a.paused;
  d.base = Math.floor(t);
  a.src = streamUrl(d.entry.localTrackId, d.format, getPlayerQuality().bitrate, d.base);
  if (playing) void a.play().catch(() => undefined);
}

/** Plays a deck (a gesture: the graph starts); a synced deck starts on the other deck's beat. */
export async function playDeck(i: DeckIndex): Promise<void> {
  const d = decks[i];
  const o = decks[other(i)];
  if (!d.el) return;
  if (!d.entry) {
    // nothing on it: the queue's track, where it rests
    const s = usePlayerStore.getState();
    if (i === heard && s.index >= 0) loadDeck(i, s.index, { offset: s.position });
    else return;
  }
  const a = d.el;
  if (!(await ensureGraph()) && !allRouted(decks.map((x) => x.el!).filter(Boolean))) {
    // no graph (the browser refused the context): both decks would sound at full level
    if (!o.el?.paused) o.el?.pause();
  }
  const f = factsOf(d);
  const end = f?.trimEndSec ?? f?.durationSec ?? null;
  if (end != null && pos(d) >= end - 0.05) seekTo(i, cueOf(d));
  if (d.sync && o.el && !o.el.paused) {
    const g = gridOf(d);
    const og = gridOf(o);
    if (g && og) {
      const want = alignedPosition(pos(d), g, pos(o) + START_LATENCY_SEC * (o.el.playbackRate || 1), og);
      if (Math.abs(want - pos(d)) > 0.002) seekTo(i, want);
    }
  }
  setPitchKept(a);
  setRate(d, d.rate);
  d.startedAt = performance.now();
  d.atCue = false;
  d.freeSince = null;
  try { await a.play(); } catch { /* refused (no gesture) or replaced */ }
  refresh();
}

export function pauseDeck(i: DeckIndex) {
  const d = decks[i];
  if (!d.el) return;
  if (trans && (trans.inc === i || trans.out === i)) cancelTransition();
  d.el.pause();
  refresh();
}

export function toggleDeck(i: DeckIndex) {
  const a = decks[i].el;
  if (!a) return;
  if (a.paused) void playDeck(i);
  else pauseDeck(i);
}

/** Cue: the deck stops on its cue point. */
export function cueDeck(i: DeckIndex) {
  const d = decks[i];
  if (!d.el || !d.entry) return;
  pauseDeck(i);
  seekTo(i, cueOf(d));
  d.atCue = true;
  refresh();
}

export function seekDeck(i: DeckIndex, sec: number) {
  seekTo(i, sec);
  decks[i].atCue = false;
  refresh();
}

/** Pitch: a rate within ±8 %; it ends Sync. */
export function setPitch(i: DeckIndex, rate: number) {
  const d = decks[i];
  d.sync = false;
  d.ramp = null;
  d.rate = clampRate(rate);
  setRate(d, d.rate);
  refresh();
}

/** Sync on: this deck takes the other's tempo and beat (only one deck follows). Off: it keeps the tempo it has. */
export function toggleSync(i: DeckIndex) {
  const d = decks[i];
  const o = decks[other(i)];
  if (d.sync) { d.sync = false; setRate(d, d.rate); refresh(); return; }
  const r = syncRate(bpmOf(d), bpmOf(o), o.rate);
  if (r == null) return;
  o.sync = false;
  d.sync = true;
  d.ramp = null;
  d.rate = r;
  setRate(d, r);
  // a deck not heard jumps onto the beat at once; the one heard is pulled there
  if (d.el && !d.el.paused && o.el && !o.el.paused && heard !== i) {
    const g = gridOf(d);
    const og = gridOf(o);
    if (g && og) seekTo(i, alignedPosition(pos(d), g, pos(o), og));
  }
  refresh();
}

export function setCrossfader(value: number) {
  if (trans) cancelTransition();
  x = clamp(value, 0, 1);
  applyCrossfader();
  refresh();
}

export function nudgeCrossfader(step: number) {
  setCrossfader(x + step);
}

export function setAutoMix(on: boolean) {
  auto = on;
  if (!on && trans) cancelTransition();
  refresh();
}

export function setFx(i: DeckIndex, patch: Partial<Omit<DeckFxSettings, 'eq' | 'kills' | 'echo'>> & { eq?: Partial<DeckFxSettings['eq']>; kills?: Partial<DeckFxSettings['kills']>; echo?: Partial<DeckFxSettings['echo']> }) {
  const cur = fxMemory[i]!;
  const next: DeckFxSettings = {
    filter: patch.filter ?? cur.filter,
    eq: { ...cur.eq, ...patch.eq },
    kills: { ...cur.kills, ...patch.kills },
    echo: { ...cur.echo, ...patch.echo },
  };
  fxMemory[i] = next;
  if (isOpen) deckEffects(decks[i].el)?.apply(next);
  refresh();
}

export function toggleKill(i: DeckIndex, band: EqBand) {
  setFx(i, { kills: { [band]: !fxMemory[i]!.kills[band] } });
}

/** The heard deck's kill (keys 1, 2, 3). */
export function toggleHeardKill(band: EqBand) {
  toggleKill(heard, band);
}

// ---- Auto mix ----

interface Transition {
  phase: 'wait' | 'preroll' | 'fading';
  out: DeckIndex;
  inc: DeckIndex;
  /** seconds into the outgoing track the fade begins, how long it lasts there, where the incoming one comes in */
  startSec: number;
  lengthSec: number;
  inAtSec: number;
  beatAligned: boolean;
  rateIn: number;
  rampSec: number;
  /** the audio-clock second the crossfader starts moving, and how long it moves */
  t0: number;
  wallSec: number;
  xFrom: number;
  xTo: number;
}
let trans: Transition | null = null;

const AUTO_SETTINGS = { crossfade: 'auto', lengthSec: 6, beatAligned: true, gaplessAlbums: false } as const;

/** Auto mix's way from the heard deck into the other: Simple mode's Auto, beat-aligned, at the decks' tempos. */
export function planAuto(out: DjTrackFacts, inc: DjTrackFacts, rateOut: number, rateInNow: number): Omit<Transition, 'phase' | 'out' | 'inc' | 't0' | 'wallSec' | 'xFrom' | 'xTo'> | null {
  const plan = planTransition(out, inc, AUTO_SETTINGS);
  if (plan.kind !== 'fade') return null;
  let rateIn = rateInNow;
  let rampSec = 0;
  if (plan.beatAligned && out.bpm && inc.bpm) {
    const ratio = (out.bpm * rateOut) / inc.bpm;
    if (Math.abs(ratio - 1) <= PITCH_RANGE) {
      rateIn = ratio;
      rampSec = Math.abs(ratio - 1) > 1e-4 ? (RAMP_BEATS * 60) / inc.bpm : 0;
    }
  }
  return { startSec: plan.startSec, lengthSec: plan.lengthSec, inAtSec: plan.inAtSec, beatAligned: plan.beatAligned, rateIn, rampSec };
}

function cancelTransition() {
  const t = trans;
  if (!t) return;
  trans = null;
  scheduled = false;
  const c = existingContext();
  if (t.phase === 'fading' && c) {
    const k = clamp((c.currentTime - t.t0) / t.wallSec, 0, 1);
    x = t.xFrom + (t.xTo - t.xFrom) * k;
  }
  if (t.phase === 'preroll') {
    // the incoming deck goes back to waiting, silent
    const d = decks[t.inc];
    d.el?.pause();
    d.rate = 1;
    setRate(d, 1);
  }
  applyCrossfader();
  refresh();
}

/** The gains along the fade on the audio clock (equal power along the crossfader's way). */
function scheduleFade(t: Transition) {
  const c = existingContext();
  const ga = elementGain(decks[0].el);
  const gb = elementGain(decks[1].el);
  if (!c || !ga || !gb) return;
  const n = 256;
  const a = new Float32Array(n);
  const b = new Float32Array(n);
  for (let k = 0; k < n; k++) {
    const g = crossfadeGains(t.xFrom + ((t.xTo - t.xFrom) * k) / (n - 1));
    a[k] = g[0];
    b[k] = g[1];
  }
  scheduled = true;
  const at = Math.max(c.currentTime + 0.005, t.t0);
  try {
    for (const [g, curve] of [[ga, a], [gb, b]] as const) {
      g.gain.cancelScheduledValues(0);
      g.gain.setValueAtTime(curve[0]!, c.currentTime);
      g.gain.setValueCurveAtTime(curve, at, t.wallSec);
    }
  } catch {
    scheduled = false;
  }
}

function autoTick() {
  const c = existingContext();
  if (trans) { stepTransition(c); return; }
  if (!auto || !c) return;
  const out = heard;
  const inc = other(out);
  const o = decks[out];
  const n = decks[inc];
  if (!o.el || !n.el || !o.entry || !n.entry || o.el.paused || !n.el.paused || n.started) return;
  const fo = factsOf(o);
  const fi = factsOf(n);
  if (!fo || !fi) return;
  const p = planAuto(fo, fi, o.rate, n.rate);
  const rateOut = o.el.playbackRate || 1;
  if (!p) {
    // no room for a fade (a short track, no length): at its end, straight into the next
    const end = fo.trimEndSec ?? fo.durationSec;
    if (end != null && pos(o) >= end - 0.05) {
      x = inc === 1 ? 1 : 0;
      applyCrossfader(0.005);
      void playDeck(inc);
    }
    return;
  }
  let { startSec } = p;
  let lengthSec = p.lengthSec;
  const at = pos(o);
  // Auto mix turned on late: from the next beat a second from now, as long as there is room
  if (at > startSec - PREROLL_SEC * rateOut - 0.2) {
    const g = gridOf(o);
    const from = at + 1;
    const s2 = g ? snapToBeat(from, g.firstBeat, g.period, 1) : from;
    const end = startSec + lengthSec;
    if (end - s2 < 1) return;
    lengthSec = Math.min(lengthSec, end - s2);
    startSec = s2;
  }
  trans = { phase: 'wait', out, inc, ...p, startSec, lengthSec, t0: Number.POSITIVE_INFINITY, wallSec: lengthSec / rateOut, xFrom: x, xTo: inc === 1 ? 1 : 0 };
  refresh();
}

function stepTransition(c: AudioContext | null) {
  const t = trans;
  if (!t || !c) return;
  const o = decks[t.out];
  const n = decks[t.inc];
  if (!o.el || !n.el) { cancelTransition(); return; }
  const rateOut = o.el.playbackRate || 1;
  const posOut = pos(o);
  if (t.phase === 'wait') {
    if (o.el.paused) { cancelTransition(); return; }
    const dt = (t.startSec - posOut) / rateOut;
    if (dt > PREROLL_SEC + START_LATENCY_SEC) return;
    const at = t.inAtSec - (dt - START_LATENCY_SEC) * t.rateIn;
    if (at < 0) return;
    // the incoming deck is silent from here: the crossfader rests on the outgoing side
    x = t.out === 0 ? 0 : 1;
    t.xFrom = x;
    applyCrossfader(0.03);
    n.rate = t.rateIn;
    n.sync = false;
    seekTo(t.inc, at);
    setPitchKept(n.el);
    setRate(n, t.rateIn);
    t.phase = 'preroll';
    n.atCue = false;
    n.startedAt = performance.now();
    void n.el.play().catch(() => { if (trans === t) cancelTransition(); });
    refresh();
    return;
  }
  if (t.phase === 'preroll') {
    if (t.beatAligned && !n.el.paused && n.el.readyState >= 3) {
      const want = expectedIncoming(posOut, t.startSec, t.inAtSec, t.rateIn, rateOut) - leadFor(t.rateIn) + leadFor(rateOut);
      const err = pos(n) - want;
      if (Math.abs(err) > 0.12) seekTo(t.inc, want + START_LATENCY_SEC * t.rateIn);
      else setRate(n, lockRate(err, t.rateIn, 0.15));
    }
    if (posOut < t.startSec) return;
    if (n.el.paused || n.el.readyState < 3) {
      if (posOut > t.startSec + t.lengthSec / 2) cancelTransition();
      return;
    }
    setRate(n, t.rateIn);
    const dt = (t.startSec - posOut) / rateOut;
    t.t0 = c.currentTime + Math.max(0, dt);
    t.wallSec = Math.max(0.2, (t.startSec + t.lengthSec - Math.max(posOut, t.startSec)) / rateOut);
    t.phase = 'fading';
    scheduleFade(t);
    refresh();
    return;
  }
  // fading: the crossfader moves (the gains are on the audio clock)
  const k = clamp((c.currentTime - t.t0) / t.wallSec, 0, 1);
  const nx = t.xFrom + (t.xTo - t.xFrom) * k;
  if (Math.abs(nx - x) > 0.004 || k >= 1) { x = nx; refresh(); }
  if (k < 1) return;
  // done: the outgoing deck stops (it loads the next track), the incoming one eases back to its own tempo
  trans = null;
  scheduled = false;
  x = t.xTo;
  o.el.pause();
  o.reachedEnd = true;
  applyCrossfader();
  if (t.rampSec > 0 && !n.sync) n.ramp = { fromRate: t.rateIn, startPos: pos(n), lengthSec: t.rampSec };
  refresh();
}

function rampTick(d: Deck) {
  const r = d.ramp;
  if (!r || !d.el || d.el.paused) return;
  const p = (pos(d) - r.startPos) / r.lengthSec;
  if (p >= 1 || p < 0) { d.ramp = null; d.rate = 1; setRate(d, 1); return; }
  d.rate = rampRate(r.fromRate, p);
  setRate(d, d.rate);
}

// ---- every 20 ms while the view is open ----

/** Sync: the other deck's tempo, and its beat held by a slight nudge of the rate. */
function holdSync(i: DeckIndex) {
  const d = decks[i];
  const o = decks[other(i)];
  if (!d.sync || !d.el || !o.el) return;
  const r = syncRate(bpmOf(d), bpmOf(o), o.el.paused ? o.rate : (o.ramp ? o.el.playbackRate : o.rate));
  if (r == null) return;
  d.rate = r;
  if (d.el.paused || o.el.paused || d.el.readyState < 3 || d.el.seeking || o.el.seeking) { setRate(d, r); return; }
  const g = gridOf(d);
  const og = gridOf(o);
  if (!g || !og) { setRate(d, r); return; }
  const err = phaseError(pos(d), g, pos(o), og) + leadFor(r) - leadFor(o.el.playbackRate || 1);
  if (Math.abs(err) > HOLD_JUMP_SEC && performance.now() - d.startedAt < 1500) {
    d.startedAt = 0;
    seekTo(i, pos(d) - err + START_LATENCY_SEC * r);
    return;
  }
  setRate(d, lockRate(err, r, HOLD_SLEW, 0.4, 0.003));
}

function accountHeard(i: DeckIndex) {
  const d = decks[i];
  const a = d.el;
  if (!a || !d.entry) return;
  const now = a.currentTime;
  if (i === heard && !a.paused && !a.seeking) {
    d.heardSec += heardDelta(d.lastTime, now);
    if (!d.started && a.readyState >= 3) {
      d.started = true;
      deckEvent('now_playing', d.entry.localTrackId, 0, pos(d));
      deckClaim();
    }
  }
  d.lastTime = a.paused || a.seeking ? null : now;
  const f = factsOf(d);
  const end = f?.trimEndSec ?? f?.durationSec ?? null;
  if (end != null && pos(d) >= end - 0.25) d.reachedEnd = true;
}

/** The next queue track loads into the free deck: not heard, not playing, and empty or done with what it held. */
function autoload(now: number) {
  const i = other(heard);
  const d = decks[i];
  const h = decks[heard];
  if (!d.el || trans) return;
  const tracks = queueTracks();
  const hi = h.entry ? indexOf(h) : usePlayerStore.getState().index;
  const n = hi >= 0 ? nextPlayable(tracks, hi) : -1;
  const want = n >= 0 ? tracks[n] : null;
  const done = !d.entry || d.started || d.reachedEnd || (!d.byHand && d.entry.uid !== want?.uid) || indexOf(d) < 0;
  if (!d.el.paused || !done || !want || d.entry?.uid === want.uid) { d.freeSince = null; return; }
  if (d.freeSince == null) { d.freeSince = now; return; }
  if (now - d.freeSince < AUTOLOAD_AFTER_MS && d.entry) return;
  d.freeSince = null;
  loadDeck(i, n);
}

let lastShown = 0;
function statusOf(d: Deck): PlayerStatus {
  if (!d.el || !d.entry) return 'paused';
  if (d.el.paused) return 'paused';
  return d.el.readyState >= 3 ? 'playing' : 'buffering';
}

function show(force = false) {
  const t = performance.now();
  if (!force && t - lastShown < 250) return;
  lastShown = t;
  const d = decks[heard];
  showDeck({ uid: d.entry?.uid ?? null, status: statusOf(d), position: pos(d), duration: factsOf(d)?.durationSec ?? null });
}

function tick() {
  if (!isOpen) return;
  const before = heard;
  heard = heardDeck(x, heard);
  for (const i of [0, 1] as const) {
    accountHeard(i);
    rampTick(decks[i]);
    holdSync(i);
  }
  autoTick();
  autoload(performance.now());
  if (heard !== before) refresh();
  else refreshQuiet();
  show(heard !== before);
}

// ---- the view's state ----

function viewOf(i: DeckIndex): DeckView {
  const d = decks[i];
  const e = d.entry;
  if (!e) return emptyView(fxMemory[i]!);
  const f = factsOf(d);
  const info = infos.get(e.localTrackId);
  return {
    uid: e.uid, trackId: e.localTrackId, title: e.title, artist: e.artist || e.albumArtist, album: e.album, coverUrl: e.coverUrl ?? null,
    durationSec: f?.durationSec ?? null,
    bpm: f && beatGrid(f) ? f.bpm : null,
    firstBeatSec: f?.firstBeatSec ?? null,
    bpmConfidence: info?.bpmConfidence ?? null,
    rate: Math.round(d.rate * 1e4) / 1e4,
    sync: d.sync,
    playing: !!d.el && !d.el.paused,
    loading: !!d.el && !d.el.paused && d.el.readyState < 3,
    cue: cueOf(d),
    peaks: peaks.get(e.localTrackId) ?? (peaksAsked.has(e.localTrackId) ? [] : null),
    fx: fxMemory[i]!,
  };
}

let lastKey = '';
function refresh() {
  const next: DecksState = { open: isOpen, x, heard, auto, mixing: !!trans && trans.phase === 'fading', decks: [viewOf(0), viewOf(1)] };
  const key = JSON.stringify([next.open, Math.round(next.x * 1000), next.heard, next.auto, next.mixing, next.decks.map((d) => [d.uid, d.durationSec, d.bpm, d.firstBeatSec, d.rate, d.sync, d.playing, d.loading, d.cue, d.peaks?.length ?? -1, d.fx])]);
  if (key === lastKey) return;
  lastKey = key;
  useDecks.setState(next);
}
/** As refresh, cheaply: only when what is shown changed (it is called every tick). */
function refreshQuiet() {
  const playing = decks.map((d) => !!d.el && !d.el.paused && d.el.readyState >= 3).join();
  const rates = decks.map((d) => Math.round(d.rate * 1e4)).join();
  const k = `${playing}|${rates}|${Math.round(x * 1000)}|${!!trans}`;
  if (k !== quietKey) { quietKey = k; refresh(); }
}
let quietKey = '';

// ---- the engine's side (engine.ts › DeckOwner) ----

const owner: DeckOwner = {
  event(a: HTMLAudioElement, type: DeckEventType) {
    const found = decks[0].el === a ? 0 : decks[1].el === a ? 1 : -1;
    if (found < 0) return;
    const i = found as DeckIndex;
    const d = decks[i];
    if (type === 'loadedmetadata' && d.pendingSeek != null) {
      const t = d.pendingSeek;
      d.pendingSeek = null;
      try { a.currentTime = t; } catch { /* not seekable */ }
    }
    if (type === 'seeking') d.lastTime = null;
    if (type === 'ended') d.reachedEnd = true;
    if (type === 'timeupdate') { tick(); return; }
    refresh();
    if (i === heard) show(true);
  },
  play() { void playDeck(heard); },
  pause() { pauseDeck(heard); },
  next() {
    const i = other(heard);
    const d = decks[i];
    if (!d.entry) {
      const n = nextPlayable(queueTracks(), indexOf(decks[heard]));
      if (n >= 0) loadDeck(heard, n, { autoplay: true });
      return;
    }
    // straight to the free deck's track, from its cue
    const was = heard;
    if (!d.el?.paused) { /* already playing: only the crossfader moves */ } else seekTo(i, d.started ? cueOf(d) : pos(d));
    setCrossfader(i === 1 ? 1 : 0);
    heard = i;
    void playDeck(i).then(() => pauseDeck(was));
  },
  previous() {
    const d = decks[heard];
    if (!d.entry) return;
    if (pos(d) > 3) { seekTo(heard, 0); return; }
    const p = previousPlayable(queueTracks(), indexOf(d));
    if (p >= 0) loadDeck(heard, p, { offset: 0, autoplay: !d.el?.paused });
    else seekTo(heard, 0);
  },
  seek(sec: number) { seekDeck(heard, sec); },
  playAt(index: number) { loadDeck(other(heard), index, { byHand: true }); },
  load(index: number, opts: { offset?: number; autoplay?: boolean }) {
    loadDeck(heard, index, { ...(opts.offset != null ? { offset: opts.offset } : {}), autoplay: opts.autoplay !== false });
  },
  queueChanged() { refresh(); },
  trouble() {
    setTimeout(() => {
      const c = existingContext();
      if (c && c.state !== 'running') { if (trans) cancelTransition(); decks.forEach((d) => d.el?.pause()); refresh(); show(true); }
      else applyCrossfader();
    }, 1500);
  },
  leave(handBack: boolean) { close(handBack); },
};

/**
 * The view opens: the decks take the elements. The track that played stays
 * on its deck, playing on, the crossfader on its side; the other deck holds
 * the next queue track (the one already loaded, when there is one).
 */
export function openDecks(): boolean {
  if (isOpen) return true;
  const start = enterDecks(owner);
  if (!start) return false;
  isOpen = true;
  const [ea, eb] = start.elements;
  decks[0] = { ...newDeck(), el: ea };
  decks[1] = { ...newDeck(), el: eb };
  heard = start.active;
  x = heard === 1 ? 1 : 0;
  trans = null;
  scheduled = false;
  const tracks = queueTracks();
  const c = start.current;
  const h = decks[heard];
  if (c) {
    const entry = tracks.find((t) => t.uid === c.uid) ?? null;
    Object.assign(h, { entry, format: c.format, base: c.base, started: c.started, heardSec: c.heardSec, lastTime: c.playing ? h.el!.currentTime : null, rate: clampRate(h.el!.playbackRate || 1) });
    setRate(h, h.rate);
  } else {
    const s = usePlayerStore.getState();
    if (s.index >= 0) loadDeck(heard, s.index, { offset: s.position });
  }
  const sb = start.standby;
  const f = decks[other(heard)];
  if (sb) {
    const entry = tracks.find((t) => t.uid === sb.uid) ?? null;
    Object.assign(f, { entry, format: sb.format, base: sb.base, atCue: true });
    if (f.el) { f.el.playbackRate = 1; try { f.el.pause(); } catch { /* not playing */ } }
    onInfo(other(heard));
    if (entry) askPeaks(entry.localTrackId);
  }
  askInfo(decks.flatMap((d) => (d.entry ? [d.entry.localTrackId] : [])));
  for (const d of decks) if (d.entry) askPeaks(d.entry.localTrackId);
  void ensureGraph();
  if (!timer) timer = setInterval(tick, TICK_MS);
  refresh();
  show(true);
  return true;
}

/** The view closes: the heard deck plays on in the engine, the other stops. */
export function closeDecks() {
  close(true);
}

function close(handBack: boolean) {
  if (!isOpen) return;
  if (trans) cancelTransition();
  isOpen = false;
  if (timer) { clearInterval(timer); timer = null; }
  const h = decks[heard];
  letGo(other(heard));
  if (!handBack) letGo(heard);
  const g = gridOf(h);
  const session = handBack && h.entry ? { uid: h.entry.uid, trackId: h.entry.localTrackId, format: h.format, base: h.base, started: h.started, heardSec: h.heardSec } : null;
  leaveDecks(owner, { deck: heard, session, rampSec: g ? RAMP_BEATS * g.period : 8 });
  decks[0] = newDeck();
  decks[1] = newDeck();
  refresh();
}

/** The settings of a deck's effects (the view's knobs). */
export function deckFxSettings(i: DeckIndex): DeckFxSettings {
  return fxMemory[i]!;
}

export const DECK_BANDS = EQ_BANDS;
