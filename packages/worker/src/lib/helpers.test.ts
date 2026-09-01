import { describe, expect, it } from 'vitest';
import {
  clusterKey, discDirNumber, extractYear, extOf, isAudioFile, normKey,
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
