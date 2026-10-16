/**
 * Settings › Listening: what each state offers, and that it never shows a
 * secret.
 */
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ListeningView } from '@tagave/shared';
import { ListeningSettingsView, lastfmReturnMessage, type ListeningSettingsViewProps } from './SettingsListeningPage';
import { ScrobblingSettingsPanel } from './SettingsPlaybackPage';

const noop = () => undefined;
const base: ListeningView = {
  playerInstalled: true,
  account: { kind: 'bundled', username: 'anna', phonePassword: false, serverScrobbles: false, state: 'active', lastError: null },
  lastfmAvailable: true,
  services: [
    { service: 'lastfm', connected: false, accountName: null, connectedAt: null, lastOkAt: null, lastError: null, lastErrorAt: null, pending: 0 },
    { service: 'listenbrainz', connected: false, accountName: null, connectedAt: null, lastOkAt: null, lastError: null, lastErrorAt: null, pending: 0 },
  ],
  lastPollAt: null,
  pollError: null,
};
const props = (data: ListeningView): ListeningSettingsViewProps => ({
  data, history: { plays: [], listens: [] }, lastfmReturn: null,
  onConnectLastfm: noop, onConnectListenbrainz: noop, onDisconnect: noop, onSetPhonePassword: noop, onClearPhonePassword: noop, onSaveOwnAccount: noop, onRemoveOwnAccount: noop,
});

describe('ListeningSettingsView', () => {
  it('offers both connections and a phone-app password', () => {
    const html = renderToStaticMarkup(<ListeningSettingsView {...props(base)} />);
    expect(html).toContain('Connect Last.fm');
    expect(html).toContain('Connect ListenBrainz');
    expect(html).toContain('Set password');
    expect(html).toContain('<strong');
    expect(html).toContain('anna');
  });
  it('sends people to the owner when Last.fm has no API key', () => {
    const html = renderToStaticMarkup(<ListeningSettingsView {...props({ ...base, lastfmAvailable: false })} />);
    expect(html).not.toContain('Connect Last.fm');
    expect(html).toContain('Settings › Playback › Scrobbling');
  });
  it('shows a connection, what waits and the last problem', () => {
    const data = { ...base, services: [{ ...base.services[0]!, connected: true, accountName: 'anna-fm', pending: 2, lastError: 'Service Offline', lastErrorAt: '2026-10-16T10:00:00Z' }, base.services[1]!] };
    const html = renderToStaticMarkup(<ListeningSettingsView {...props(data)} />);
    expect(html).toContain('Connected as anna-fm');
    expect(html).toContain('2 waiting to be sent');
    expect(html).toContain('Service Offline');
    expect(html).toContain('Disconnect');
  });
  it('says so when the player is not set up', () => {
    expect(renderToStaticMarkup(<ListeningSettingsView {...props({ ...base, playerInstalled: false })} />)).toContain('The player is not set up');
  });
  it('explains the shared account on the owner’s server', () => {
    const html = renderToStaticMarkup(<ListeningSettingsView {...props({ ...base, account: { kind: 'shared', username: null, phonePassword: false, serverScrobbles: false, state: null, lastError: null } })} />);
    expect(html).toContain('Add my login');
    expect(html).toContain('cannot tell you apart');
  });
  it('turns the Last.fm return into a sentence', () => {
    expect(lastfmReturnMessage('connected')?.tone).toBe('success');
    expect(lastfmReturnMessage('expired')?.tone).toBe('danger');
    expect(lastfmReturnMessage(null)).toBeNull();
  });
});

describe('ScrobblingSettingsPanel', () => {
  it('walks the owner through making a Last.fm API key', () => {
    const html = renderToStaticMarkup(<ScrobblingSettingsPanel view={{ lastfm: { configured: false, source: null, apiKeyHint: null }, listenbrainz: { available: true } }} onSave={noop} onRemove={noop} />);
    expect(html).toContain('href="https://www.last.fm/api/account/create"');
    expect(html).toContain('Application name');
    expect(html).toContain('Last.fm not set up');
  });
  it('names the key by its last four characters only', () => {
    const html = renderToStaticMarkup(<ScrobblingSettingsPanel view={{ lastfm: { configured: true, source: 'env', apiKeyHint: '3f9a' }, listenbrainz: { available: true } }} onSave={noop} onRemove={noop} />);
    expect(html).toContain('ending in …3f9a, from .env');
    expect(html).not.toContain('>Remove<');
  });
});
