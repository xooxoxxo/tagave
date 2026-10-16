import { describe, expect, it } from 'vitest';
import {
  A_HDR, A_REST, B_HDR, B_REST, B_TOP, HEADER,
  albumRail, albumSummary, caretPath, countryName, fillerCentres, fillerDots, fillerHeight, paintFiller, rippleField, type FillerContext, flowState, formatLine, formatReleased, seededRandom, shortFormat, wantsFiller,
} from './albumFlow';
import type { DetailTrack } from './albumDetailTypes';

/* The phone geometry of the approved prototype: cover 72..418, names at 438, TRACKLIST at 798. */
const geo = { coverBottom: 418, namesTop: 438, tlTop: 798 };
const dockAt = geo.namesTop - HEADER;

describe('album flow: scroll progress', () => {
  it('at rest nothing has moved', () => {
    const s = flowState(0, geo);
    expect(s.coverOpacity).toBe(1);
    expect(s.nameProgress).toBe(0);
    expect(s.artistScale).toBe(1);
    expect(s.albumScale).toBe(1);
    expect(s.albumShift).toBe(0);
    expect(s.docked).toBe(false);
    expect(s.caretProgress).toBe(0);
  });

  it('the cover fades in place and is fully gone as its bottom passes the header', () => {
    const fadeEnd = geo.coverBottom - HEADER;
    expect(flowState(fadeEnd / 2, geo).coverOpacity).toBeCloseTo(0.5, 5);
    expect(flowState(fadeEnd, geo).coverOpacity).toBe(0);
    expect(flowState(fadeEnd + 200, geo).coverOpacity).toBe(0);
  });

  it('the lines shrink gradually and reach header size exactly as the artist line meets the header', () => {
    const half = flowState(dockAt / 2, geo);
    expect(half.artistScale).toBeCloseTo((1 + A_HDR / A_REST) / 2, 5);
    expect(half.docked).toBe(false);
    const just = flowState(dockAt - 1, geo);
    expect(just.docked).toBe(false);
    expect(just.artistScale).toBeGreaterThan(A_HDR / A_REST);
    const at = flowState(dockAt, geo);
    expect(at.docked).toBe(true);
    expect(at.artistScale * A_REST).toBeCloseTo(13, 5);
    expect(at.albumScale * B_REST).toBeCloseTo(17, 5);
    // the album line sits right under the shrunken artist line: 13px × 1.2 + 1
    expect(B_TOP + at.albumShift).toBeCloseTo(A_HDR * 1.2 + 1, 5);
    expect(B_HDR).toBe(17);
  });

  it('shrinking is monotonic and never overshoots', () => {
    let prev = flowState(0, geo);
    for (let y = 10; y <= dockAt + 100; y += 10) {
      const s = flowState(y, geo);
      expect(s.artistScale).toBeLessThanOrEqual(prev.artistScale);
      expect(s.artistScale).toBeGreaterThanOrEqual(A_HDR / A_REST - 1e-9);
      prev = s;
    }
  });

  it('the caret starts straightening on the first scroll and is flat when TRACKLIST sticks', () => {
    expect(flowState(1, geo).caretProgress).toBeGreaterThan(0);
    expect(caretPath(flowState(1, geo).caretProgress)).not.toBe(caretPath(0));
    const stuck = flowState(geo.tlTop - HEADER, geo).caretProgress;
    expect(stuck).toBe(1);
    // flat: both ends at the dip's height, spanning the whole width
    expect(caretPath(1)).toBe('M0 8 L173 8 L346 8');
    expect(caretPath(0)).toBe('M103 4 L173 12 L243 4');
  });

  it('a degenerate geometry never divides by zero', () => {
    const s = flowState(10, { coverBottom: 0, namesTop: 0, tlTop: 0 });
    expect(Number.isFinite(s.coverOpacity)).toBe(true);
    expect(s.docked).toBe(true);
  });
});

