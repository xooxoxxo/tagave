/**
 * Settings › Modules renders from the catalogue it is given: one row per
 * module with its state, the buttons only with the updater and a signed
 * catalogue, the install-tagave.sh command without the updater.
 */
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ModulesView } from '@tagave/shared';
import { McModuleRow, SettingsModulesView, TurnOffChoices } from './SettingsModulesPage';
import { BASE_VIEW, DUMMY, PLAYER, playerRun } from '../stories/modulesFixtures';

const render = (view: ModulesView, dismissed: string | null = null) =>
  renderToStaticMarkup(<SettingsModulesView view={view} dismissed={dismissed} onTurnOn={() => undefined} onTurnOff={() => undefined} onDismiss={() => undefined} />);
const button = (html: string, label: string) => new RegExp(`<button[^>]*>(?:(?!</button>).)*${label}(?:(?!</button>).)*</button>`, 's').exec(html)?.[0] ?? '';

describe('Settings › Modules', () => {
  it('lists every module of the catalogue with its state, estimate and the right button', () => {
    const html = render(BASE_VIEW);
    expect(html).toContain('Player');
    expect(html).toContain('Dummy');
    expect(html).toContain('512 MB memory · 260 MB disk · one-computer installs');
    expect(button(html, 'Turn on')).not.toMatch(/disabled/);
    expect(button(html, 'Turn off')).not.toBe('');
    expect(html).not.toContain('install-tagave.sh enable-module');
  });

  it('a new module in the catalogue shows up with no change to the page', () => {
    const html = render({ ...BASE_VIEW, modules: [...BASE_VIEW.modules, { ...DUMMY, id: 'lyrics', name: 'Lyrics', purpose: 'Shows synced lyrics.', state: 'off' }] });
    expect(html).toContain('Lyrics');
    expect(html).toContain('Shows synced lyrics.');
  });

  it('shows the run with its steps and holds the buttons while it runs', () => {
    const html = render({ ...BASE_VIEW, run: playerRun('running'), modules: [{ ...PLAYER, state: 'installing' }, DUMMY] });
    expect(html).toContain('Turning on Player');
    expect(html).toContain('Start it…');
    expect(html).toContain('Check the release signature, the disk and download the images');
    expect(button(html, 'Turn off')).toMatch(/disabled/);
  });

  it('says why a Turn on failed, and that everything is as it was', () => {
    const reason = 'Player did not report healthy within 120 s: player reports unhealthy';
    const html = render({ ...BASE_VIEW, run: playerRun('rolled_back', reason), modules: [{ ...PLAYER, state: 'failed', lastError: reason }, DUMMY] });
    expect(html).toContain('Turning on Player failed; everything is as it was');
    expect(html).toContain('Failed');
    expect(button(html, 'Try again')).not.toBe('');
  });

  it('without the updater: the command for each module, no buttons', () => {
    const html = render({ ...BASE_VIEW, mode: 'command', modules: [PLAYER, { ...DUMMY, state: 'on' }] });
    expect(html).toContain('./install-tagave.sh enable-module player');
    expect(html).toContain('./install-tagave.sh disable-module dummy');
    expect(button(html, 'Turn on')).toBe('');
  });

  it('without the updater and the catalogue (run from source): each module as it is, no empty command, no warning', () => {
    const html = render({
      ...BASE_VIEW, mode: 'command', verified: false, problem: null,
      modules: [{ ...PLAYER, state: 'off', available: false, reason: 'Not available on this install.' }],
    });
    expect(html).toContain('Player');
    expect(html).toContain('>Off<');
    expect(html).toContain('Not available on this install.');
    expect(html).not.toContain('Run in the install folder');
    expect(html).not.toContain('install-tagave.sh');
    expect(html).not.toContain('No module can be turned on');
    expect(button(html, 'Turn on')).toBe('');
  });

  it('without the updater, the command line only above a command', () => {
    const html = render({ ...BASE_VIEW, mode: 'command', verified: false, problem: 'https://example.test/v0.9.2/release-manifest.json did not answer', modules: [] });
    expect(html).not.toContain('Run in the install folder');
    expect(html).toContain('No module can be turned on');
  });

  it('an unsigned or tampered catalogue: the reason, nothing to turn on', () => {
    const html = render({ ...BASE_VIEW, verified: false, problem: 'the release manifest does not match its signature', modules: [] });
    expect(html).toContain('No module can be turned on: The release manifest does not match its signature.');
    expect(button(html, 'Turn on')).toBe('');
  });

  it('a module that cannot run here says why and has no Turn on', () => {
    const html = render({ ...BASE_VIEW, role: 'app', modules: [{ ...PLAYER, available: false, reason: 'Player needs everything on one computer; this is the app computer of a split install.' }] });
    expect(html).toContain('this is the app computer of a split install');
    expect(button(html, 'Turn on')).toMatch(/disabled/);
  });

  it('Turn off says what the data box deletes and what stays, and offers the play history unticked', () => {
    const off = (initial?: { deleteData: boolean; deleteHistory: boolean }) =>
      renderToStaticMarkup(<TurnOffChoices m={{ ...PLAYER, state: 'on' }} onChange={() => undefined} {...(initial ? { initial } : {})} />);
    const closed = off();
    expect(closed).toContain('Also delete its data. This cannot be undone.');
    expect(closed).not.toContain('Your listens stay.');
    expect((closed.match(/type="checkbox"/g) ?? []).length).toBe(1);
    const data = off({ deleteData: true, deleteHistory: false });
    expect(data).toContain("Deletes Navidrome&#x27;s database and, in tagave, the player&#x27;s library, play counts and connected Last.fm and ListenBrainz accounts. A server of your own in Settings › Playback keeps its data and the accounts. Your listens stay.");
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

describe('the Music Connections row (a setting, not a container)', () => {
  const row = (enabled: boolean, error: string | null = null) => renderToStaticMarkup(
    <McModuleRow view={{ enabled, links: 2, landed: 40, fills: 3 }} error={error} onTurnOn={() => undefined} onTurnOff={() => undefined} />,
  );
  it('on: says what it holds and offers Turn off', () => {
    const html = row(true);
    expect(html).toContain('Music Connections');
    expect(html).toContain('>On<');
    expect(html).toContain('2 connections · 40 items · 3 IDs filled in');
    expect(button(html, 'Turn off')).not.toBe('');
    expect(button(html, 'Turn on')).toBe('');
  });
  it('off: offers Turn on, and shows a refusal', () => {
    const html = row(false, 'Confirm it is you first.');
    expect(html).toContain('>Off<');
    expect(button(html, 'Turn on')).not.toBe('');
    expect(html).toContain('Confirm it is you first.');
  });
});
