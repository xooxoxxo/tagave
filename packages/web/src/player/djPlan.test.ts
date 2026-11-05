/** The DJ module's Simple mode planning (djPlan.ts). */
import { describe, expect, it } from 'vitest';
import { DJ_DEFAULTS, type DjSimpleSettings, type DjTrackInfo } from '@tagave/shared';
import {
  beatGrid, equalPower, equalPowerFrom, expectedIncoming, isAlbumSequence, lockRate, parseDjSettings, planTransition, preloadAtSec, rampRate, snapToBeat, trackFacts,
  type DjTrackFacts,
} from './djPlan';

const facts = (over: Partial<DjTrackFacts> = {}): DjTrackFacts => ({
  localTrackId: 't', durationSec: 200, bpm: null, bpmConfidence: null, firstBeatSec: null, trimStartSec: null, trimEndSec: null,
  albumKey: null, discNo: null, trackNo: null, ...over,
});
const settings = (over: Partial<DjSimpleSettings> = {}): DjSimpleSettings => ({ ...DJ_DEFAULTS, crossfade: 'fixed', ...over });
const fade = (t: ReturnType<typeof planTransition>) => {
  if (t.kind !== 'fade') throw new Error(`expected a fade, got ${t.kind} (${t.reason})`);
  return t;
};

describe('parseDjSettings', () => {
  it('fills in the defaults and clamps the length', () => {
    expect(parseDjSettings(null)).toEqual(DJ_DEFAULTS);
    expect(parseDjSettings({ crossfade: 'auto', lengthSec: 40 })).toEqual({ ...DJ_DEFAULTS, crossfade: 'auto', lengthSec: 12 });
    expect(parseDjSettings({ crossfade: 'loud', lengthSec: 0.4, beatAligned: 'yes', gaplessAlbums: false })).toEqual({ ...DJ_DEFAULTS, lengthSec: 2, gaplessAlbums: false });
  });
  it('defaults to Off with gapless albums on', () => {
    expect(DJ_DEFAULTS.crossfade).toBe('off');
    expect(DJ_DEFAULTS.gaplessAlbums).toBe(true);
  });
});

describe('trackFacts', () => {
  const q = { localTrackId: 'a', albumId: 'alb', discNo: 1, trackNo: 3, durationMs: 180_000 };
  it('takes the queue facts without the analysis', () => {
    expect(trackFacts(q, null)).toMatchObject({ durationSec: 180, albumKey: 'alb', discNo: 1, trackNo: 3, bpm: null, trimEndSec: null });
  });
  it('lays the analysis over them, in seconds', () => {
    const info: DjTrackInfo = { localTrackId: 'a', bpm: 124, bpmConfidence: 0.9, firstBeatMs: 250, trimStartMs: 1200, trimEndMs: 176_500, durationMs: 180_100, albumKey: 'k', trackNo: 3, discNo: 1 };
    expect(trackFacts(q, info)).toMatchObject({ durationSec: 180.1, bpm: 124, firstBeatSec: 0.25, trimStartSec: 1.2, trimEndSec: 176.5, albumKey: 'k' });
  });
  it('prefers the element\'s own length (the original file)', () => {
    expect(trackFacts(q, null, 181.25).durationSec).toBe(181.25);
    expect(trackFacts(q, null, Number.NaN).durationSec).toBe(180);
  });
});

describe('snapToBeat and beatGrid', () => {
  it('moves a time onto the grid', () => {
    expect(snapToBeat(10.2, 0.5, 0.5, 1)).toBeCloseTo(10.5);
    expect(snapToBeat(10.2, 0.5, 0.5, -1)).toBeCloseTo(10);
    expect(snapToBeat(10.2, 0.5, 0.5, 0)).toBeCloseTo(10);
    expect(snapToBeat(10.5, 0.5, 0.5, 1)).toBeCloseTo(10.5);
    expect(snapToBeat(0, 0.3, 0.5, 1)).toBeCloseTo(0.3);
  });
  it('trusts only a plausible, confident tempo with a first beat', () => {
    expect(beatGrid(facts({ bpm: 120, firstBeatSec: 0.1 }))).toEqual({ firstBeat: 0.1, period: 0.5 });
    expect(beatGrid(facts({ bpm: 120, firstBeatSec: null }))).toBeNull();
    expect(beatGrid(facts({ bpm: 120, firstBeatSec: 0, bpmConfidence: 0.2 }))).toBeNull();
    expect(beatGrid(facts({ bpm: 12, firstBeatSec: 0 }))).toBeNull();
  });
});

