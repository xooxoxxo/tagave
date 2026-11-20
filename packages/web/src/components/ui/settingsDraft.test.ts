import { describe, expect, it } from 'vitest';
import { changedKeys, rebaseDraft } from './settingsDraft';

describe('rebaseDraft', () => {
  const before = { url: 'http://music.example.com', key: 'abc', port: '4533' };
  const after = { url: 'http://music.example.org', key: 'def', port: '4534' };

  it('a field left alone takes the new saved value', () => {
    expect(rebaseDraft({ ...before }, before, after)).toEqual(after);
  });

  it('a field the person changed stays', () => {
    expect(rebaseDraft({ ...before, url: 'http://typed.example.com' }, before, after)).toEqual({ ...after, url: 'http://typed.example.com' });
  });
});

describe('changedKeys', () => {
  it('changed lists only the edited keys', () => {
    const saved = { name: 'Robin', email: 'robin@example.com', tags: ['a'] };
    expect(changedKeys(saved, saved)).toEqual([]);
    expect(changedKeys({ ...saved, name: 'Rob' }, saved)).toEqual(['name']);
    expect(changedKeys({ ...saved, tags: ['a'] }, saved)).toEqual([]);
    expect(changedKeys({ ...saved, tags: ['a', 'b'] }, saved)).toEqual(['tags']);
  });
});
