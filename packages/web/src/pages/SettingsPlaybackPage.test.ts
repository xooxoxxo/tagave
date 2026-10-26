import { describe, expect, it } from 'vitest';
import { modulesOfferPlayer } from './SettingsPlaybackPage';

const module = (id: string) => ({ id }) as never;

describe('modulesOfferPlayer', () => {
  it('points to Modules only when Modules lists the player (QA Q-35)', () => {
    expect(modulesOfferPlayer({ modules: [module('music-connections'), module('player')] })).toBe(true);
    // a source build: Modules has no player, the own-server form is the way
    expect(modulesOfferPlayer({ modules: [module('music-connections')] })).toBe(false);
    expect(modulesOfferPlayer(undefined)).toBe(false);
  });
});
