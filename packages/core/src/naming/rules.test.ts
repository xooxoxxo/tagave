import { describe, expect, it } from 'vitest';
import {
  DEFAULT_NAMING_RULES, PATH_MAX_BYTES, SEGMENT_MAX_BYTES, albumPaths, capPath, detectNaming, initialOf, isLeftAlone, namingValuesOf,
  ruleDir, ruleFileName, rulePath, rulesProblems, safeSegment, samePath, templateProblem,
  type NamingRules, type NamingSample, type NamingValues,
} from './rules.js';
import { currentFieldsFrom } from './currentFields.js';

const v = (o: Partial<NamingValues>): NamingValues => ({
  albumartist: null, artist: null, album: null, title: null, year: null, disc: null, discs: 1, track: null, ext: 'flac',
  compilation: false, soundtrack: false, ...o,
});

const bytes = (s: string) => new TextEncoder().encode(s).length;

/** The owner's library, sampled from prod (vault spec): each must round-trip exactly. */
const OWNER: Array<[string, NamingValues]> = [
  ['R/Ryuichi Sakamoto/2009 - Out Of Noise/07 - Firewater.mp3',
    v({ albumartist: 'Ryuichi Sakamoto', artist: 'Ryuichi Sakamoto', album: 'Out Of Noise', year: '2009-03-04', track: 7, title: 'Firewater', ext: 'mp3' })],
  ['P/The Peoples Republic Of Europe/2012 - Machine District/09 - Centurion.flac',
    v({ albumartist: 'The Peoples Republic Of Europe', album: 'Machine District', year: 2012, track: 9, title: 'Centurion' })],
  ['F/Fiona Apple/1999 - when the pawn/04 - love ridden.mp3',
    v({ albumartist: 'Fiona Apple', album: 'when the pawn', year: '1999', track: 4, title: 'love ridden', ext: 'mp3' })],
];

describe('naming rules: the owner\'s samples', () => {
  it.each(OWNER)('round-trips %s', (path, values) => {
    expect(rulePath(DEFAULT_NAMING_RULES, values).path).toBe(path);
  });

  it('detects the owner\'s pattern from those paths', () => {
    const samples: NamingSample[] = OWNER.map(([path, values]) => ({ path, values }));
    const d = detectNaming(samples);
    expect(d.detected).toBe(true);
    expect(d.rules.folder).toBe('{initial}/{albumartist}/[{year} - ]{album}');
    expect(d.rules.file).toBe('[{disc}-][{track:02} - ]{title}');
    expect(d.matched).toBe(3);
  });

  it('detects another library\'s pattern, or falls back to the default', () => {
    const samples: NamingSample[] = OWNER.map(([, values]) => ({
      path: `${values.albumartist}/${values.album}/${String(values.track).padStart(2, '0')}. ${values.title}.${values.ext}`, values,
    }));
    const d = detectNaming(samples);
    expect(d.rules.folder).toBe('{albumartist}/{album}');
    expect(d.rules.file).toBe('[{disc}-][{track:02}. ]{title}');
    expect(d.detected).toBe(true);
    const messy = detectNaming(OWNER.map(([, values], i) => ({ path: `dump${i}/x${i}.flac`, values })));
    expect(messy.detected).toBe(false);
    expect(messy.rules.folder).toBe(DEFAULT_NAMING_RULES.folder);
    expect(detectNaming([]).detected).toBe(false);
  });
});

describe('{initial}', () => {
  it.each([
    ['Fiona Apple', 'F'], ['The Peoples Republic Of Europe', 'P'], ['A Tribe Called Quest', 'T'], ['An Pierlé', 'P'],
    ['The The', 'T'], ['A-ha', 'A'], ['the national', 'N'], ['Ólafur Arnalds', 'O'], ['Æther Realm', 'A'], ['Øresund Space Collective', 'O'],
    ['Łona', 'L'], ['Ðorđe Balašević', 'D'], ['Björk', 'B'], ['Сплин', 'S'], ['Βαγγέλης', 'V'], ['坂本龍一', '_Other'],
    ['2Pac', '_Numeric'], ['10cc', '_Numeric'], ['!!!', '_Other'], ['...And You Will Know Us by the Trail of Dead', 'A'],
    ["'Til Tuesday", 'T'], ['', '_Other'], [null, '_Other'], ['   ', '_Other'], ['Ⅻ', '_Other'], ['ýmir', 'Y'],
  ])('%s → %s', (artist, initial) => {
    expect(initialOf(artist as string | null)).toBe(initial);
  });
});

