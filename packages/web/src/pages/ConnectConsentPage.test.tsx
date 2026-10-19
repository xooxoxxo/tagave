/**
 * The consent card names the app, the host the answer goes back to and each
 * scope in plain words, with Approve and Deny.
 */
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ConsentCard, isFramed, type ConsentRequestView } from './ConnectConsentPage';

const view: ConsentRequestView = {
  client: { name: 'review-gatherer', redirectHost: '192.168.77.50:8080', secure: false },
  scopes: [
    { scope: 'ratings:read', label: 'Read your album ratings and favourites' },
    { scope: 'listens:read', label: 'Read how many times a day you play each album' },
    { scope: 'offline_access', label: 'Keep this access until you revoke it' },
  ],
};

const render = (v: ConsentRequestView = view) =>
  renderToStaticMarkup(<ConsentCard view={v} account="me@example.test" pending={null} error={null} onDecide={() => undefined} />);

describe('ConsentCard', () => {
  it('names the app, its host and each scope in words', () => {
    const html = render();
    expect(html).toContain('Link review-gatherer?');
    expect(html).toContain('192.168.77.50:8080');
    expect(html).toContain('Read your album ratings and favourites');
    expect(html).toContain('Read how many times a day you play each album');
    expect(html).not.toContain('ratings:read');
    expect(html).toContain('lasts until you revoke it');
    expect(html).toContain('plain HTTP');
    expect(html).toContain('me@example.test');
  });

  it('offers Approve and Deny', () => {
    const html = render();
    expect(html).toMatch(/<button[^>]*>.*Approve.*<\/button>/s);
    expect(html).toMatch(/<button[^>]*>.*Deny.*<\/button>/s);
  });

  it('without offline_access says the access ends after an hour; https needs no note', () => {
    const html = render({ client: { ...view.client, secure: true }, scopes: [view.scopes[0]!] });
    expect(html).toContain('ends after an hour');
    expect(html).not.toContain('plain HTTP');
  });

  it('renders a client name as text, never markup', () => {
    const html = render({ ...view, client: { ...view.client, name: '<img src=x onerror=alert(1)>' } });
    expect(html).not.toContain('<img');
  });
});

describe('framed', () => {
  it('shows no Approve or Deny inside a frame, only a notice', () => {
    const html = renderToStaticMarkup(<ConsentCard view={view} account={null} pending={null} error={null} framed onDecide={() => undefined} />);
    expect(html).not.toContain('<button');
    expect(html).not.toContain('Approve');
    expect(html).toContain('inside another site');
  });

  it('tells a frame from the top window, and assumes a frame when the browser will not say', () => {
    const self = {};
    expect(isFramed({ top: self, self })).toBe(false);
    expect(isFramed({ top: {}, self })).toBe(true);
    const crossOrigin = { self, get top(): unknown { throw new Error('SecurityError'); } };
    expect(isFramed(crossOrigin)).toBe(true);
  });
});
