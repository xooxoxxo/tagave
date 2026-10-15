import { describe, expect, it } from 'vitest';
import { migrateStorageKey } from './renamedStorageKey';

function memoryStorage(init: Record<string, string> = {}) {
  const data = new Map(Object.entries(init));
  return {
    data,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => { data.set(k, v); },
    removeItem: (k: string) => { data.delete(k); },
  };
}

describe('migrateStorageKey', () => {
  it('moves the old value to the new key and deletes the old key', () => {
    const s = memoryStorage({ 'liner.x': '{"a":1}' });
    migrateStorageKey(s, 'liner.x', 'tagave.x');
    expect(Object.fromEntries(s.data)).toEqual({ 'tagave.x': '{"a":1}' });
  });

  it('keeps a value already under the new key and still drops the old one', () => {
    const s = memoryStorage({ 'liner.x': 'old', 'tagave.x': 'new' });
    migrateStorageKey(s, 'liner.x', 'tagave.x');
    expect(Object.fromEntries(s.data)).toEqual({ 'tagave.x': 'new' });
  });

  it('does nothing without an old value, and twice is the same as once', () => {
    const s = memoryStorage({ 'tagave.x': 'v' });
    migrateStorageKey(s, 'liner.x', 'tagave.x');
    migrateStorageKey(s, 'liner.x', 'tagave.x');
    expect(Object.fromEntries(s.data)).toEqual({ 'tagave.x': 'v' });
  });

  it('survives storage that throws', () => {
    const blocked = { getItem: () => { throw new Error('blocked'); }, setItem: () => {}, removeItem: () => {} };
    expect(() => migrateStorageKey(blocked, 'liner.x', 'tagave.x')).not.toThrow();
  });
});
