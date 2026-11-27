/**
 * Settings › Modules › Player, Last scan: a player scan held while a music
 * folder is offline says why it waits, in the quiet tone, not as a failure.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { PLAYER_SCAN_HELD } from '@tagave/shared';
import { describe, expect, it } from 'vitest';
import { ScanValue } from './SettingsPlaybackPage';

const at = '2026-11-24T14:02:00.000Z';
const render = (lastScan: Parameters<typeof ScanValue>[0]['lastScan']) =>
  renderToStaticMarkup(<ScanValue lastScan={lastScan} justAsked={false} error={null} />);

describe('Last scan', () => {
  it('a held scan says it waits for a music folder, as a plain value', () => {
    expect(PLAYER_SCAN_HELD).toBe('Waiting for a music folder to come back');
    const html = render({ requestedAt: at, state: 'requested', error: PLAYER_SCAN_HELD });
    expect(html).toContain('>Waiting for a music folder to come back<');
    expect(html).not.toContain('Failed');
    expect(html).not.toContain('role="alert"');
    expect(html).not.toMatch(/class="[^"]*danger/);
  });

  it('any other requested scan shows when it was asked for', () => {
    expect(render({ requestedAt: at, state: 'requested', error: null })).not.toContain('Waiting');
    expect(render({ requestedAt: at, state: 'requested', error: 'something else' })).not.toContain('something else');
  });

  it('a failed scan still says Failed with its reason', () => {
    expect(render({ requestedAt: at, state: 'failed', error: 'timeout' })).toContain('>Failed: timeout<');
  });
});
