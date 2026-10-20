import { describe, expect, it } from 'vitest';
import { docsUrl } from './docs';

describe('docsUrl', () => {
  it('maps a docs file and anchor to tagave.app/docs', () => {
    expect(docsUrl('install.md#play-your-music-optional-player')).toBe('https://tagave.app/docs/install/#play-your-music-optional-player');
    expect(docsUrl('operations.md#restore-a-backup')).toBe('https://tagave.app/docs/operations/#restore-a-backup');
  });

  it('maps a file without an anchor to its page', () => {
    expect(docsUrl('tag-correction.md')).toBe('https://tagave.app/docs/tag-correction/');
  });
});
