/**
 * The shared contract for a match a decision model made: the albums list and
 * its query know the `model` match kind, while the album's match info keeps
 * its two-value `decidedBy` (a model's decision is the system's).
 */
import { describe, it, expect } from 'vitest';
import { albumSummarySchema, albumsQuerySchema, matchInfoSchema } from '@tagave/shared';

describe('match kind contract: model', () => {
  it('match info of a model match parses with decidedBy system (the enum gains nothing)', () => {
    const info = {
      releaseId: '0f5e6a49-5d2b-4f2a-8a3e-1d6f0c0a2b11',
      releaseGroupId: '2a7b9c3d-1e4f-4a5b-9c6d-7e8f9a0b1c2d',
      title: 'Kosmonument',
      artistCredit: 'Oranssi Pazuzu',
      status: 'auto',
      decidedBy: 'system',
      distance: 0.05,
      reason: 'model accept: jev-2026-09-15, probability 0.9940',
    };
    expect(matchInfoSchema.parse(info)).toEqual(info);
    expect(() => matchInfoSchema.parse({ ...info, decidedBy: 'model' })).toThrow();
  });

  it('the albums query and album summary accept the model match kind', () => {
    expect(albumsQuerySchema.shape.decided.parse('model')).toBe('model');
    expect(albumSummarySchema.shape.matchKind.parse('model')).toBe('model');
  });
});
