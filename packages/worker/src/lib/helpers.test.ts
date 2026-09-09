import { describe, expect, it } from 'vitest';
import {
  clusterKey, clusterScopeKey, clusterSingletonKey, discDirNumber, discTokenOfFolder,
  extractYear, extOf, filenameDiscPrefix, filenameDiscPrefixesApply, isAudioFile, normKey,
  relBasename, relDirname, sidecarKind, storagePath, stripDiscTokenFromTitle, tagsDigest,
  titleFromName, trackNoFromName,
  tagDiscsPlausible,
} from './helpers.js';

describe('discDirNumber', () => {
  it('recognises disc directory spellings', () => {
    expect(discDirNumber('CD1')).toBe(1);
    expect(discDirNumber('CD 2')).toBe(2);
    expect(discDirNumber('cd_3')).toBe(3);
    expect(discDirNumber('Disc 1')).toBe(1);
    expect(discDirNumber('Disk2')).toBe(2);
    expect(discDirNumber('Vol. 4')).toBe(4);
    expect(discDirNumber('Volume 2')).toBe(2);
  });
  it('rejects non-disc names', () => {
    expect(discDirNumber('Discography')).toBeNull();
    expect(discDirNumber('CDN edge mixes')).toBeNull();
    expect(discDirNumber('2004 - Album')).toBeNull();
    expect(discDirNumber('cd')).toBeNull();
  });
});

describe('discTokenOfFolder', () => {
  it('splits a trailing disc token off an album folder name', () => {
    expect(discTokenOfFolder('Album CD1')).toEqual({ title: 'Album', disc: 1, kind: 'disc' });
    expect(discTokenOfFolder('Album (Disc 2)')).toEqual({ title: 'Album', disc: 2, kind: 'disc' });
    expect(discTokenOfFolder('Album - Disc 2')).toEqual({ title: 'Album', disc: 2, kind: 'disc' });
    expect(discTokenOfFolder('Album [CD 2]')).toEqual({ title: 'Album', disc: 2, kind: 'disc' });
    expect(discTokenOfFolder('Album Vol. 2')).toEqual({ title: 'Album', disc: 2, kind: 'vol' });
    expect(discTokenOfFolder('2009 - Album CD2')).toEqual({ title: '2009 - Album', disc: 2, kind: 'disc' });
  });
  it('keeps the rest of a decorated title', () => {
    expect(discTokenOfFolder('Manala (Deluxe Edition) CD2')?.title).toBe('Manala (Deluxe Edition)');
    expect(discTokenOfFolder('Doomain Limited Edition 2 CDs CD 1')?.title).toBe('Doomain Limited Edition 2 CDs');
    expect(discTokenOfFolder('A Smooth Transition (From Trip Hop to Nu Jazz) Disc1')?.disc).toBe(1);
  });
  it('tolerates an unclosed bracket (real folder names drop it)', () => {
    expect(discTokenOfFolder('The Life & Times Of Laddio Bolocko (Disc 2'))
      .toEqual({ title: 'The Life & Times Of Laddio Bolocko', disc: 2, kind: 'disc' });
  });
  it('rejects names without a disc token', () => {
    expect(discTokenOfFolder('Album 2')).toBeNull();
    expect(discTokenOfFolder('CD Project')).toBeNull();
    expect(discTokenOfFolder('Disco Inferno')).toBeNull();
    expect(discTokenOfFolder('Volume One')).toBeNull();
  });
  it('rejects a bare disc directory (discDirNumber owns those)', () => {
    expect(discTokenOfFolder('CD1')).toBeNull();
    expect(discTokenOfFolder('Disc 2')).toBeNull();
    expect(discTokenOfFolder('Vol. 4')).toBeNull();
  });
});

