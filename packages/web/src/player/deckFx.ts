/**
 * A deck's effects in the DJ view (Advanced mode, vault "tagave - DJ
 * Module"), in the page's graph between the element's source and its
 * crossfade gain (audioGraph.ts › deckEffects):
 *
 *   in ─ low shelf ─ peaking ─ high shelf ─┬─ (off) ─────────────┬─ dry ──────┬─ out
 *                                          └─ low-pass ─ high-pass┘ └─ delay ⟲ ─ wet ┘
 *
 *   Filter  one knob: centre off, left a low-pass (20 kHz → 200 Hz), right a
 *           high-pass (20 Hz → 8 kHz); off is a straight path, not a filter
 *           left wide open
 *   EQ      low 300 Hz, mid 1 kHz, high 3.2 kHz, ±12 dB each; Kill is −40 dB
 *   Echo    time 60 ms–1 s, feedback, mix (the wet level; the dry stays)
 *
 * Every change moves on the audio clock in a few milliseconds (no clicks).
 * The settings are kept per deck for the page's life (djDecks.ts) and are
 * bypassed outside the view.
 */

export type EqBand = 'low' | 'mid' | 'high';
export const EQ_BANDS: readonly EqBand[] = ['low', 'mid', 'high'];

export interface DeckFxSettings {
  /** −1 (low-pass) … 0 (off) … 1 (high-pass) */
  filter: number;
  /** dB, −12 … 12 */
  eq: Record<EqBand, number>;
  kills: Record<EqBand, boolean>;
  echo: { timeSec: number; feedback: number; mix: number };
}

export const EQ_MAX_DB = 12;
export const KILL_DB = -40;
export const FILTER_OFF = 0.02;
export const ECHO_TIME = { min: 0.06, max: 1 } as const;
export const ECHO_FEEDBACK_MAX = 0.85;

export const FX_DEFAULTS: DeckFxSettings = {
  filter: 0,
  eq: { low: 0, mid: 0, high: 0 },
  kills: { low: false, mid: false, high: false },
  echo: { timeSec: 0.375, feedback: 0.35, mix: 0 },
};

export const cloneFx = (s: DeckFxSettings): DeckFxSettings => ({ filter: s.filter, eq: { ...s.eq }, kills: { ...s.kills }, echo: { ...s.echo } });

const LP_TOP = 20000;
const LP_BOTTOM = 200;
const HP_BOTTOM = 20;
const HP_TOP = 8000;

/** The filter knob as what it does: off, a low-pass at Hz, or a high-pass at Hz. */
export function filterOf(v: number): { kind: 'off' } | { kind: 'lowpass' | 'highpass'; hz: number } {
  if (!Number.isFinite(v) || Math.abs(v) <= FILTER_OFF) return { kind: 'off' };
  const x = Math.min(1, Math.abs(v));
  if (v < 0) return { kind: 'lowpass', hz: LP_TOP * Math.pow(LP_BOTTOM / LP_TOP, x) };
  return { kind: 'highpass', hz: HP_BOTTOM * Math.pow(HP_TOP / HP_BOTTOM, x) };
}

const hzText = (hz: number) => (hz >= 1000 ? `${(Math.round(hz / 100) / 10).toFixed(1)} kHz` : `${Math.round(hz)} Hz`);

/** "Off", "LP 1.2 kHz", "HP 340 Hz". */
export function filterText(v: number): string {
  const f = filterOf(v);
  if (f.kind === 'off') return 'Off';
  return `${f.kind === 'lowpass' ? 'LP' : 'HP'} ${hzText(f.hz)}`;
}

/** "+3 dB", "0 dB", "−6 dB". */
export function dbText(v: number): string {
  const r = Math.round(v * 2) / 2;
  if (r === 0) return '0 dB';
  return `${r > 0 ? '+' : '−'}${Math.abs(r)} dB`;
}

/** The gain a band is set to, a kill included. */
export function bandDb(s: DeckFxSettings, band: EqBand): number {
  return s.kills[band] ? KILL_DB : Math.max(-EQ_MAX_DB, Math.min(EQ_MAX_DB, s.eq[band]));
}

const SMOOTH = 0.012;

