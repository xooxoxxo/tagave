/**
 * Settings › Modules › Player: what each state offers, and that it never shows a
 * secret.
 */
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ListeningView } from '@tagave/shared';
import { ListeningSettingsView, lastfmReturnMessage, queuedLine, serviceLine, type ListeningSettingsViewProps } from './SettingsListeningPage';
import { ScrobblingSettingsPanel } from './SettingsPlaybackPage';

const noop = () => undefined;
const base: ListeningView = {
  playerInstalled: true,
  account: { kind: 'bundled', username: 'anna', phonePassword: false, serverScrobbles: false, state: 'active', lastError: null },
  lastfmAvailable: true,
  services: [
    { service: 'lastfm', connected: false, accountName: null, connectedAt: null, lastOkAt: null, lastError: null, lastErrorAt: null, pending: 0, loves: true },
    { service: 'listenbrainz', connected: false, accountName: null, connectedAt: null, lastOkAt: null, lastError: null, lastErrorAt: null, pending: 0, loves: true },
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
    expect(html).toMatch(/>Set<\/span>/);
    expect(html).toContain('>anna<');
  });
  it('sends people to the owner when Last.fm has no API key', () => {
    const html = renderToStaticMarkup(<ListeningSettingsView {...props({ ...base, lastfmAvailable: false })} />);
    expect(html).not.toContain('Connect Last.fm');
    expect(html).toContain('Not set up on this server');
  });
  it('shows a connection, what waits and the last problem', () => {
    const data = { ...base, services: [{ ...base.services[0]!, connected: true, accountName: 'anna-fm', pending: 2, lastError: 'Service Offline', lastErrorAt: '2026-10-16T10:00:00Z' }, base.services[1]!] };
    const html = renderToStaticMarkup(<ListeningSettingsView {...props(data)} />);
    expect(html).toContain('Connected · anna-fm');
    expect(html).toContain('Nothing sent yet · 2 waiting');
    expect(html).toContain('Service Offline');
    expect(html).toContain('Disconnect');
  });
  it('says when something last went through', () => {
    const ok = { ...base.services[1]!, connected: true, accountName: 'anna-lb', lastOkAt: new Date(Date.now() - 2 * 60_000).toISOString() };
    expect(serviceLine(ok)).toBe('anna-lb · Last sent 2 min ago');
  });
  it('says so when the player is not set up', () => {
    expect(renderToStaticMarkup(<ListeningSettingsView {...props({ ...base, playerInstalled: false })} />)).toContain('Player not set up');
  });
  it('explains the shared account on the owner’s server', () => {
    const html = renderToStaticMarkup(<ListeningSettingsView {...props({ ...base, account: { kind: 'shared', username: null, phonePassword: false, serverScrobbles: false, state: null, lastError: null } })} />);
    expect(html).toContain('Add login');
    expect(html).toContain('Shared account');
  });
  it('turns the Last.fm return into a sentence', () => {
    expect(lastfmReturnMessage('connected')?.tone).toBe('success');
    expect(lastfmReturnMessage('expired')?.tone).toBe('danger');
    expect(lastfmReturnMessage(null)).toBeNull();
    expect(lastfmReturnMessage('connected', 12)?.text).toBe('Last.fm connected · 12 recent plays queued');
    expect(queuedLine(1)).toBe('1 recent play queued');
    expect(queuedLine(0)).toBeNull();
  });
  it('says once how many recent plays go to ListenBrainz after connecting', () => {
    const data = { ...base, services: [base.services[0]!, { ...base.services[1]!, connected: true, accountName: 'anna-lb' }] };
    expect(renderToStaticMarkup(<ListeningSettingsView {...props(data)} listenbrainzQueued={12} />)).toContain('12 recent plays queued');
    expect(renderToStaticMarkup(<ListeningSettingsView {...props(data)} />)).not.toContain('recent plays queued');
  });
});

const shared: ListeningView['account'] = { kind: 'shared', username: null, phonePassword: false, serverScrobbles: false, state: null, lastError: null };
const own: ListeningView['account'] = { kind: 'own', username: 'robin', phonePassword: false, serverScrobbles: true, state: 'active', lastError: null };
const lastfmOn: ListeningView = { ...base, services: [{ ...base.services[0]!, connected: true, accountName: 'robin-fm' }, base.services[1]!] };
/** The markup with every closed help region taken out. */
const visible = (html: string) => html.replace(/<div[^>]*hidden=""[^>]*>[\s\S]*?<\/div>/g, '');
/** The <form> around the first match of `marker`. */
const formAround = (html: string, marker: string) => {
  const at = html.indexOf(marker);
  const start = html.lastIndexOf('<form', at);
  return start < 0 ? '' : html.slice(start, html.indexOf('</form>', at) + 7);
};
/** The <section> of a group, by its title. */
const group = (html: string, title: string) => {
  const start = html.indexOf(`<section aria-label="${title}"`);
  return start < 0 ? '' : html.slice(start, html.indexOf('</section>', start));
};

