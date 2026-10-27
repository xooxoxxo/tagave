/**
 * Settings › Playback sends the owner to Modules only when Modules can turn
 * the player on: a source build listed no Player there, yet Playback said
 * "Turn on in Modules" (QA 2026-10-26, Q-35).
 */
import { describe, expect, it } from 'vitest';
import type { ModulesView } from '@tagave/shared';
import { modulesOffersPlayer } from './SettingsPlaybackPage';
import { BASE_VIEW, DUMMY, PLAYER } from '../stories/modulesFixtures';

const view = (over: Partial<ModulesView>): ModulesView => ({ ...BASE_VIEW, ...over });

describe('modulesOffersPlayer', () => {
  it('with the updater and a signed catalogue: yes', () => {
    expect(modulesOffersPlayer(view({ modules: [{ ...PLAYER, state: 'off' }] }))).toBe(true);
  });
  it('without the updater, with the command: yes', () => {
    expect(modulesOffersPlayer(view({ mode: 'command', modules: [{ ...PLAYER, state: 'off' }] }))).toBe(true);
  });
  it('not available on this install, not in the catalogue, unverified, unreachable or not loaded: no', () => {
    expect(modulesOffersPlayer(view({ mode: 'command', verified: false, problem: null, modules: [{ ...PLAYER, available: false, reason: 'Not available on this install.' }] }))).toBe(false);
    expect(modulesOffersPlayer(view({ modules: [DUMMY] }))).toBe(false);
    expect(modulesOffersPlayer(view({ verified: false, modules: [] }))).toBe(false);
    expect(modulesOffersPlayer(view({ mode: 'unreachable', modules: [] }))).toBe(false);
    expect(modulesOffersPlayer(undefined)).toBe(false);
  });
});
