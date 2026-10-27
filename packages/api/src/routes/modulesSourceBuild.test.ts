/**
 * Settings › Modules on an install with no updater and no release keys (run
 * from source): no catalogue can be checked, so no command can be offered.
 * The page listed nothing and said "No module can be turned on" next to the
 * built-in modules' working Turn on, under an empty "Run in the install
 * folder:" (QA 2026-10-26, Q-10). The player is listed with its real state,
 * as not available here.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { commandView, PLAYER_WITHOUT_CATALOGUE } from './modules.js';

const noKeys = async () => [];

describe('modules without the updater and without release keys', () => {
  afterEach(() => {
    delete process.env['TAGAVE_PLAYER_URL'];
    vi.unstubAllGlobals();
  });

  it('lists the player as not available here, with no problem to show and nothing downloaded', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const view = await commandView(noKeys);
    expect(view).toMatchObject({ mode: 'command', verified: false, problem: null });
    expect(view.modules).toEqual([{ ...PLAYER_WITHOUT_CATALOGUE, state: 'off', available: false, reason: 'Not available on this install.' }]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('shows the player as on when this server has one', async () => {
    process.env['TAGAVE_PLAYER_URL'] = 'http://player:4533';
    const view = await commandView(noKeys);
    expect(view.modules[0]).toMatchObject({ id: 'player', state: 'on', available: false });
  });

  it('the player entry says what the catalogue says (deploy/modules.json)', () => {
    const catalogue = JSON.parse(readFileSync(fileURLToPath(new URL('../../../../deploy/modules.json', import.meta.url)), 'utf8')) as {
      modules: Array<Record<string, unknown>>;
    };
    const player = catalogue.modules.find((m) => m['id'] === 'player')!;
    expect(PLAYER_WITHOUT_CATALOGUE).toMatchObject({
      id: player['id'], name: player['name'], purpose: player['purpose'], estimate: player['estimate'],
      keepsOnRemoval: player['keepsOnRemoval'], appData: player['appData'], roles: player['roles'],
    });
  });
});