describe('Your settings › Listening on the settings layout', () => {
  it('groups Player account, Scrobbling, Recently played, in order', () => {
    const html = renderToStaticMarkup(<ListeningSettingsView {...props(base)} />);
    const at = (title: string) => html.indexOf(`<section aria-label="${title}"`);
    expect(at('Player account')).toBeGreaterThan(-1);
    expect(at('Player account')).toBeLessThan(at('Scrobbling'));
    expect(at('Scrobbling')).toBeLessThan(at('Recently played'));
    expect(html).not.toMatch(/<h2/);
  });

  it('the phone password is its own action', () => {
    const html = renderToStaticMarkup(<ListeningSettingsView {...props(base)} />);
    const form = formAround(html, 'Phone password');
    expect(form).toContain('type="password"');
    expect(form).toMatch(/>Set<\/span>/);
    expect(form).not.toMatch(/>Save</);
    const set = renderToStaticMarkup(<ListeningSettingsView {...props({ ...base, account: { ...base.account, phonePassword: true } })} />);
    expect(formAround(set, 'Phone password')).toMatch(/>Replace<\/span>/);
    expect(formAround(set, 'Phone password')).toMatch(/>Forget<\/span>/);
    // the own login never carries it
    const mine = renderToStaticMarkup(<ListeningSettingsView {...props({ ...base, account: own })} />);
    expect(mine).not.toContain('Phone password');
    expect(formAround(mine, 'Server scrobbles')).toMatch(/>Save</);
  });

  it('the own login: User name, Password and Server scrobbles join one Save', () => {
    const html = renderToStaticMarkup(<ListeningSettingsView {...props({ ...base, account: shared })} />);
    const form = formAround(html, 'Server scrobbles');
    for (const label of ['>User name<', '>Password<', '>Server scrobbles<', '>Add login<']) expect(form).toContain(label);
    expect(form).toMatch(/role="radiogroup" aria-label="Server scrobbles"/);
    // nothing typed yet: Add login waits
    expect(form).toMatch(/<button[^>]*disabled=""[^>]*>(?:(?!<\/button>)[\s\S])*Add login/);
  });

  it('Loves saves at once', () => {
    const html = renderToStaticMarkup(<ListeningSettingsView {...props(lastfmOn)} />);
    const scrobbling = group(html, 'Scrobbling');
    expect(scrobbling).toMatch(/role="radiogroup" aria-label="Loves on Last.fm"/);
    expect(scrobbling).not.toMatch(/>Save</);
    const saved = renderToStaticMarkup(<ListeningSettingsView {...props(lastfmOn)} saves={{ loves: { state: 'saved' } }} />);
    expect(group(saved, 'Scrobbling')).toContain('✓ Saved');
    const failed = renderToStaticMarkup(<ListeningSettingsView {...props(lastfmOn)} saves={{ loves: { state: 'failed' } }} />);
    expect(group(failed, 'Scrobbling')).toMatch(/role="alert">Not saved</);
  });

  it('no hint paragraphs', () => {
    const mine = renderToStaticMarkup(<ListeningSettingsView {...props({ ...base, account: own })} />);
    expect(mine).not.toContain('User name: ');
    expect(mine).toMatch(/<input[^>]*value="robin"/);
    expect(mine).not.toContain('<p');
    const lb = visible(renderToStaticMarkup(<ListeningSettingsView {...props(base)} />));
    expect(lb).not.toContain('Get your token');
    expect(renderToStaticMarkup(<ListeningSettingsView {...props(base)} />)).toContain('Get your token');
    const off = renderToStaticMarkup(<ListeningSettingsView {...props({ ...base, lastfmAvailable: false })} />);
    expect(off).toContain('Not set up on this server');
  });
});

describe('ScrobblingSettingsPanel', () => {
  const unset = { lastfm: { configured: false, source: null, apiKeyHint: null }, listenbrainz: { available: true as const } };
  const set = { lastfm: { configured: true, source: 'settings' as const, apiKeyHint: '105a' }, listenbrainz: { available: true as const } };
  it('asks for a key in one sentence, with the steps behind a disclosure', () => {
    const html = renderToStaticMarkup(<ScrobblingSettingsPanel view={unset} onSave={noop} onRemove={noop} />);
    expect(html).toContain('>How to<');
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain('Application name');
    expect(html).toContain('API key');
    expect(html).toContain('>Save<');
  });
  it('shows a saved key read-only, by its last four characters, with Replace and Remove', () => {
    const html = renderToStaticMarkup(<ScrobblingSettingsPanel view={set} onSave={noop} onRemove={noop} />);
    expect(html).toContain('Last.fm · API key …105a');
    expect(html).toContain('>Replace<');
    expect(html).toContain('>Remove<');
    expect(html).not.toContain('<input');
    expect(html).not.toContain('>How to<');
  });
  it('opens the fields with Cancel on Replace', () => {
    const html = renderToStaticMarkup(<ScrobblingSettingsPanel view={set} initialReplacing onSave={noop} onRemove={noop} />);
    expect(html).toContain('<input');
    expect(html).toContain('>Cancel<');
  });
  it('a key from .env cannot be removed here', () => {
    const html = renderToStaticMarkup(<ScrobblingSettingsPanel view={{ ...set, lastfm: { ...set.lastfm, source: 'env', apiKeyHint: '3f9a' } }} onSave={noop} onRemove={noop} />);
    expect(html).toContain('…3f9a · from .env');
    expect(html).not.toContain('>Remove<');
  });
  it('offers Connect when the owner’s own Last.fm is not connected', () => {
    const off = renderToStaticMarkup(<ScrobblingSettingsPanel view={set} you={{ lastfmAccount: null }} onSave={noop} onRemove={noop} onConnect={noop} />);
    expect(off).toContain('Your Last.fm');
    expect(off).toContain('>Connect<');
    const on = renderToStaticMarkup(<ScrobblingSettingsPanel view={set} you={{ lastfmAccount: 'anna-fm' }} onSave={noop} onRemove={noop} />);
    expect(on).toContain('Your Last.fm: anna-fm');
    expect(on).not.toContain('>Connect<');
    // no key yet: nothing to connect to
    expect(renderToStaticMarkup(<ScrobblingSettingsPanel view={unset} you={{ lastfmAccount: null }} onSave={noop} onRemove={noop} />)).not.toContain('isn’t connected');
  });
});