describe('templates', () => {
  it('drops an optional part with an empty variable', () => {
    expect(ruleDir(DEFAULT_NAMING_RULES, v({ albumartist: 'Low', album: 'Things We Lost in the Fire' })).dir).toBe('L/Low/Things We Lost in the Fire');
    expect(ruleFileName(DEFAULT_NAMING_RULES, v({ title: 'Sunflower' }))).toBe('Sunflower.flac');
  });

  it('numbers discs only on a release of several', () => {
    const one = v({ albumartist: 'X', album: 'Y', disc: 1, discs: 1, track: 3, title: 'T' });
    const two = { ...one, disc: 2, discs: 2 };
    expect(ruleFileName(DEFAULT_NAMING_RULES, one)).toBe('03 - T.flac');
    expect(ruleFileName(DEFAULT_NAMING_RULES, two)).toBe('2-03 - T.flac');
    expect(rulePath(DEFAULT_NAMING_RULES, two).dir).toBe('X/X/Y');
  });

  it('pads numbers to their width and leaves text alone', () => {
    const rules: NamingRules = { ...DEFAULT_NAMING_RULES, file: '{track:03} {artist} - {title}' };
    expect(ruleFileName(rules, v({ track: 7, artist: 'Ab', title: 'Cd', ext: 'MP3' }))).toBe('007 Ab - Cd.mp3');
  });

  it('keeps {ext} where the template puts it', () => {
    const rules: NamingRules = { ...DEFAULT_NAMING_RULES, file: '{track:02}_{title}.{ext}' };
    expect(ruleFileName(rules, v({ track: 1, title: 'A', ext: 'ogg' }))).toBe('01_A.ogg');
  });

  it('falls back on required parts', () => {
    expect(rulePath(DEFAULT_NAMING_RULES, v({})).path).toBe('_Other/Unknown artist/Untitled/Untitled.flac');
    expect(rulePath(DEFAULT_NAMING_RULES, v({ artist: 'Solo', title: 'Song' })).path).toBe('S/Solo/Untitled/Song.flac');
  });

  it('says what is wrong with a template', () => {
    expect(templateProblem('{initial}/{albumartist}/{album}', 'folder')).toBeNull();
    expect(templateProblem('{albumartist}/{nope}', 'folder')).toBe('Unknown variable {nope}');
    expect(templateProblem('{albumartist}/{year', 'folder')).toMatch(/Unclosed \{/);
    expect(templateProblem('[{year} - {album}', 'folder')).toMatch(/Unclosed \[/);
    expect(templateProblem('[ - ]{album}', 'folder')).toBe('An optional part needs a variable');
    expect(templateProblem('{albumartist}//{album}', 'folder')).toMatch(/Empty folder/);
    expect(templateProblem('{albumartist}', 'folder')).toBe('Needs {album}');
    expect(templateProblem('{track}/{title}', 'file')).toBe('A file name cannot hold /');
    expect(templateProblem('{artist}', 'file')).toBe('Needs {title} or {track}');
    expect(templateProblem('', 'file')).toBe('Empty template');
    expect(rulesProblems(DEFAULT_NAMING_RULES)).toEqual({});
    expect(rulesProblems({ ...DEFAULT_NAMING_RULES, special: [{ when: 'soundtrack', folder: '{oops}' }, { when: 'compilation', folder: '' }] }))
      .toEqual({ 'special.0': 'Unknown variable {oops}' });
  });
});

describe('special rules', () => {
  const base = { albumartist: 'Various Artists', album: 'Ghost World', year: 2001, track: 1, title: 'Jaan Pechechan Ho' };
  it('sends a compilation to _Various Artists and a soundtrack to _OST', () => {
    expect(rulePath(DEFAULT_NAMING_RULES, v({ ...base, compilation: true })).path).toBe('_Various Artists/2001 - Ghost World/01 - Jaan Pechechan Ho.flac');
    expect(rulePath(DEFAULT_NAMING_RULES, v({ ...base, compilation: true, soundtrack: true })))
      .toMatchObject({ dir: '_OST/2001 - Ghost World', rule: 'soundtrack' });
  });
  it('is off when its folder is empty', () => {
    const rules: NamingRules = { ...DEFAULT_NAMING_RULES, special: [{ when: 'soundtrack', folder: '' }, { when: 'compilation', folder: '' }] };
    expect(rulePath(rules, v({ ...base, compilation: true, soundtrack: true })).dir).toBe('V/Various Artists/2001 - Ghost World');
  });
});

describe('safe names', () => {
  it('strips what Windows and SMB refuse, keeps the case', () => {
    expect(safeSegment('AC/DC: Live? <at> "Donington" | * \\')).toBe('AC DC Live at Donington');
    expect(safeSegment('Tab\there\u0007bell')).toBe('Tab here bell');
    expect(safeSegment('Trailing dots...  ')).toBe('Trailing dots');
    expect(safeSegment('...hidden')).toBe('hidden');
    expect(safeSegment('when the pawn')).toBe('when the pawn');
    expect(safeSegment('   ')).toBe('Untitled');
  });

  it('is NFC', () => {
    const nfd = 'Björk';
    expect(safeSegment(nfd)).toBe('Björk'.normalize('NFC'));
    expect(rulePath(DEFAULT_NAMING_RULES, v({ albumartist: nfd, album: 'Début', title: 'x' })).path).toBe('B/Björk/Début/x.flac'.normalize('NFC'));
  });

  it('caps a part at 200 bytes on a character boundary', () => {
    const long = 'ü'.repeat(150); // 300 bytes
    const s = safeSegment(long);
    expect(bytes(s)).toBeLessThanOrEqual(SEGMENT_MAX_BYTES);
    expect(s).toBe('ü'.repeat(100));
    const name = ruleFileName(DEFAULT_NAMING_RULES, v({ title: 'a'.repeat(400), track: 1 }));
    expect(bytes(name)).toBeLessThanOrEqual(SEGMENT_MAX_BYTES);
    expect(name.endsWith('.flac')).toBe(true);
  });

  it('caps a whole path at 1024 bytes, longest part first, extension kept', () => {
    const parts = capPath(['a'.repeat(200), 'b'.repeat(200), 'c'.repeat(200), 'd'.repeat(200), 'e'.repeat(200), 'f'.repeat(200)], '.flac');
    expect(bytes(parts.join('/')) + 5).toBeLessThanOrEqual(PATH_MAX_BYTES);
    const rules: NamingRules = { ...DEFAULT_NAMING_RULES, folder: '{albumartist}/{album}/{album}/{album}/{album}/{album}' };
    const p = rulePath(rules, v({ albumartist: 'x'.repeat(190), album: 'y'.repeat(190), title: 'z'.repeat(190), track: 1 }));
    expect(bytes(p.path)).toBeLessThanOrEqual(PATH_MAX_BYTES);
    expect(p.path.endsWith('.flac')).toBe(true);
  });
});

describe('leave alone', () => {
  it.each([
    ['# UNSORTED #/a/b.mp3', true], ['## HQ ##/Artist/Album/01.flac', true], ['#SOUNDCLOUD/x.mp3', true],
    ['_duplicates/Artist/a.flac', true], ['R/Ryuichi Sakamoto/2009 - Out Of Noise/07 - Firewater.mp3', false],
    ['_Various Artists/2001 - X/01.flac', false], ['A/#hash in album/01.flac', true], ['#top-level-file.mp3', false],
  ])('%s → %s', (p, alone) => {
    expect(isLeftAlone(p, ['#', '_duplicates'])).toBe(alone);
  });
  it('touches everything with an empty list', () => {
    expect(isLeftAlone('#x/y.mp3', [])).toBe(false);
    expect(isLeftAlone('#x/y.mp3', ['  '])).toBe(false);
  });
});

describe('an album at once', () => {
  const f = (relPath: string, fields: Record<string, string>) => ({ relPath, fields });
  it('puts every file in one folder and numbers discs on all of them', () => {
    const out = albumPaths(DEFAULT_NAMING_RULES, [
      f('Dream Theater - Octavarium/01.flac', { albumartist: 'Dream Theater', album: 'Octavarium', date: '2005', tracknumber: '1', discnumber: '1', title: 'The Root of All Evil' }),
      f('Dream Theater - Octavarium/CD2/01.flac', { albumartist: 'Dream Theater', album: 'Octavarium', date: '2005', tracknumber: '1', discnumber: '2', title: 'Sacrificed Sons' }),
      // a stray file whose album artist differs still lands with the others
      f('Dream Theater - Octavarium/CD2/02.flac', { albumartist: 'DT', album: 'Octavarium', date: '2005', tracknumber: '2', discnumber: '2', title: 'Octavarium' }),
    ]);
    expect(out.dir).toBe('D/Dream Theater/2005 - Octavarium');
    expect(out.files.map((x) => x.toPath)).toEqual([
      'D/Dream Theater/2005 - Octavarium/1-01 - The Root of All Evil.flac',
      'D/Dream Theater/2005 - Octavarium/2-01 - Sacrificed Sons.flac',
      'D/Dream Theater/2005 - Octavarium/2-02 - Octavarium.flac',
    ]);
    expect(out.leftAlone).toBe(false);
  });
  it('takes the compilation flag of most files, and the soundtrack type of the release group', () => {
    const files = [f('x/1.mp3', { albumartist: 'Various Artists', album: 'Mix', tracknumber: '1', title: 'a' }), f('x/2.mp3', { albumartist: 'Various Artists', album: 'Mix', tracknumber: '2', title: 'b' })];
    expect(albumPaths(DEFAULT_NAMING_RULES, files).dir).toBe('_Various Artists/Mix');
    expect(albumPaths(DEFAULT_NAMING_RULES, files, { soundtrack: true })).toMatchObject({ dir: '_OST/Mix', rule: 'soundtrack' });
  });
  it('says when a file is left alone', () => {
    expect(albumPaths(DEFAULT_NAMING_RULES, [f('## HQ ##/a/1.flac', { album: 'A', title: 't' })]).leftAlone).toBe(true);
  });
});

describe('values from tags', () => {
  it('reads canonical fields', () => {
    const fields = currentFieldsFrom({ common: {
      albumartist: 'The Peoples Republic Of Europe', album: 'Machine District', title: 'Centurion', artist: 'TPROE',
      track: { no: 9, of: 10 }, disk: { no: 1, of: 2 }, date: '2012-05-01', originalyear: 2011, releasetype: ['album', 'soundtrack'],
    } });
    const values = namingValuesOf(fields, '.FLAC');
    expect(values).toMatchObject({ track: 9, disc: 1, discs: 2, year: '2011', ext: 'FLAC', soundtrack: true, compilation: false });
    expect(rulePath(DEFAULT_NAMING_RULES, values).path).toBe('_OST/2011 - Machine District/1-09 - Centurion.flac');
  });
  it('knows a compilation by its flag or its album artist', () => {
    expect(namingValuesOf({ compilation: '1', albumartist: 'Someone' }, 'mp3').compilation).toBe(true);
    expect(namingValuesOf({ albumartist: 'Various Artists' }, 'mp3').compilation).toBe(true);
    expect(namingValuesOf({ albumartist: 'VA' }, 'mp3').compilation).toBe(true);
    expect(namingValuesOf({ albumartist: 'Vanilla Fudge' }, 'mp3').compilation).toBe(false);
    expect(namingValuesOf({ tracknumber: '3/12' }, 'mp3').track).toBe(3);
    expect(namingValuesOf({ discnumber: '2' }, 'mp3', { discs: 3 }).discs).toBe(3);
  });
  it('compares paths as the share does', () => {
    expect(samePath('F/Fiona Apple/x.mp3', 'f/fiona apple/X.mp3')).toBe(true);
    expect(samePath('B/Björk', 'b/björk')).toBe(true);
    expect(samePath('a/b', 'a/c')).toBe(false);
  });
});
