/**
 * Settings › Modules: the list (who sees which module, with which state)
 * and a catalogue module's page: Off | On only with the updater and a
 * signed catalogue, the install-tagave.sh command without the updater, the
 * run while it runs.
 */
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import type { ModulesView } from '@tagave/shared';
import { CatalogueModuleView, ModuleSwitchView, ModulesListView, TurnOffChoices, moduleRows } from './SettingsModulesPage';
import { MOVED_SECTIONS, moduleSlug } from './moduleSettings';
import { BASE_VIEW, DUMMY, PLAYER, playerRun } from '../stories/modulesFixtures';

const page = (view: ModulesView, id = 'player', dismissed: string | null = null) =>
  renderToStaticMarkup(<CatalogueModuleView view={view} id={id} name="Player" dismissed={dismissed} onSwitch={() => undefined} onDismiss={() => undefined} />);
/** the radio of one option of the Off | On control */
const option = (html: string, label: 'Off' | 'On') => new RegExp(`<input[^>]*value="${label.toLowerCase()}"[^>]*>`).exec(html)?.[0] ?? '';

const ALL_ON = { player: true, mc: true, 'listen-links': true, playlists: true, lidarr: true };

describe('the rows of Settings › Modules', () => {
  it('the owner: every module, in the owner’s order, with its state', () => {
    const rows = moduleRows({ owner: true, enabled: { ...ALL_ON, mc: false } })!;
    expect(rows.map((r) => r.name)).toEqual(['Player', 'Lidarr', 'Listen elsewhere', 'Music Connections', 'Playlists']);
    expect(rows.find((r) => r.slug === 'music-connections')).toMatchObject({ state: 'Off', on: false });
    expect(rows.find((r) => r.slug === 'lidarr')).toMatchObject({ state: 'On', on: true });
  });

  it('the owner: the player’s state from the catalogue, and a module the catalogue adds gets a row', () => {
    const rows = moduleRows({ owner: true, enabled: ALL_ON, catalogue: { ...BASE_VIEW, modules: [{ ...PLAYER, state: 'installing' }, DUMMY] } })!;
    expect(rows[0]).toMatchObject({ slug: 'player', state: 'Turning on', on: false });
    expect(rows.at(-1)).toMatchObject({ slug: 'dummy', name: 'Dummy', state: 'On' });
  });

  it('anyone else: only the modules with something of theirs, while they are on', () => {
    const rows = (enabled: Record<string, boolean>, playerInstalled: boolean) => moduleRows({ owner: false, enabled, playerInstalled })!.map((r) => r.slug);
    expect(rows(ALL_ON, true)).toEqual(['player', 'listen-elsewhere', 'music-connections']);
    expect(rows({ ...ALL_ON, mc: false, 'listen-links': false }, false)).toEqual([]);
    // the player's Listening works with a server of the owner's own, the bundled player off
    expect(rows({ ...ALL_ON, player: false }, true)).toContain('player');
  });

  it('nothing while the modules are not known yet', () => {
    expect(moduleRows({ owner: true, enabled: null })).toBeNull();
  });
});

async function withRouter(children: ReactNode): Promise<string> {
  const root = createRootRoute({ component: () => <>{children}</> });
  const mod = createRoute({ getParentRoute: () => root, path: '/settings/modules/$module' });
  const router = createRouter({ routeTree: root.addChildren([mod]), history: createMemoryHistory({ initialEntries: ['/'] }) });
  await router.load();
  return renderToStaticMarkup(<RouterProvider router={router} />);
}

describe('the list', () => {
  it('a row is a link to the module’s page with its name and state, no sentence', async () => {
    const html = await withRouter(<ModulesListView rows={[{ slug: 'lidarr', name: 'Lidarr', state: 'On', on: true }]} />);
    expect(html).toContain('href="/settings/modules/lidarr"');
    expect(html).toContain('>Lidarr<');
    expect(html).toContain('>On<');
    expect(html).not.toMatch(/\.\s*</);
  });
});

describe('where the old sections went', () => {
  it('each old address has a module page', () => {
    expect(MOVED_SECTIONS).toEqual({ connections: 'music-connections', 'listen-elsewhere': 'listen-elsewhere', playback: 'player', listening: 'player' });
    expect(moduleSlug('mc')).toBe('music-connections');
    expect(moduleSlug('listen-links')).toBe('listen-elsewhere');
    expect(moduleSlug('lyrics')).toBe('lyrics');
  });
});

describe('Off | On', () => {
  it('one control shape: Off and On, the label when there is one', () => {
    const html = renderToStaticMarkup(<ModuleSwitchView name="Lidarr" label="Get missing albums" on meta="2 getting" onSwitch={() => undefined} />);
    expect(html).toContain('role="radiogroup"');
    expect(html).toContain('aria-label="Get missing albums"');
    expect(option(html, 'On')).toMatch(/checked/);
    expect(html).toContain('2 getting');
  });
});

