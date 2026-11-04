/**
 * Where the equalizer glow may read the music: only where a suspended audio
 * context can never silence it.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BANDS, HIGH_HZ, LOW_HZ, analyserAllowed, bandEdges, bandReader, binRanges, canCapture, isMobile } from './levels';

const IPHONE = { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)', platform: 'iPhone', maxTouchPoints: 5 };
const IPAD_AS_MAC = { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', platform: 'MacIntel', maxTouchPoints: 5 };
const ANDROID = { userAgent: 'Mozilla/5.0 (Linux; Android 15; Pixel 9) Chrome/140.0.0.0 Mobile Safari/537.36', platform: 'Linux armv8l', maxTouchPoints: 5 };
const FIREFOX_ANDROID = { userAgent: 'Mozilla/5.0 (Android 15; Mobile; rv:140.0) Gecko/140.0 Firefox/140.0', platform: 'Linux armv8l', maxTouchPoints: 5 };
const MAC = { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Safari/605.1.15', platform: 'MacIntel', maxTouchPoints: 0 };

function env(nav: object, capture: boolean) {
  vi.stubGlobal('navigator', nav);
  vi.stubGlobal('AudioContext', class {});
  vi.stubGlobal('HTMLMediaElement', capture ? class { captureStream() { return null; } } : class {});
}

afterEach(() => { vi.unstubAllGlobals(); });

describe('analyserAllowed', () => {
  it.each([
    ['Chrome on Android (reads a copy)', ANDROID, true, true],
    ['Firefox on Android (would have to route the music)', FIREFOX_ANDROID, false, false],
    ['iPhone, even with captureStream', IPHONE, true, false],
    ['iPad that says Mac', IPAD_AS_MAC, false, false],
    ['desktop Safari (routes, resumed when stopped)', MAC, false, true],
    ['desktop Chrome', MAC, true, true],
  ])('%s', (_name, nav, capture, allowed) => {
    env(nav, capture);
    expect(analyserAllowed()).toBe(allowed);
  });

  it('never without Web Audio', () => {
    env(MAC, true);
    vi.stubGlobal('AudioContext', undefined);
    expect(analyserAllowed()).toBe(false);
  });
});

describe('isMobile and canCapture', () => {
  it('tells phones from desktops', () => {
    expect(isMobile(ANDROID)).toBe(true);
    expect(isMobile(FIREFOX_ANDROID)).toBe(true);
    expect(isMobile(IPHONE)).toBe(true);
    expect(isMobile(MAC)).toBe(false);
  });

  it('looks for an unprefixed captureStream (Firefox\'s mozCaptureStream takes the sound off the speakers)', () => {
    expect(canCapture({ captureStream: () => null } as unknown as HTMLMediaElement)).toBe(true);
    expect(canCapture({ mozCaptureStream: () => null } as unknown as HTMLMediaElement)).toBe(false);
  });
});

describe('bands', () => {
  it('BANDS log-spaced from 40 Hz to 14 kHz', () => {
    const e = bandEdges();
    expect(e).toHaveLength(BANDS + 1);
    expect(e[0]).toBeCloseTo(LOW_HZ);
    expect(e[BANDS]).toBeCloseTo(HIGH_HZ);
    const r = e[1]! / e[0]!;
    for (let i = 1; i < BANDS; i++) expect(e[i + 1]! / e[i]!).toBeCloseTo(r, 6);
  });

  it('every band has bins of its own, in order', () => {
    const ranges = binRanges(bandEdges(), 48000 / 4096, 2048);
    for (let i = 0; i < ranges.length; i++) {
      const [a, b] = ranges[i]!;
      expect(b).toBeGreaterThan(a);
      if (i) expect(a).toBeGreaterThanOrEqual(ranges[i - 1]![1]);
    }
  });

  /** an analyser whose spectrum is quiet but for one loud frequency */
  const tone = (hz: number | null) => {
    const sampleRate = 48000, fftSize = 4096;
    return {
      fftSize, frequencyBinCount: fftSize / 2, context: { sampleRate },
      getFloatFrequencyData(out: Float32Array) {
        for (let k = 0; k < out.length; k++) out[k] = hz === null ? -Infinity : Math.abs(k * sampleRate / fftSize - hz) < 30 ? -12 : -90;
      },
    };
  };

  it('a bass note lights the low bands, a cymbal the high ones, silence nothing', () => {
    const out = new Float32Array(BANDS);
    bandReader(tone(60))(out);
    expect(Math.max(...out.slice(0, 6))).toBeGreaterThan(0.8);
    expect(Math.max(...out.slice(20))).toBe(0);
    bandReader(tone(9000))(out);
    expect(Math.max(...out.slice(26))).toBeGreaterThan(0.8);
    expect(Math.max(...out.slice(0, 20))).toBe(0);
    bandReader(tone(null))(out);
    expect(Math.max(...out)).toBe(0);
  });
});
