import { describe, expect, it } from 'vitest';
import { redactUrl, requestSerializer } from './logRedact.js';

describe('redactUrl', () => {
  it('hides invite and set-password tokens in the path', () => {
    expect(redactUrl('/api/v1/invites/AbC_123-xyz')).toBe('/api/v1/invites/[redacted]');
    expect(redactUrl('/api/v1/invites/AbC_123-xyz/accept')).toBe('/api/v1/invites/[redacted]/accept');
    expect(redactUrl('/invite/AbC_123-xyz')).toBe('/invite/[redacted]');
  });
  it('hides the Last.fm token and state in the query, keeps the rest', () => {
    expect(redactUrl('/api/v1/me/listening/lastfm/callback?token=secret&state=1.sig&x=1'))
      .toBe('/api/v1/me/listening/lastfm/callback?token=%5Bredacted%5D&state=%5Bredacted%5D&x=1');
  });
  it('leaves other URLs alone', () => {
    expect(redactUrl('/api/v1/libraries/abc/albums?limit=50')).toBe('/api/v1/libraries/abc/albums?limit=50');
    expect(redactUrl('/api/v1/users/invites')).toBe('/api/v1/users/invites');
  });
  it('serializes a request like Fastify, with the URL redacted', () => {
    expect(requestSerializer({ method: 'GET', url: '/invite/tok', host: 'h', ip: '1.2.3.4', socket: { remotePort: 5 } }))
      .toEqual({ method: 'GET', url: '/invite/[redacted]', host: 'h', remoteAddress: '1.2.3.4', remotePort: 5 });
  });
});
