import { describe, it, expect } from 'vitest';
import { normalizeString, compareStrings, stringDistance, jaroWinklerDistance, tokenSetRatio, scriptAwareDistance } from './normalize.js';

describe('normalizeString keeps letters in every script', () => {
  it('keeps Latin letters and folds their accents', () => {
    expect(normalizeString('Café Tacvba')).toBe('cafe tacvba');
    expect(normalizeString('Sigur Rós — Ágætis byrjun')).toBe('sigur ros agaetis byrjun');
  });

  it('keeps a decomposed accent the same as the composed one', () => {
    expect(normalizeString('Café')).toBe(normalizeString('Café'));
  });

  it('folds German ß and umlauts', () => {
    expect(normalizeString('Stück')).toBe('stuck');
    expect(normalizeString('Straße')).toBe('strasse');
    expect(normalizeString('Liebe ist für alle da')).toBe('liebe ist fur alle da');
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

  it('an accented title equals its unaccented form', () => {
    expect(stringDistance('Café', 'Cafe')).toBe(0);
  });
});

describe('the lower-level similarities fold the same compatibility forms', () => {
  it('jaroWinklerDistance and tokenSetRatio see full-width as plain', () => {
    expect(jaroWinklerDistance('ＡＢＣ', 'abc')).toBe(1);
    expect(tokenSetRatio('ＡＢＣ ｄｅｆ', 'abc def')).toBe(1);
  });
});

describe('accents on Latin letters are folded', () => {
  it('a Latin letter with an accent equals the bare letter', () => {
    expect(normalizeString('Regö Rejtem')).toBe(normalizeString('Regő rejtem'));
    expect(normalizeString('Chyliñska')).toBe(normalizeString('Chylińska'));
    expect(normalizeString('Gymnopédies')).toBe('gymnopedies');
    expect(stringDistance('Saint Germain des Pres', 'Saint Germain des Prés')).toBe(0);
  });

  it('Turkish dotted and dotless i read as i', () => {
    expect(normalizeString('İstavrit')).toBe('istavrit');
    expect(normalizeString('Sapık İnek')).toBe('sapik inek');
  });

  it('folds the Latin letters that have no decomposition', () => {
    expect(normalizeString('Mørket')).toBe('morket');
    expect(normalizeString('Zła')).toBe('zla');
    expect(normalizeString('Đorđe')).toBe('dorde');
    expect(normalizeString('Straße')).toBe('strasse');
    expect(normalizeString('Ærøskøbing')).toBe('aeroskobing');
    expect(normalizeString('Œuvre')).toBe('oeuvre');
    expect(normalizeString('ƒIN')).toBe('fin');
  });

  it('a spacing accent or a trademark sign does not split or lengthen a word', () => {
    expect(stringDistance('Journey´s Greatest hits', "Journey's Greatest Hits")).toBe(0);
    expect(stringDistance('God Of War™', 'God of War')).toBe(0);
  });

  it('does not fold the voiced mark of a kana', () => {
    expect(normalizeString('が')).toBe('が');
    expect(normalizeString('が')).not.toBe(normalizeString('か'));
    expect(stringDistance('がっこう', 'かっこう')).toBeGreaterThan(0);
  });

  it('does not fold the marks of a Cyrillic letter', () => {
    expect(normalizeString('й')).not.toBe(normalizeString('и'));
  });
});

describe('scriptAwareDistance: a script the other text does not use says nothing', () => {
  it('two different CJK titles are still apart', () => {
    expect(scriptAwareDistance('残酷な天使のテーゼ', '魂のルフラン')).toBeGreaterThan(0);
    expect(scriptAwareDistance('月亮代表我的心', '甜蜜蜜')).toBeGreaterThan(0);
  });

  it('two Cyrillic titles still compare', () => {
    expect(scriptAwareDistance('Группа крови', 'Звезда по имени Солнце')).toBeGreaterThan(0.3);
    expect(scriptAwareDistance('Тлеющий Мир', 'Тлеющий мир')).toBe(0);
  });

  it('a Latin text against a Cyrillic one is neutral: judged as the old normaliser judged it', () => {
    // Cyrillic read with the wrong code page is Latin letters; the old normaliser kept nothing of either
    expect(scriptAwareDistance('Ïàäåíèå Ðîäà', 'Падение Рода')).toBe(0);
    expect(scriptAwareDistance('Ïëà÷ Òèøèíû 2', 'Плач тишины 2')).toBe(0);
    // a plain-ASCII name against a Cyrillic one: nothing in common, as before
    expect(scriptAwareDistance('Gedonist', 'Гедонист')).toBe(1);
    // the new folding is not applied across scripts: accented Latin keeps no ASCII letter
    expect(scriptAwareDistance('Ýïîõà', 'Эпоха')).toBe(0);
  });

  it('two texts sharing every script compare normally', () => {
    expect(scriptAwareDistance('秋吉久美子 (Kumiko Akiyoshi)', '秋吉久美子 [Kumiko Akiyoshi]')).toBe(0);
    expect(scriptAwareDistance('秋吉久美子 (Kumiko Akiyoshi)', '中森明菜 (Akina Nakamori)')).toBeGreaterThan(0.3);
  });

  it('within the scripts both share, the rest still compares', () => {
    expect(scriptAwareDistance('Tania Saleh', 'تانيا صالح = Tania Saleh')).toBe(0);
    expect(scriptAwareDistance('Πρόλογος (Prologos)', 'Prologos')).toBe(0);
    expect(scriptAwareDistance('Salwa', 'عالمية = Alamieh')).toBeGreaterThan(0.3);
  });

  it('a text without letters compares as before', () => {
    expect(scriptAwareDistance('05', '05')).toBe(0);
    expect(scriptAwareDistance('1', 'Один')).toBe(1);
    expect(scriptAwareDistance('', 'Gedonist')).toBe(1);
  });

  it('plain stringDistance still keeps scripts apart', () => {
    expect(stringDistance('Gedonist', 'Гедонист')).toBeGreaterThan(0.5);
  });
});