describe('album flow: generative filler', () => {
  it('only albums with three tracks or fewer get it', () => {
    expect(wantsFiller(1)).toBe(true);
    expect(wantsFiller(3)).toBe(true);
    expect(wantsFiller(4)).toBe(false);
  });

  it('fills the screen under the stuck header and label, never under 320px', () => {
    expect(fillerHeight(844, 46, 58)).toBe(844 - 64 - 46 - 58);
    expect(fillerHeight(600, 46, 400)).toBe(320);
  });

  it('the same title gives the same piece; another title another', () => {
    const a = seededRandom('Shock Me');
    const b = seededRandom('Shock Me');
    const seqA = Array.from({ length: 8 }, a);
    expect(Array.from({ length: 8 }, b)).toEqual(seqA);
    expect(seqA.every((v) => v >= 0 && v < 1)).toBe(true);
    expect(Array.from({ length: 8 }, seededRandom('Shock Me!'))).not.toEqual(seqA);
    expect(fillerCentres('Shock Me', 346, 400)).toEqual(fillerCentres('Shock Me', 346, 400));
    expect(fillerDots('Shock Me', 120, 90)).toEqual(fillerDots('Shock Me', 120, 90));
    expect(fillerDots('Shock Me', 120, 90)).not.toEqual(fillerDots('In Absentia', 120, 90));
  });

  it('samples the field once and finds the same dots as reading it per level', () => {
    // the algorithm before the freeze hunt: the field evaluated again for each of the 7 levels
    const perLevel = (title: string, w: number, h: number) => {
      const centres = fillerCentres(title, w, h);
      const dots: Array<[number, number, number]> = [];
      for (let i = 0; i <= 6; i++) {
        const level = -0.6 + i * 0.2;
        const alpha = 0.10 + 0.22 * (1 - Math.abs(level) / 0.6);
        for (let y = 0; y < h; y += 3) {
          let prev = rippleField(centres, 0, y) - level;
          for (let x = 3; x < w; x += 3) {
            const v = rippleField(centres, x, y) - level;
            if ((v > 0) !== (prev > 0)) dots.push([x, y, alpha]);
            prev = v;
          }
        }
      }
      return dots;
    };
    for (const [title, w, h] of [['Shock Me', 346, 400], ['In Absentia', 1001, 322], ['', 2, 2], ['XX', 0, 0]] as const) {
      expect(fillerDots(title, w, h)).toEqual(perLevel(title, w, h));
    }
  });

  it('paints one path and one fill per contour level, not one per dot', () => {
    const calls = { fill: 0, arc: 0, beginPath: 0 };
    const g = {
      setTransform() {}, clearRect() {}, fillRect() {}, moveTo() {},
      beginPath() { calls.beginPath++; }, arc() { calls.arc++; }, fill() { calls.fill++; },
      createLinearGradient: () => ({ addColorStop() {} }),
      fillStyle: '', globalAlpha: 1, globalCompositeOperation: 'source-over',
    } as unknown as FillerContext;
    const dots = fillerDots('Shock Me', 800, 600);
    paintFiller(g, 800, 600, 2, 'Shock Me', '#276a82');
    expect(dots.length).toBeGreaterThan(1000);
    expect(calls.arc).toBe(dots.length);
    expect(calls.fill).toBe(calls.beginPath);
    expect(calls.fill).toBeLessThanOrEqual(7);
    expect(g.globalCompositeOperation).toBe('source-over');
  });

  it('3 to 5 ripple sources, inside the piece', () => {
    for (const title of ['XX', 'Shock Me', 'In Absentia', 'ÁÉÍ', '']) {
      const c = fillerCentres(title, 346, 400);
      expect(c.length).toBeGreaterThanOrEqual(3);
      expect(c.length).toBeLessThanOrEqual(5);
      for (const p of c) {
        expect(p.x).toBeGreaterThanOrEqual(346 * 0.15);
        expect(p.x).toBeLessThanOrEqual(346 * 0.85);
        expect(p.y).toBeGreaterThanOrEqual(400 * 0.25);
        expect(p.y).toBeLessThanOrEqual(400 * 0.85);
      }
    }
  });
});

const track = (over: Partial<DetailTrack['file']> = {}): DetailTrack => ({
  id: 't', discNo: 1, trackNo: 1, title: 'x', durationMs: 1000, origin: 'scan', cueStartMs: null, canonicalTitle: null, canonicalDurationMs: null,
  file: { relPath: 'a', codec: 'FLAC', lossless: true, bitrateKbps: null, sampleRate: 44100, bitDepth: 16, sizeBytes: 1, status: 'ok', ...over },
});

