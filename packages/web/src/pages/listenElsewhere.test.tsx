/**
 * Your settings › Listen elsewhere on the settings layout (spec §6): a
 * platform's tick and the Missing albums choice each save when changed.
 */
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ListenElsewhereView, type ListenElsewhereViewProps } from './SettingsListenElsewherePage';

const render = (over: Partial<ListenElsewhereViewProps> = {}) =>
  renderToStaticMarkup(<ListenElsewhereView platforms={['qobuz', 'tidal']} primary="tidal" onChange={vi.fn()} onPrimary={vi.fn()} {...over} />);

describe('Your settings › Listen elsewhere', () => {
  it('Platforms and Missing albums groups', () => {
    const html = render();
    expect(html).toMatch(/<section aria-label="Platforms"/);
    expect(html).toMatch(/<section aria-label="Missing albums"/);
    expect(html.indexOf('aria-label="Platforms"')).toBeLessThan(html.indexOf('aria-label="Missing albums"'));
    expect(html).not.toMatch(/<h2/);
  });

  it('a platform saves when ticked', () => {
    const html = render();
    expect(html.match(/type="checkbox"/g)).toHaveLength(8);
    expect(html).not.toMatch(/>Save</);
    expect(render({ saved: true })).toContain('✓ Saved');
  });

  it('a failed save says Not saved', () => {
    expect(render({ error: '' })).toMatch(/role="alert">Not saved</);
    expect(render({ error: 'the server is busy' })).toMatch(/role="alert">The server is busy.</);
    expect(render()).not.toContain('role="alert"');
  });
});