export class DeckFx {
  readonly input: GainNode;
  readonly output: GainNode;
  private readonly ctx: BaseAudioContext;
  private readonly bands: Record<EqBand, BiquadFilterNode>;
  private readonly lp: BiquadFilterNode;
  private readonly hp: BiquadFilterNode;
  private readonly straight: GainNode;
  private readonly filtered: GainNode;
  private readonly delay: DelayNode;
  private readonly feedback: GainNode;
  private readonly wet: GainNode;

  constructor(ctx: BaseAudioContext) {
    this.ctx = ctx;
    this.input = ctx.createGain();
    this.output = ctx.createGain();
    const band = (type: BiquadFilterType, hz: number, q?: number) => {
      const b = ctx.createBiquadFilter();
      b.type = type;
      b.frequency.value = hz;
      if (q != null) b.Q.value = q;
      b.gain.value = 0;
      return b;
    };
    this.bands = { low: band('lowshelf', 300), mid: band('peaking', 1000, 0.8), high: band('highshelf', 3200) };
    this.lp = band('lowpass', LP_TOP, 0.9);
    this.hp = band('highpass', HP_BOTTOM, 0.9);
    this.straight = ctx.createGain();
    this.filtered = ctx.createGain();
    this.filtered.gain.value = 0;
    const post = ctx.createGain();
    this.delay = ctx.createDelay(2);
    this.delay.delayTime.value = FX_DEFAULTS.echo.timeSec;
    this.feedback = ctx.createGain();
    this.feedback.gain.value = FX_DEFAULTS.echo.feedback;
    this.wet = ctx.createGain();
    this.wet.gain.value = 0;

    this.input.connect(this.bands.low);
    this.bands.low.connect(this.bands.mid);
    this.bands.mid.connect(this.bands.high);
    this.bands.high.connect(this.straight);
    this.bands.high.connect(this.lp);
    this.lp.connect(this.hp);
    this.hp.connect(this.filtered);
    this.straight.connect(post);
    this.filtered.connect(post);
    post.connect(this.output);
    post.connect(this.delay);
    this.delay.connect(this.feedback);
    this.feedback.connect(this.delay);
    this.delay.connect(this.wet);
    this.wet.connect(this.output);
  }

  private to(p: AudioParam, v: number, tau = SMOOTH) {
    try {
      const t = this.ctx.currentTime;
      p.cancelScheduledValues(t);
      p.setTargetAtTime(v, t, tau);
    } catch {
      try { p.value = v; } catch { /* a closed context */ }
    }
  }

  setFilter(v: number) {
    const f = filterOf(v);
    const nyquist = this.ctx.sampleRate / 2;
    if (f.kind === 'off') {
      this.to(this.straight.gain, 1);
      this.to(this.filtered.gain, 0);
      this.to(this.lp.frequency, Math.min(LP_TOP, nyquist), 0.02);
      this.to(this.hp.frequency, HP_BOTTOM, 0.02);
      return;
    }
    this.to(this.straight.gain, 0);
    this.to(this.filtered.gain, 1);
    if (f.kind === 'lowpass') {
      this.to(this.lp.frequency, Math.min(f.hz, nyquist), 0.015);
      this.to(this.hp.frequency, HP_BOTTOM, 0.015);
    } else {
      this.to(this.hp.frequency, Math.min(f.hz, nyquist), 0.015);
      this.to(this.lp.frequency, Math.min(LP_TOP, nyquist), 0.015);
    }
  }

  setBand(band: EqBand, db: number) {
    this.to(this.bands[band].gain, db, 0.008);
  }

  setEcho(e: DeckFxSettings['echo']) {
    this.to(this.delay.delayTime, Math.min(ECHO_TIME.max, Math.max(ECHO_TIME.min, e.timeSec)), 0.03);
    this.to(this.feedback.gain, Math.min(ECHO_FEEDBACK_MAX, Math.max(0, e.feedback)), 0.02);
    this.to(this.wet.gain, Math.min(1, Math.max(0, e.mix)), 0.02);
  }

  apply(s: DeckFxSettings) {
    this.setFilter(s.filter);
    for (const b of EQ_BANDS) this.setBand(b, bandDb(s, b));
    this.setEcho(s.echo);
  }

  /** As if there were no effects (the view closed). */
  bypass() {
    this.apply({ ...FX_DEFAULTS, echo: { ...FX_DEFAULTS.echo, mix: 0 } });
  }
}
