import { describe, it, expect } from 'vitest';
import { pairingOf } from './planPairing';

const track = (over: Partial<{ position: number | null; mediumNo: number | null; media: number; title: string }> = {}) => ({
  position: 1, mediumNo: 1, media: 1, title: 'Clouds', lengthMs: 368_000, ...over,
});

describe('pairingOf', () => {
  it('reads position, title and confidence', () => {
    expect(pairingOf({ releaseTrack: track(), matchDistance: 0.02 })).toMatchObject({ text: '1 · Clouds · 98%', confidence: 98, low: false });
  });

  it('adds the disc only on a release with several media', () => {
    expect(pairingOf({ releaseTrack: track({ mediumNo: 2, position: 3, media: 2 }), matchDistance: 0 })!.text).toBe('2-3 · Clouds · 100%');
  });

  it('marks a pairing below 70% as low', () => {
    expect(pairingOf({ releaseTrack: track(), matchDistance: 0.3 })!.low).toBe(false);
    expect(pairingOf({ releaseTrack: track(), matchDistance: 0.31 })).toMatchObject({ confidence: 69, low: true });
  });

  it('shows no percentage for a track found by position', () => {
    expect(pairingOf({ releaseTrack: track() })).toMatchObject({ text: '1 · Clouds', low: false });
    expect(pairingOf({})).toBeNull();
  });
});