describe('album flow: the details', () => {
  it('dates read like the prototype', () => {
    expect(formatReleased('2002-09-24')).toBe('24 Sep 2002');
    expect(formatReleased('2002-09')).toBe('Sep 2002');
    expect(formatReleased('2002')).toBe('2002');
    expect(formatReleased(null, 1999)).toBe('1999');
    expect(formatReleased(null, null)).toBeNull();
  });

  it('countries by name', () => {
    expect(countryName('US')).toBe('United States');
    expect(countryName('XE')).toBe('Europe');
    expect(countryName('XW')).toBe('Worldwide');
    expect(countryName(null)).toBeNull();
  });

  it('the format line', () => {
    expect(formatLine([track(), track()], ['FLAC'])).toBe('FLAC · 16-bit / 44.1 kHz');
    expect(formatLine([track({ codec: 'MP3', lossless: false, bitrateKbps: 320 })], ['MP3'])).toBe('MP3 · 320 kbps');
    expect(formatLine([track(), track({ codec: 'MP3', lossless: false })], [])).toBe('FLAC · MP3');
    expect(formatLine([], ['FLAC'])).toBe('FLAC');
    expect(formatLine([], [])).toBeNull();
  });

  it('two quiet lines, each value whole', () => {
    const s = albumSummary({
      date: '2012-11-23', year: 2012, labels: [{ name: 'Frontiers Records', catno: 'FR CD 590' }], country: 'IT',
      totalDurationMs: 118 * 60000, trackCount: 22, discCount: 2, isCueImage: false, formats: ['mp3'],
      tracks: [track({ codec: 'MPEG 1 Layer 3', lossless: false, bitrateKbps: 320 })],
    });
    expect(s).toEqual({ when: ['2012', 'Frontiers Records'], what: ['1 hr 58 min', '22 tracks', '2 discs', 'MP3 320 kbps'] });
    const flac = albumSummary({
      date: null, year: 2002, labels: [{ name: 'A' }, { name: 'B' }, { name: 'C' }, { name: 'A' }], country: null,
      totalDurationMs: 68 * 60000, trackCount: 1, discCount: 1, isCueImage: true, formats: ['FLAC'], tracks: [track({ bitDepth: 24, sampleRate: 96000 })],
    });
    expect(flac).toEqual({ when: ['2002', 'A, B +1'], what: ['1 hr 8 min', '1 audio file', 'FLAC 24-bit/96 kHz'] });
    const bare = albumSummary({ date: null, year: null, labels: null, country: null, totalDurationMs: null, trackCount: 1, discCount: null, isCueImage: false, formats: [], tracks: [] });
    expect(bare).toEqual({ when: [], what: ['1 track'] });
  });

  it('short formats', () => {
    expect(shortFormat([], ['mp3'])).toBe('MP3');
    expect(shortFormat([track(), track({ codec: 'MPEG-4/AAC', lossless: false })], [])).toBe('FLAC / AAC');
    expect(shortFormat([track({ codec: 'Vorbis I', lossless: false, bitrateKbps: null })], [])).toBe('Vorbis');
  });
});

describe('album flow: the readout rail', () => {
  it('tracks | discs | minutes | format, the format split into codec and detail', () => {
    const rail = albumRail({ totalDurationMs: 118 * 60000, trackCount: 22, discCount: 2, isCueImage: false, formats: ['mp3'], tracks: [track({ codec: 'MPEG 1 Layer 3', lossless: false, bitrateKbps: 320 })] });
    expect(rail).toEqual([
      { key: 'tracks', value: '22', label: 'tracks' },
      { key: 'discs', value: '2', label: 'discs' },
      { key: 'minutes', value: '118', label: 'minutes' },
      { key: 'format', value: 'MP3', label: '320 kbps' },
    ]);
  });

  it('one disc has no discs cell; mixed codecs read as the format; a CUE image counts audio files', () => {
    const rail = albumRail({ totalDurationMs: null, trackCount: 1, discCount: 1, isCueImage: true, formats: [], tracks: [track(), track({ codec: 'MPEG-4/AAC', lossless: false })] });
    expect(rail).toEqual([{ key: 'tracks', value: '1', label: 'audio file' }, { key: 'format', value: 'FLAC / AAC', label: 'format' }]);
  });
});

describe('album flow: Play docks into the header (rule 8 amended)', () => {
  const withStrip = { ...geo, stripBottom: 640 };
  it('only once the header has docked and the strip has passed under it', () => {
    expect(flowState(dockAt, withStrip).playDocked).toBe(false);
    expect(flowState(withStrip.stripBottom - HEADER, withStrip).playDocked).toBe(false);
    expect(flowState(withStrip.stripBottom - HEADER + 1, withStrip).playDocked).toBe(true);
  });
  it('never without a strip', () => {
    expect(flowState(5000, geo).playDocked).toBe(false);
  });
});