describe('Settings › Modules › Player (a catalogue module)', () => {
  it('Off | On with its memory and disk, choosable with the updater', () => {
    const html = page(BASE_VIEW);
    expect(html).toContain('512 MB memory · 260 MB disk · one-computer installs');
    expect(option(html, 'On')).not.toMatch(/disabled/);
    expect(option(html, 'Off')).toMatch(/checked/);
    expect(html).not.toContain('install-tagave.sh enable-module');
  });

  it('a module the catalogue adds has a page with no change to the code', () => {
    const html = renderToStaticMarkup(<CatalogueModuleView view={{ ...BASE_VIEW, modules: [...BASE_VIEW.modules, { ...DUMMY, id: 'lyrics', name: 'Lyrics', state: 'on' }] }} id="lyrics" name="Lyrics" onSwitch={() => undefined} onDismiss={() => undefined} />);
    expect(option(html, 'On')).toMatch(/checked/);
  });

  it('shows the run with its steps and holds the control while it runs', () => {
    const html = page({ ...BASE_VIEW, run: playerRun('running'), modules: [{ ...PLAYER, state: 'installing' }, DUMMY] });
    expect(html).toContain('Turning on Player');
    expect(html).toContain('Start it…');
    expect(html).toContain('Check the release signature, the disk and download the images');
    expect(option(html, 'On')).toMatch(/disabled/);
    expect(html).toContain('Turning on');
  });

  it('a run of another module stays on that module’s page; a dismissed one goes', () => {
    expect(page({ ...BASE_VIEW, run: { ...playerRun('succeeded'), module: 'dummy' } })).not.toContain('Player is on');
    expect(page({ ...BASE_VIEW, run: playerRun('succeeded') }, 'player', playerRun('succeeded').id)).not.toContain('Player is on');
  });

  it('says why a Turn on failed, and that everything is as it was', () => {
    const reason = 'Player did not report healthy within 120 s: player reports unhealthy';
    const html = page({ ...BASE_VIEW, run: playerRun('rolled_back', reason), modules: [{ ...PLAYER, state: 'failed', lastError: reason }, DUMMY] });
    expect(html).toContain('Turning on Player failed; everything is as it was');
    expect(html).toContain('Failed');
    expect(option(html, 'On')).not.toMatch(/disabled/);
  });

  it('without the updater: the command, the control held', () => {
    const html = page({ ...BASE_VIEW, mode: 'command', modules: [PLAYER, { ...DUMMY, state: 'on' }] });
    expect(html).toContain('./install-tagave.sh enable-module player');
    expect(option(html, 'On')).toMatch(/disabled/);
    expect(renderToStaticMarkup(<CatalogueModuleView view={{ ...BASE_VIEW, mode: 'command', modules: [PLAYER, { ...DUMMY, state: 'on' }] }} id="dummy" name="Dummy" onSwitch={() => undefined} onDismiss={() => undefined} />)).toContain('./install-tagave.sh disable-module dummy');
  });

  it('without the updater and the catalogue (run from source): the player as it is, no empty command', () => {
    const html = page({ ...BASE_VIEW, mode: 'command', verified: false, problem: null, modules: [{ ...PLAYER, state: 'off', available: false, reason: 'Not available on this install.' }] });
    expect(option(html, 'Off')).toMatch(/checked/);
    expect(html).toContain('Not available on this install.');
    expect(html).not.toContain('install-tagave.sh');
  });

  it('an unsigned or tampered catalogue: the reason, nothing to switch', () => {
    const html = page({ ...BASE_VIEW, verified: false, problem: 'the release manifest does not match its signature', modules: [] });
    expect(html).toContain('Catalogue not verified. The release manifest does not match its signature.');
    expect(html).not.toContain('radiogroup');
  });

  it('the updater not answering says so', () => {
    expect(page({ ...BASE_VIEW, mode: 'unreachable', error: 'connect ECONNREFUSED', modules: [] })).toContain('Updater not answering.');
  });

  it('a module that cannot run here says why and holds On', () => {
    const html = page({ ...BASE_VIEW, role: 'app', modules: [{ ...PLAYER, available: false, reason: 'Player needs everything on one computer; this is the app computer of a split install.' }] });
    expect(html).toContain('this is the app computer of a split install');
    expect(option(html, 'On')).toMatch(/disabled/);
  });

  it('Turn off says what the data box deletes and what stays, and offers the play history unticked', () => {
    const off = (initial?: { deleteData: boolean; deleteHistory: boolean }) =>
      renderToStaticMarkup(<TurnOffChoices m={{ ...PLAYER, state: 'on' }} onChange={() => undefined} {...(initial ? { initial } : {})} />);
    const closed = off();
    expect(closed).toContain('Also delete its data. This cannot be undone.');
    expect(closed).not.toContain('Your listens stay.');
    expect((closed.match(/type="checkbox"/g) ?? []).length).toBe(1);
    const data = off({ deleteData: true, deleteHistory: false });
    expect(data).toContain("Deletes Navidrome&#x27;s database and, in tagave, the player&#x27;s library, play counts and connected Last.fm and ListenBrainz accounts. A server of your own in Settings\u00a0›\u00a0Modules\u00a0›\u00a0Player keeps its data and the accounts. Your listens stay.");
    expect(data).toContain('Also delete the listens the player recorded. Listens you added yourself stay.');
    expect((data.match(/type="checkbox"/g) ?? []).length).toBe(2);
    expect((data.match(/checked=""/g) ?? []).length).toBe(1);
    const history = off({ deleteData: true, deleteHistory: true });
    expect(history).not.toContain('Your listens stay.');
    expect((history.match(/checked=""/g) ?? []).length).toBe(2);
    // a module with no rows in tagave: the one box, as before
    const dummy = renderToStaticMarkup(<TurnOffChoices m={DUMMY} onChange={() => undefined} initial={{ deleteData: true, deleteHistory: false }} />);
    expect((dummy.match(/type="checkbox"/g) ?? []).length).toBe(1);
  });
});
