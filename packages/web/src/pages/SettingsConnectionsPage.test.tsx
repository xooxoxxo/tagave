/**
 * Settings › Connections: each link's capabilities in words (granted, not
 * granted, available after a manifest change), its state and actions, the
 * remote-down notice, and the Link back note after the first link only.
 */
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { McLinkView } from '@tagave/shared';
import { ConnectionsOff, ConnectionsPanel, problem, returnError, type ConnectionsPanelProps } from './SettingsConnectionsPage';

const link: McLinkView = {
  id: 'l1',
  remoteUrl: 'http://192.168.1.20:8080',
  service: 'review-gatherer',
  state: 'active',
  capabilities: [
    { capability: 'critic-scores', status: 'granted', applied: 3, skipped: 0 },
    { capability: 'identity', status: 'not_granted', applied: null, skipped: null },
    { capability: 'wantlist-suggestions', status: 'available', applied: null, skipped: null },
  ],
  lastSyncAt: '2026-10-16T09:00:00.000Z',
  lastAttemptAt: '2026-10-16T09:00:00.000Z',
  lastError: null,
  failures: 0,
  nextAttemptAt: null,
  down: false,
  createdAt: '2026-10-01T09:00:00.000Z',
};
const noop = () => undefined;
const render = (p: Partial<ConnectionsPanelProps>) => renderToStaticMarkup(
  <ConnectionsPanel view={{ links: [link], ownUrl: 'http://192.168.1.10:3000' }} onAdd={noop} onSync={noop} onReapprove={noop} onEditUrl={() => true} onRevoke={noop} {...p} />,
);

describe('ConnectionsPanel', () => {
  it('shows each capability, the state, last sync and every action', () => {
    const html = render({});
    expect(html).toContain('Critic scores');
    expect(html).toContain('Granted');
    expect(html).toContain('Not granted');
    expect(html).toContain('Available, re-link to grant');
    expect(html).toContain('Linked');
    for (const label of ['Sync now', 'Re-approve', 'Edit address', 'Revoke']) expect(html).toContain(label);
  });

  it('offers Link back with this tagave’s address once there is a link, never before', () => {
    expect(render({})).toContain('http://192.168.1.10:3000');
    expect(render({})).toContain('Link back');
    const empty = render({ view: { links: [], ownUrl: 'http://192.168.1.10:3000' } });
    expect(empty).not.toContain('Link back');
    expect(empty).toContain('Add connection');
  });

  it('a remote down for a day says so, with the age of the last success', () => {
    const html = render({ view: { links: [{ ...link, down: true, failures: 9, lastError: 'remote timed out' }], ownUrl: null } });
    expect(html).toContain('Not answering');
    expect(html).toContain('has not answered since');
    expect(html).toContain('remote timed out');
  });

  it('a link needing approval has no Sync now; a revoked one offers Link again and Remove', () => {
    const needs = render({ view: { links: [{ ...link, state: 'needs_reapproval' }], ownUrl: null } });
    expect(needs).toContain('Needs approval');
    expect(needs).not.toContain('Sync now');
    const revoked = render({ view: { links: [{ ...link, state: 'revoked' }], ownUrl: null } });
    expect(revoked).toContain('Link again');
    expect(revoked).toContain('Remove');
    expect(revoked).not.toContain('Revoke<');
  });

  it('the way back from the other app: linked or a plain-words error', () => {
    expect(render({ returned: { linked: 'l1' } })).toContain('Linked to review-gatherer');
    expect(render({ returned: { error: 'access_denied' } })).toContain('was not allowed to link');
  });

  it('an unknown ?error= reads as the plain fallback, also for prototype names', () => {
    for (const code of ['constructor', 'toString', '__proto__', 'nope']) expect(returnError(code)).toBe('The link did not finish. Nothing changed.');
    expect(returnError('remote_error')).toContain('refused to finish');
  });

  it('a link error from Sync now shows next to the link', () => {
    expect(render({ linkErrors: { l1: 'A sync of this connection is already waiting to run. It starts Oct 16, 2026.' } })).toContain('already waiting to run');
  });

  it('Sync now while a pull waits: "Already syncing" when it is about to run, else when it starts', () => {
    const now = Date.parse('2026-10-16T10:00:00Z');
    expect(problem({ detail: 'Already syncing.' }, 'x', now)).toBe('Already syncing.');
    expect(problem({ detail: 'waiting', retryAt: new Date(now + 1000).toISOString() }, 'x', now)).toBe('Already syncing.');
    expect(problem({ detail: 'A sync is already waiting to run.', retryAt: new Date(now + 600_000).toISOString() }, 'x', now)).toMatch(/^A sync is already waiting to run\. It starts .+\.$/);
  });

  it('says when parked items were dropped and when sent IDs disagree', () => {
    const html = render({ view: { links: [{ ...link, parkedDropped: 12, identityConflicts: 2 }], ownUrl: null } });
    expect(html).toContain('12 items for albums not in your library were dropped');
    expect(html).toContain('2 album IDs it sent are');
  });
});

describe('ConnectionsOff', () => {
  it('says the module is off and points the owner to Settings › Modules', () => {
    const html = renderToStaticMarkup(<ConnectionsOff modules={<a href="/settings/modules">Settings › Modules</a>} />);
    expect(html).toContain('Music Connections is turned off');
    expect(html).toContain('href="/settings/modules"');
    expect(html).not.toContain('Add connection');
  });

  it('tells anyone else to ask the owner', () => {
    const html = renderToStaticMarkup(<ConnectionsOff />);
    expect(html).toContain('Ask the owner to turn it on in Settings › Modules.');
  });
});
