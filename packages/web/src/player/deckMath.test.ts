import { describe, expect, it } from 'vitest';
import {
  alignedPosition, beatPhase, clampRate, crossfadeGains, cuePoint, deckClock, downbeats, effectiveBpm, heardDeck, phaseError, pitchText, releaseEvent, syncRate,
} from './deckMath';
import { bandDb, dbText, filterOf, filterText, FX_DEFAULTS, KILL_DB } from './deckFx';
import { planAuto } from './djDecks';
import type { DjTrackFacts } from './djPlan';

const facts = (o: Partial<DjTrackFacts>): DjTrackFacts => ({
  localTrackId: 't', durationSec: 30, bpm: 120, bpmConfidence: 0.95, firstBeatSec: 1.5, trimStartSec: 1.5, trimEndSec: 27.5, albumKey: null, discNo: 1, trackNo: 1, ...o,
});

describe('the crossfader', () => {
  it('is equal power: the two gains\' powers always sum to 1', () => {
    for (const x of [0, 0.1, 0.25, 0.5, 0.77, 1]) {
      const [a, b] = crossfadeGains(x);
      expect(a * a + b * b).toBeCloseTo(1, 10);
    }
    expect(crossfadeGains(0)).toEqual([1, 0]);
    expect(crossfadeGains(1)[0]).toBeCloseTo(0, 10);
    expect(crossfadeGains(0.5)[0]).toBeCloseTo(Math.SQRT1_2, 10);
  });

  it('keeps out-of-range positions at the ends', () => {
    expect(crossfadeGains(-1)).toEqual(crossfadeGains(0));
    expect(crossfadeGains(2)).toEqual(crossfadeGains(1));
    expect(crossfadeGains(Number.NaN)).toEqual(crossfadeGains(0));
  });

  it('favours the nearer deck; dead centre keeps the one heard before', () => {
    expect(heardDeck(0.2, 1)).toBe(0);
    expect(heardDeck(0.8, 0)).toBe(1);
    expect(heardDeck(0.5, 0)).toBe(0);
    expect(heardDeck(0.5, 1)).toBe(1);
  });
});

describe('Pitch and Sync', () => {
  it('keeps the rate within ±8 %', () => {
    expect(clampRate(1.2)).toBe(1.08);
    expect(clampRate(0.5)).toBe(0.92);
    expect(clampRate(Number.NaN)).toBe(1);
    expect(pitchText(1.024)).toBe('+2.4 %');
    expect(pitchText(0.99)).toBe('−1.0 %');
    expect(pitchText(1)).toBe('0.0 %');
  });

  it('matches the other deck\'s effective tempo, clamped', () => {
    expect(syncRate(120, 123, 1)).toBeCloseTo(1.025, 6);
    expect(syncRate(120, 120, 1.02)).toBeCloseTo(1.02, 6);
    // 140 against 120 is beyond the range: as close as it goes
    expect(syncRate(140, 120, 1)).toBe(0.92);
    expect(syncRate(null, 120, 1)).toBeNull();
    expect(effectiveBpm(120, 1.025)).toBeCloseTo(123, 6);
    expect(effectiveBpm(null, 1)).toBeNull();
  });

  it('measures how far one deck is off the other\'s beat, within half a beat', () => {
    const g = { firstBeat: 1.5, period: 0.5 };
    expect(beatPhase(1.75, 1.5, 0.5)).toBeCloseTo(0.5, 10);
    expect(phaseError(2.0, g, 3.0, g)).toBeCloseTo(0, 10);
    expect(phaseError(2.03, g, 3.0, g)).toBeCloseTo(0.03, 10);
    expect(phaseError(1.98, g, 3.0, g)).toBeCloseTo(-0.02, 10);
    // never more than half a beat either way
    expect(Math.abs(phaseError(2.24, g, 3.0, g))).toBeLessThanOrEqual(0.25);
    // different tempos: the error is in this deck's own seconds
    const fast = { firstBeat: 1.5, period: 60 / 123 };
    const at = alignedPosition(5, fast, 7.3, g);
    expect(phaseError(at, fast, 7.3, g)).toBeCloseTo(0, 9);
    expect(Math.abs(at - 5)).toBeLessThanOrEqual(fast.period / 2 + 1e-9);
  });
});

