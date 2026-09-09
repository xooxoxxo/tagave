import { describe, expect, it } from 'vitest';
import {
  clusterKey, discDirNumber, discTokenOfFolder, extractYear, extOf,
  filenameDiscPrefix, isAudioFile, normKey,
  relBasename, relDirname, sidecarKind, storagePath, tagsDigest,
  titleFromName, trackNoFromName,
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