describe('isAlbumSequence', () => {
  const a = facts({ albumKey: 'x', discNo: 1, trackNo: 4 });
  it('the next track of the album, or the first of the next disc', () => {
    expect(isAlbumSequence(a, facts({ albumKey: 'x', discNo: 1, trackNo: 5 }))).toBe(true);
    expect(isAlbumSequence(a, facts({ albumKey: 'x', discNo: 2, trackNo: 1 }))).toBe(true);
    expect(isAlbumSequence(facts({ albumKey: 'x', trackNo: 1 }), facts({ albumKey: 'x', trackNo: 2 }))).toBe(true);
  });
  it('not a jump, another album, or unknown numbers', () => {
    expect(isAlbumSequence(a, facts({ albumKey: 'x', discNo: 1, trackNo: 7 }))).toBe(false);
    expect(isAlbumSequence(a, facts({ albumKey: 'y', discNo: 1, trackNo: 5 }))).toBe(false);
    expect(isAlbumSequence(a, facts({ albumKey: 'x', discNo: 1, trackNo: null }))).toBe(false);
    expect(isAlbumSequence(facts({ trackNo: 1 }), facts({ trackNo: 2 }))).toBe(false);
  });
});

describe('planTransition', () => {
  it('Off: today\'s handoff', () => {
    expect(planTransition(facts(), facts(), settings({ crossfade: 'off' }))).toEqual({ kind: 'cut', reason: 'off' });
  });

  it('Fixed: the last L seconds, the next from its start', () => {
    const t = fade(planTransition(facts({ durationSec: 200 }), facts(), settings({ lengthSec: 8 })));
    expect(t).toMatchObject({ startSec: 192, lengthSec: 8, inAtSec: 0, beatAligned: false, rateIn: 1, rampSec: 0, fallback: false });
  });

  it('gapless albums: consecutive tracks of one album never fade (and do when it is off)', () => {
    const out = facts({ albumKey: 'x', trackNo: 1 });
    const inc = facts({ albumKey: 'x', trackNo: 2 });
    expect(planTransition(out, inc, settings())).toEqual({ kind: 'cut', reason: 'gapless' });
    expect(planTransition(out, inc, settings({ gaplessAlbums: false })).kind).toBe('fade');
    expect(planTransition(out, facts({ albumKey: 'x', trackNo: 3 }), settings()).kind).toBe('fade');
  });

  it('Auto: ends where the sound ends, comes in where it starts, 16 beats long', () => {
    const out = facts({ durationSec: 200, trimEndSec: 196, bpm: 128, firstBeatSec: 0.2 });
    const inc = facts({ trimStartSec: 1.5 });
    const t = fade(planTransition(out, inc, settings({ crossfade: 'auto' })));
    expect(t.lengthSec).toBeCloseTo(7.5);
    expect(t.startSec).toBeCloseTo(188.5);
    expect(t.inAtSec).toBe(1.5);
  });

  it('Auto: 4–10 s whatever the tempo', () => {
    const slow = fade(planTransition(facts({ trimEndSec: 190, bpm: 60, firstBeatSec: 0 }), facts(), settings({ crossfade: 'auto' })));
    const fast = fade(planTransition(facts({ trimEndSec: 190, bpm: 240, firstBeatSec: 0 }), facts(), settings({ crossfade: 'auto' })));
    expect(slow.lengthSec).toBe(10);
    expect(fast.lengthSec).toBe(4);
  });

  it('Auto without the analysis: Fixed 6 s, and beat alignment left out', () => {
    const t = fade(planTransition(facts({ durationSec: 200, bpm: 120, firstBeatSec: 0 }), facts({ bpm: 120, firstBeatSec: 0 }), settings({ crossfade: 'auto', beatAligned: true })));
    expect(t).toMatchObject({ startSec: 194, lengthSec: 6, inAtSec: 0, fallback: true, beatAligned: false, rateIn: 1 });
  });

  it('Auto with the trim but no tempo: 6 s at the trim', () => {
    const t = fade(planTransition(facts({ trimEndSec: 150 }), facts({ trimStartSec: 0.8 }), settings({ crossfade: 'auto' })));
    expect(t).toMatchObject({ startSec: 144, lengthSec: 6, inAtSec: 0.8, fallback: false });
  });

  it('Beat-aligned: the fade starts on an outgoing beat and the next comes in on its own', () => {
    const out = facts({ durationSec: 200, trimEndSec: 197.1, bpm: 120, firstBeatSec: 0.3 });
    const inc = facts({ trimStartSec: 0.9, bpm: 150, firstBeatSec: 0.25 });
    const t = fade(planTransition(out, inc, settings({ crossfade: 'auto', beatAligned: true })));
    expect(t.beatAligned).toBe(true);
    // on the outgoing grid (0.3 + n·0.5), ending at the sound's end
    expect(((t.startSec - 0.3) / 0.5) % 1).toBeCloseTo(0, 6);
    expect(t.startSec + t.lengthSec).toBeCloseTo(197.1);
    // the first incoming beat at or after its sound starts (0.25 + n·0.4)
    expect(t.inAtSec).toBeCloseTo(1.05);
    // 150 against 120 is 25 % off: no tempo change
    expect(t.rateIn).toBe(1);
    expect(t.rampSec).toBe(0);
  });

  it('Beat-aligned, Fixed: L rounds to whole beats', () => {
    const t = fade(planTransition(facts({ durationSec: 100, bpm: 120, firstBeatSec: 0 }), facts({ bpm: 120, firstBeatSec: 0.1 }), settings({ lengthSec: 5, beatAligned: true })));
    expect(t.startSec).toBeCloseTo(95);
    expect(t.lengthSec).toBeCloseTo(5);
    expect(t.inAtSec).toBeCloseTo(0.1);
  });

  it('tempo transitions: within ±8 % the next comes in at the outgoing tempo and eases back over 8 bars', () => {
    const out = facts({ bpm: 124, firstBeatSec: 0 });
    const inc = facts({ bpm: 120, firstBeatSec: 0 });
    const t = fade(planTransition(out, inc, settings({ beatAligned: true })));
    expect(t.rateIn).toBeCloseTo(124 / 120);
    expect(t.rampSec).toBeCloseTo(32 * 0.5);
  });

  it('tempo transitions: beyond ±8 % (or without Beat-aligned) the tempo stays', () => {
    const out = facts({ bpm: 132, firstBeatSec: 0 });
    const inc = facts({ bpm: 120, firstBeatSec: 0 });
    expect(fade(planTransition(out, inc, settings({ beatAligned: true }))).rateIn).toBe(1);
    expect(fade(planTransition(facts({ bpm: 124, firstBeatSec: 0 }), inc, settings())).rateIn).toBe(1);
  });

  it('a short track: the fade takes at most half of it', () => {
    const t = fade(planTransition(facts({ durationSec: 8 }), facts({ durationSec: 100 }), settings({ lengthSec: 12 })));
    expect(t.lengthSec).toBe(4);
    expect(t.startSec).toBe(4);
    expect(planTransition(facts({ durationSec: 1.5 }), facts(), settings()).kind).toBe('cut');
    expect(fade(planTransition(facts({ durationSec: 200 }), facts({ durationSec: 6 }), settings({ lengthSec: 12 }))).lengthSec).toBe(3);
  });

  it('an unknown length: today\'s handoff', () => {
    expect(planTransition(facts({ durationSec: null }), facts(), settings())).toEqual({ kind: 'cut', reason: 'unknown' });
  });
});