describe('filenameDiscPrefix', () => {
  it('parses n-tt prefixes', () => {
    expect(filenameDiscPrefix('2-01 Title.flac')).toEqual({ disc: 2, track: 1 });
    expect(filenameDiscPrefix('1.03 x.mp3')).toEqual({ disc: 1, track: 3 });
    expect(filenameDiscPrefix('2_11 x.flac')).toEqual({ disc: 2, track: 11 });
    expect(filenameDiscPrefix('10-01 - Make Me Know It.mp3')).toEqual({ disc: 10, track: 1 });
  });
  it('rejects plain track numbers and years', () => {
    expect(filenameDiscPrefix('201 x.flac')).toBeNull();
    expect(filenameDiscPrefix('01 - x.flac')).toBeNull();
    expect(filenameDiscPrefix('1969 - x.flac')).toBeNull();
    expect(filenameDiscPrefix('x.flac')).toBeNull();
    expect(filenameDiscPrefix('0-01 x.flac')).toBeNull();
    expect(filenameDiscPrefix('2-011 x.flac')).toBeNull();
  });
});

describe('filenameDiscPrefixesApply', () => {
  const names = (...items: Array<[number, number]>) =>
    items.map(([d, t]) => `${d}-${String(t).padStart(2, '0')} - Song.mp3`);
  const run = (...items: Array<[number, number]>) => filenameDiscPrefixesApply(names(...items));
  const range = (disc: number, from: number, to: number): Array<[number, number]> =>
    Array.from({ length: to - from + 1 }, (_, i) => [disc, from + i] as [number, number]);

  it('accepts a real two-disc set numbered per disc', () => {
    // 1-01..1-12 + 2-01..2-08
    expect(run(...range(1, 1, 12), ...range(2, 1, 8))).toBe(true);
  });

  it('accepts a set whose disc 1 carries no prefix at all', () => {
    // prod: Steve Hackett "Genesis Revisited" — 01..09, 2-01..2-08, 3-01..3-02
    expect(filenameDiscPrefixesApply([
      '01 - Watcher Of The Skies.mp3', '02 - The Chamber Of 32 Doors.mp3',
      ...names(...range(2, 1, 8), ...range(3, 1, 2)),
    ])).toBe(true);
  });

  it('rejects the "n-nn" naming where the leading number repeats the track', () => {
    // prod: A/Angels & Airwaves/2006 - We Don't Need To Whisper. Ten tracks of
    // one album; the old rule read them as ten one-track discs.
    expect(filenameDiscPrefixesApply([
      '01 - Valkyrie Missle.mp3',
      '2-02 - Distraction.mp3', '3-03 - Do It For Me Now.mp3', '4-04 - The Adventure.mp3',
      "5-05 - A Little's Enough.mp3", '6-06 - The War.mp3', '7-07 - The Gift.mp3',
      '8-08 - It Hurts.mp3', '9-09 - Good Day.mp3', '10-10 - Start The Machine.mp3',
    ])).toBe(false);
  });

  it('rejects a single-disc album numbered continuously across fake discs', () => {
    // prod: B/Burial/2007 - Burial — 01, 02, 2-03, 2-04, 3-05 … 4-11.
    expect(filenameDiscPrefixesApply([
      '01 - Wounder.mp3', '02 - U Hurt Me.mp3',
      ...names([2, 3], [2, 4], [3, 5], [3, 6], [3, 7], [4, 8], [4, 9], [4, 10], [4, 11]),
    ])).toBe(false);
  });

  it('rejects one file per disc number', () => {
    // prod: V/VA/2007 - Hotel Costes Le Coffret Anniversaire — "n-01" x 10.
    expect(run(...Array.from({ length: 9 }, (_, i) => [i + 2, 1] as [number, number]))).toBe(false);
  });

  it('rejects disc numbers above the plausible ceiling', () => {
    expect(run(...range(1, 1, 5), ...range(21, 1, 5))).toBe(false);
    expect(run(...range(1, 1, 5), ...range(20, 1, 5))).toBe(true);
  });

  it('rejects a set too small to tell from track numbering', () => {
    // "1-01, 1-02, 2-01, 2-02": half the files have disc === track, which is
    // exactly the shape the "n-nn" rip produces. The documented boundary —
    // a real two-disc set is longer than two tracks a side, and one that is
    // not falls back to the disk.no tag like every other undecidable case.
    expect(run([1, 1], [1, 2], [2, 1], [2, 2])).toBe(false);
    expect(run([1, 1], [1, 2], [1, 3], [2, 1], [2, 2])).toBe(true);
  });

  it('needs two distinct disc numbers', () => {
    expect(run(...range(2, 1, 6))).toBe(false);
    expect(filenameDiscPrefixesApply(['01 - a.mp3', '02 - b.mp3'])).toBe(false);
    expect(filenameDiscPrefixesApply([])).toBe(false);
  });
});