describe('the cue point and the downbeats', () => {
  it('cues the first beat at or after the sound starts', () => {
    expect(cuePoint(facts({}))).toBeCloseTo(1.5, 10);
    expect(cuePoint(facts({ trimStartSec: 1.6 }))).toBeCloseTo(2.0, 10);
    // no grid: where the sound starts; nothing known: 0
    expect(cuePoint(facts({ bpm: null }))).toBeCloseTo(1.5, 10);
    expect(cuePoint(facts({ bpm: null, trimStartSec: null }))).toBe(0);
    // too unsure of the tempo: the sound's start
    expect(cuePoint(facts({ bpmConfidence: 0.2, trimStartSec: 1.7 }))).toBeCloseTo(1.7, 10);
  });

  it('ticks every fourth beat from the first', () => {
    const d = downbeats({ bpm: 120, firstBeatSec: 1.5 }, 30);
    expect(d[0]).toBeCloseTo(1.5 / 30, 10);
    expect(d[1]! - d[0]!).toBeCloseTo(2 / 30, 10);
    expect(d.every((v) => v >= 0 && v < 1)).toBe(true);
    expect(downbeats({ bpm: null, firstBeatSec: 1 }, 30)).toEqual([]);
    expect(downbeats({ bpm: 120, firstBeatSec: 1 }, null)).toEqual([]);
  });

  it('shows the clock as m:ss', () => {
    expect(deckClock(83.9)).toBe('1:23');
    expect(deckClock(-2)).toBe('0:00');
  });
});

describe('when a deck\'s track counts as played', () => {
  it('sends nothing for a track never heard', () => {
    expect(releaseEvent({ started: false, heardSec: 0, reachedEnd: true, durationSec: 200 })).toBeNull();
  });
  it('completes at its end or once half was heard; else a skip (the server applies half / four minutes, 30 s for scrobbles)', () => {
    expect(releaseEvent({ started: true, heardSec: 20, reachedEnd: true, durationSec: 200 })).toBe('completed');
    expect(releaseEvent({ started: true, heardSec: 100, reachedEnd: false, durationSec: 200 })).toBe('completed');
    expect(releaseEvent({ started: true, heardSec: 99, reachedEnd: false, durationSec: 200 })).toBe('skipped');
    expect(releaseEvent({ started: true, heardSec: 300, reachedEnd: false, durationSec: null })).toBe('skipped');
  });
});

describe('the deck effects, as values', () => {
  it('maps the filter knob: centre off, left a low-pass, right a high-pass', () => {
    expect(filterOf(0)).toEqual({ kind: 'off' });
    expect(filterOf(0.02)).toEqual({ kind: 'off' });
    const lp = filterOf(-1);
    const hp = filterOf(1);
    expect(lp.kind).toBe('lowpass');
    expect(hp.kind).toBe('highpass');
    if (lp.kind !== 'off') expect(lp.hz).toBeCloseTo(200, 6);
    if (hp.kind !== 'off') expect(hp.hz).toBeCloseTo(8000, 6);
    const half = filterOf(-0.5);
    if (half.kind !== 'off') expect(half.hz).toBeCloseTo(2000, 6);
    expect(filterText(0)).toBe('Off');
    expect(filterText(-0.5)).toBe('LP 2.0 kHz');
    expect(filterText(0.3)).toMatch(/^HP \d+ Hz$/);
  });

  it('kills a band at −40 dB, whatever its knob says', () => {
    const s = { ...FX_DEFAULTS, eq: { low: 6, mid: -3, high: 0 }, kills: { low: true, mid: false, high: false } };
    expect(bandDb(s, 'low')).toBe(KILL_DB);
    expect(bandDb(s, 'mid')).toBe(-3);
    expect(dbText(6)).toBe('+6 dB');
    expect(dbText(-3)).toBe('−3 dB');
    expect(dbText(0)).toBe('0 dB');
  });
});

describe('Auto mix', () => {
  it('plans Auto, beat-aligned, the incoming track at the outgoing tempo, easing back after', () => {
    const out = facts({ bpm: 120 });
    const inc = facts({ localTrackId: 'u', bpm: 123, durationSec: 40, trimEndSec: 37.5 });
    const p = planAuto(out, inc, 1, 1)!;
    expect(p.beatAligned).toBe(true);
    expect(p.rateIn).toBeCloseTo(120 / 123, 6);
    expect(p.rampSec).toBeCloseTo((32 * 60) / 123, 6);
    // the fade ends where the outgoing sound ends, starts on its beat
    expect(p.startSec + p.lengthSec).toBeCloseTo(27.5, 6);
    expect(((p.startSec - 1.5) / 0.5) % 1).toBeCloseTo(0, 6);
    expect(p.inAtSec).toBeCloseTo(1.5, 6);
  });

  it('takes the outgoing deck\'s pitch into the tempo it matches', () => {
    const p = planAuto(facts({ bpm: 120 }), facts({ localTrackId: 'u', bpm: 120 }), 1.04, 1)!;
    expect(p.rateIn).toBeCloseTo(1.04, 6);
  });

  it('leaves a tempo too far apart as it is', () => {
    const p = planAuto(facts({ bpm: 120 }), facts({ localTrackId: 'u', bpm: 140 }), 1, 1.01)!;
    expect(p.rateIn).toBe(1.01);
    expect(p.rampSec).toBe(0);
  });
});
