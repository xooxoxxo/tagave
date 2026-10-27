import { describe, it, expect } from 'vitest';
import { normalizeString, compareStrings, stringDistance, jaroWinklerDistance, tokenSetRatio } from './normalize.js';

describe('normalizeString keeps letters in every script', () => {
  it('keeps Latin letters with accents as they are (no accent folding)', () => {
    expect(normalizeString('Café Tacvba')).toBe('café tacvba');
    expect(normalizeString('Sigur Rós — Ágætis byrjun')).toBe('sigur rós ágætis byrjun');
  });

  it('keeps a decomposed accent the same as the composed one', () => {
    expect(normalizeString('Café')).toBe(normalizeString('Café'));
  });

  it('keeps German ß and umlauts', () => {
    expect(normalizeString('Stück')).toBe('stück');
    expect(normalizeString('Straße')).toBe('straße');
    expect(normalizeString('Liebe ist für alle da')).toBe('liebe ist für alle da');
  });

  it('keeps Japanese, including voiced kana marks', () => {
    expect(normalizeString('残酷な天使のテーゼ')).toBe('残酷な天使のテーゼ');
    expect(normalizeString('がっこう')).not.toBe(normalizeString('かっこう'));
  });

  it('keeps Chinese', () => {
    expect(normalizeString('月亮代表我的心')).toBe('月亮代表我的心');
  });

  it('keeps and lowercases Cyrillic', () => {
    expect(normalizeString('Кино — Группа крови')).toBe('кино группа крови');
  });

  it('folds full-width and half-width forms', () => {
    expect(normalizeString('ＭＵＳＩＣ　１２３')).toBe('music 123');
    expect(normalizeString('ﾃｰｾﾞ')).toBe('テーゼ');
  });

  it('strips emoji and punctuation, including the emoji variation selector', () => {
    expect(normalizeString('Love ❤️ Song!!! 🎵')).toBe('love song');
    expect(normalizeString('«Hello», (world)?')).toBe('hello world');
    expect(normalizeString('❤️')).toBe('');
  });

  it('still drops a leading English article', () => {
    expect(normalizeString('The Wall')).toBe('wall');
  });
});

describe('stringDistance across scripts', () => {
  it('two different CJK titles are not a match', () => {
    expect(stringDistance('残酷な天使のテーゼ', '魂のルフラン')).toBeGreaterThan(0);
    expect(stringDistance('月亮代表我的心', '甜蜜蜜')).toBeGreaterThan(0);
    expect(compareStrings('月亮代表我的心', '甜蜜蜜')).toBe(false);
  });

  it('two equal CJK titles are a match', () => {
    expect(stringDistance('残酷な天使のテーゼ', '残酷な天使のテーゼ')).toBe(0);
    expect(stringDistance('月亮代表我的心', '月亮代表我的心')).toBe(0);
  });

  it('two different Cyrillic titles are not a match', () => {
    expect(stringDistance('Группа крови', 'Звезда по имени Солнце')).toBeGreaterThan(0);
  });

  it('a full-width title matches its plain form', () => {
    expect(stringDistance('ＭＵＳＩＣ', 'Music')).toBe(0);
  });

  it('an accented title is close to, but not equal to, its unaccented form', () => {
    const d = stringDistance('Café', 'Cafe');
    expect(d).toBeGreaterThan(0);
    expect(d).toBeLessThan(0.5);
  });
});

describe('the lower-level similarities fold the same compatibility forms', () => {
  it('jaroWinklerDistance and tokenSetRatio see full-width as plain', () => {
    expect(jaroWinklerDistance('ＡＢＣ', 'abc')).toBe(1);
    expect(tokenSetRatio('ＡＢＣ ｄｅｆ', 'abc def')).toBe(1);
  });
});
