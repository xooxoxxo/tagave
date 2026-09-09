import { describe, expect, it } from 'vitest';
import { uniqueGenres } from './albumPresentation';
describe('album genre presentation', () => {
  it('merges local and provider tags without case or whitespace duplicates', () => {
    expect(uniqueGenres(['Metal', 'math rock'], [' metal ', 'Math Rock', 'Hardcore'], undefined)).toEqual(['Metal', 'math rock', 'Hardcore']);
  });
  it('omits blank values and accepts missing sources', () => {
    expect(uniqueGenres(undefined, ['', '  '])).toEqual([]);
  });
});