describe('stripDiscTokenFromTitle', () => {
  it('strips only the unambiguous cd/disc/disk spellings', () => {
    expect(stripDiscTokenFromTitle('Final Fantasy VI Original Sound Version [Disc 1]'))
      .toBe('Final Fantasy VI Original Sound Version');
    expect(stripDiscTokenFromTitle('Final Fantasy VI Original Sound Version CD2'))
      .toBe('Final Fantasy VI Original Sound Version');
    expect(stripDiscTokenFromTitle('Matrix Reloaded (Disc 2)')).toBe('Matrix Reloaded');
    expect(stripDiscTokenFromTitle('Mixtape Vol. 2')).toBe('Mixtape Vol. 2');
    expect(stripDiscTokenFromTitle('Kid A')).toBe('Kid A');
    expect(stripDiscTokenFromTitle('Disc 2')).toBe('Disc 2');
  });
});

describe('clusterScopeKey', () => {
  it('collapses a bare disc subdir onto its parent', () => {
    expect(clusterScopeKey('T/Tool/Salival/CD1')).toBe('T/Tool/Salival');
    expect(clusterScopeKey('T/Tool/Salival/CD2')).toBe('T/Tool/Salival');
  });
  it('collapses "… CD1"/"… CD2" siblings onto one key', () => {
    const a = clusterScopeKey('R/Rammstein/2009 - Liebe ist fur alle da CD1');
    const b = clusterScopeKey('R/Rammstein/2009 - Liebe ist fur alle da CD2');
    expect(a).toBe(b);
    expect(a).not.toBe(clusterScopeKey('R/Rammstein/2009 - Something Else CD1'));
  });
  it('keeps "Vol. n" siblings apart — each is its own album', () => {
    expect(clusterScopeKey('W/White Fence/2012 - Family Perfume Vol. 1'))
      .not.toBe(clusterScopeKey('W/White Fence/2012 - Family Perfume Vol. 2'));
  });
  it('leaves an ordinary album folder alone', () => {
    expect(clusterScopeKey('A/Artist/2004 - Album')).toBe('A/Artist/2004 - Album');
    expect(clusterScopeKey('')).toBe('');
  });
  it('keys the cluster.dir singleton on the scope, not the directory', () => {
    expect(clusterSingletonKey('root', 'X/Album CD1')).toBe(clusterSingletonKey('root', 'X/Album CD2'));
    expect(clusterSingletonKey('root', 'X/Album CD1')).not.toBe(clusterSingletonKey('other', 'X/Album CD2'));
  });
});

describe('extractYear', () => {
  it('finds release years', () => {
    expect(extractYear('2004 - Rubber Factory')).toBe(2004);
    expect(extractYear('Album (1972) [FLAC]')).toBe(1972);
    expect(extractYear('best of 99')).toBeNull();
    expect(extractYear(null)).toBeNull();
  });
});

describe('trackNoFromName / titleFromName', () => {
  it('parses common prefixes', () => {
    expect(trackNoFromName('01 - Foo.mp3')).toBe(1);
    expect(trackNoFromName('12. Bar.flac')).toBe(12);
    expect(trackNoFromName('3_baz.ogg')).toBe(3);
    expect(trackNoFromName('Foo.mp3')).toBeNull();
  });
  it('derives titles without the prefix', () => {
    expect(titleFromName('01 - Foo.mp3')).toBe('Foo');
    expect(titleFromName('Foo Bar.flac')).toBe('Foo Bar');
  });
  it('reads the track number out of an n-tt prefix', () => {
    expect(trackNoFromName('2-01 Title.flac')).toBe(2); // legacy parser, disc-blind
    expect(filenameDiscPrefix('2-01 Title.flac')?.track).toBe(1);
    expect(titleFromName('2-01 Title.flac')).toBe('Title');
    expect(titleFromName('2-07 - Anesthetize.mp3')).toBe('Anesthetize');
  });
});

