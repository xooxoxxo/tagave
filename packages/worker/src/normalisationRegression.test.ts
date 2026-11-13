import { describe, it, expect } from 'vitest';
import { stringDistance } from '@tagave/core';
import { LEGACY_TEXT, legacyNormalizeTitle, scriptBucket } from './normalisationRegression.js';

describe('the old normaliser, as it was', () => {
  it('deleted every non-ASCII letter', () => {
    expect(LEGACY_TEXT.normalizeString('Stück')).toBe('stck');
    expect(LEGACY_TEXT.normalizeString('夜明けの歌')).toBe('');
    expect(LEGACY_TEXT.normalizeString('Звезда')).toBe('');
    expect(legacyNormalizeTitle('The Wall!')).toBe('wall');
  });
  it('so two different Japanese titles compared equal; the current one tells them apart', () => {
    expect(LEGACY_TEXT.stringDistance('夜明けの歌', '星空の街')).toBe(0);
    expect(stringDistance('夜明けの歌', '星空の街')).toBeGreaterThan(0.5);
  });
});

describe('scriptBucket', () => {
  it('buckets by the letters of the text', () => {
    expect(scriptBucket('Abbey Road')).toBe('latin-ascii');
    expect(scriptBucket('Stück')).toBe('latin-accented');
    expect(scriptBucket('Ｍｕｓｉｃ')).toBe('latin-accented');
    expect(scriptBucket('夜明けの歌')).toBe('cjk');
    expect(scriptBucket('スーパー')).toBe('cjk');
    expect(scriptBucket('안녕')).toBe('cjk');
    expect(scriptBucket('Звезда')).toBe('cyrillic');
    expect(scriptBucket('Ελλάδα')).toBe('other');
    expect(scriptBucket('東京 Tokyo')).toBe('mixed');
  });
  it('a text with no letters is ASCII or other', () => {
    expect(scriptBucket('1999')).toBe('latin-ascii');
    expect(scriptBucket('')).toBe('latin-ascii');
    expect(scriptBucket(null)).toBe('latin-ascii');
    expect(scriptBucket('★')).toBe('other');
  });
});
