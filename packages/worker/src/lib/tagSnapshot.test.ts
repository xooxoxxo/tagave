import { describe, it, expect } from 'vitest';
import type { IAudioMetadata } from 'music-metadata';
import { noNul, tagSnapshotOf } from './tagSnapshot.js';

describe('tagSnapshotOf strips NUL everywhere Postgres would reject it', () => {
  it('drops \\u0000 from values, object keys, native tag types and frame ids', () => {
    const meta = {
      common: { title: 'So\u0000ng', 'odd\u0000key': 'v', nested: { 'k\u0000': ['a\u0000'] } },
      native: { 'vorbis\u0000': [{ id: 'TI\u0000TLE', value: { 'x\u0000': 'y\u0000' } }] },
      format: {},
    } as unknown as IAudioMetadata;
    const snap = tagSnapshotOf(meta);
    expect(JSON.stringify(snap)).not.toContain('\\u0000');
    expect(snap.common).toEqual({ title: 'Song', oddkey: 'v', nested: { k: ['a'] } });
    expect(snap.native).toEqual({ vorbis: [{ id: 'TITLE', value: { x: 'y' } }] });
  });

  it('noNul keeps null and strips strings', () => {
    expect(noNul('FL\u0000AC')).toBe('FLAC');
    expect(noNul(undefined)).toBeNull();
  });
});