describe('normKey and storagePath', () => {
  it('collapses NFC/NFD spellings of the same name', () => {
    const nfc = 'Ainulindalë';
    const nfd = 'Ainulindalë';
    expect(normKey(nfc)).toBe(normKey(nfd));
    expect(storagePath(nfd)).toBe(nfc);
  });
  it('collapses case (volume is case-insensitive)', () => {
    expect(normKey('The Album')).toBe(normKey('the album'));
  });
});

describe('clusterKey', () => {
  it('is deterministic and dir-order independent', () => {
    const a = clusterKey('lib1', ['X/CD1', 'X/CD2'], 'album', 'artist');
    const b = clusterKey('lib1', ['X/CD2', 'X/CD1'], 'album', 'artist');
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{40}$/);
  });
  it('changes when identity changes', () => {
    const a = clusterKey('lib1', ['X'], 'album', 'artist');
    expect(clusterKey('lib1', ['X'], 'album2', 'artist')).not.toBe(a);
    expect(clusterKey('lib1', ['Y'], 'album', 'artist')).not.toBe(a);
    expect(clusterKey('lib2', ['X'], 'album', 'artist')).not.toBe(a);
  });
  it('normalizes NFD dir spellings into the same key', () => {
    const a = clusterKey('lib1', ['Ainulindalë'], 'x', 'y');
    const b = clusterKey('lib1', ['Ainulindalë'], 'x', 'y');
    expect(a).toBe(b);
  });
});

describe('file classification', () => {
  it('classifies audio and sidecars', () => {
    expect(isAudioFile('a.FLAC')).toBe(true);
    expect(isAudioFile('a.dsf')).toBe(true);
    expect(isAudioFile('a.jpg')).toBe(false);
    expect(sidecarKind('cover.jpg')).toBe('image');
    expect(sidecarKind('album.cue')).toBe('cue');
    expect(sidecarKind('rip.log')).toBe('log');
    expect(sidecarKind('info.nfo')).toBe('text');
    expect(sidecarKind('a.flac')).toBeNull();
    expect(extOf('noext')).toBe('');
  });
});

describe('tagsDigest', () => {
  it('is key-order independent', () => {
    expect(tagsDigest({ a: 1, b: [2, 3] })).toBe(tagsDigest({ b: [2, 3], a: 1 }));
    expect(tagsDigest({ a: 1 })).not.toBe(tagsDigest({ a: 2 }));
  });
});

describe('rel path helpers', () => {
  it('splits rel paths', () => {
    expect(relDirname('A/B/c.mp3')).toBe('A/B');
    expect(relDirname('c.mp3')).toBe('');
    expect(relBasename('A/B/c.mp3')).toBe('c.mp3');
  });
});

describe('tagDiscsPlausible', () => {
  it('rejects disk.no that repeats each file\'s track number (Angels & Airwaves shape)', () => {
    const entries = Array.from({ length: 10 }, (_, i) => ({ disc: i + 1, track: i + 1 }));
    expect(tagDiscsPlausible(entries)).toBe(false);
  });
  it('accepts a real two-disc tag set', () => {
    const entries = [
      ...Array.from({ length: 12 }, (_, i) => ({ disc: 1, track: i + 1 })),
      ...Array.from({ length: 8 }, (_, i) => ({ disc: 2, track: i + 1 })),
    ];
    expect(tagDiscsPlausible(entries)).toBe(true);
  });
  it('is neutral when only one disc value or none appears', () => {
    expect(tagDiscsPlausible([{ disc: 1, track: 1 }, { disc: 1, track: 2 }])).toBe(true);
    expect(tagDiscsPlausible([{ disc: null, track: 1 }])).toBe(true);
  });
  it('rejects absurd values and one-file discs', () => {
    expect(tagDiscsPlausible([{ disc: 1, track: 1 }, { disc: 99, track: 2 }, { disc: 1, track: 3 }])).toBe(false);
    expect(tagDiscsPlausible([{ disc: 1, track: 5 }, { disc: 2, track: 7 }, { disc: 3, track: 9 }])).toBe(false);
  });
});
