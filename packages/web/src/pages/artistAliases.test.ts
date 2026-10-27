import { describe, expect, it } from 'vitest';
import { shownAliases } from './artistAliases';

describe('shownAliases', () => {
  it('drops the name itself and spellings that differ only in case, spaces or punctuation (QA Q-29)', () => {
    expect(shownAliases('Aphex Twin', ['Aphex Twin', 'Aphex Twins', 'AphexTwin', 'The Aphex Twin', 'aphex+twin', 'エイフェックス・ツイン']))
      .toEqual(['Aphex Twins', 'The Aphex Twin', 'エイフェックス・ツイン']);
  });

  it('keeps one of two aliases that differ only that way', () => {
    expect(shownAliases('Björk', ['Bjork', 'bjork', 'Björk Guðmundsdóttir'])).toEqual(['Bjork', 'Björk Guðmundsdóttir']);
  });
});