describe('preloadAtSec', () => {
  it('at least L + 30 s before the fade, or 30 s before the end', () => {
    expect(preloadAtSec({ kind: 'fade', startSec: 192, lengthSec: 8, inAtSec: 0, beatAligned: false, rateIn: 1, rampSec: 0, fallback: false }, 200)).toBe(154);
    expect(preloadAtSec({ kind: 'cut', reason: 'gapless' }, 200)).toBe(170);
    expect(preloadAtSec({ kind: 'fade', startSec: 20, lengthSec: 10, inAtSec: 0, beatAligned: false, rateIn: 1, rampSec: 0, fallback: false }, 30)).toBe(0);
  });
});

describe('curves and rates', () => {
  it('equal power: the powers always sum to 1', () => {
    const up = equalPower(64, true);
    const down = equalPower(64, false);
    expect(up[0]).toBe(0);
    expect(down[0]).toBe(1);
    expect(up[63]).toBeCloseTo(1);
    expect(down[63]).toBeCloseTo(0);
    for (let i = 0; i < 64; i++) expect(up[i]! ** 2 + down[i]! ** 2).toBeCloseTo(1, 5);
  });
  it('a fade that starts late picks up mid-curve', () => {
    const late = equalPowerFrom(5, true, 0.5);
    expect(late[0]).toBeCloseTo(Math.sin(Math.PI / 4));
    expect(late[4]).toBeCloseTo(1);
  });
  it('the incoming track follows the outgoing one\'s clock', () => {
    expect(expectedIncoming(100, 100, 1.2, 1)).toBeCloseTo(1.2);
    expect(expectedIncoming(102, 100, 1.2, 1.05)).toBeCloseTo(1.2 + 2.1);
    expect(expectedIncoming(102, 100, 0, 1, 2)).toBeCloseTo(1);
  });
  it('the lock pulls an incoming track that is ahead back, within its slew', () => {
    expect(lockRate(0.001, 1.03, 0.1)).toBe(1.03);
    expect(lockRate(0.025, 1, 0.15)).toBeCloseTo(0.9);
    expect(lockRate(-0.5, 1, 0.15)).toBeCloseTo(1.15);
    expect(lockRate(0.5, 1, 0.01)).toBeCloseTo(0.99);
  });
  it('the ramp eases from the matched rate back to 1', () => {
    expect(rampRate(1.04, 0)).toBeCloseTo(1.04);
    expect(rampRate(1.04, 0.5)).toBeCloseTo(1.02);
    expect(rampRate(1.04, 1)).toBe(1);
    expect(rampRate(0.95, 2)).toBe(1);
  });
});
