/**
 * Settings › Modules renders from the catalogue it is given: one row per
 * module with its state, the buttons only with the updater and a signed
 * catalogue, the install-tagave.sh command without the updater.
 */
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ModulesView } from '@tagave/shared';
import { SettingsModulesView } from './SettingsModulesPage';
import { BASE_VIEW, DUMMY, PLAYER, playerRun } from '../stories/modulesFixtures';

const render = (view: ModulesView, dismissed: string | null = null) =>
  renderToStaticMarkup(<SettingsModulesView view={view} dismissed={dismissed} onTurnOn={() => undefined} onTurnOff={() => undefined} onDismiss={() => undefined} />);
const button = (html: string, label: string) => new RegExp(`<button[^>]*>(?:(?!</button>).)*${label}(?:(?!</button>).)*</button>`, 's').exec(html)?.[0] ?? '';

describe('Settings › Modules', () => {
  it('lists every module of the catalogue with its state, estimate and the right button', () => {
    const html = render(BASE_VIEW);
    expect(html).toContain('Player');
    expect(html).toContain('Dummy');
    expect(html).toContain('Memory up to 512 MB · about 260 MB on disk · one-computer installs only');
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
});
