/**
 * Signing in from a Music Connections consent page comes back to it: the
 * request is remembered per tab for as long as it lives, and only a
 * well-formed request id is ever remembered.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { forgetConsentRequest, rememberConsentRequest, rememberedConsentRequest, signInTarget } from './connectReturn';

const ID = `mcq_${'a'.repeat(43)}`;

describe('consent sign-in return', () => {
  beforeEach(() => {
    const store = new Map<string, string>();
    (globalThis as { sessionStorage?: unknown }).sessionStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    };
  });
  afterEach(() => {
    delete (globalThis as { sessionStorage?: unknown }).sessionStorage;
  });

  it('goes Home when nothing is remembered', () => {
    expect(signInTarget()).toEqual({ to: '/' });
  });

  it('comes back to the consent page, more than once until it is forgotten', () => {
    rememberConsentRequest(ID, 1000);
    expect(signInTarget(2000)).toEqual({ to: '/connect/consent', search: { request: ID } });
    expect(signInTarget(3000)).toEqual({ to: '/connect/consent', search: { request: ID } });
    forgetConsentRequest();
    expect(signInTarget(4000)).toEqual({ to: '/' });
  });

  it('forgets a request after ten minutes', () => {
    rememberConsentRequest(ID, 0);
    expect(rememberedConsentRequest(10 * 60 * 1000)).toBeNull();
  });

  it('never remembers anything but a request id', () => {
    rememberConsentRequest('/settings?x=1');
    rememberConsentRequest('https://evil.example/');
    expect(rememberedConsentRequest()).toBeNull();
  });

  it('works without storage', () => {
    delete (globalThis as { sessionStorage?: unknown }).sessionStorage;
    expect(() => rememberConsentRequest(ID)).not.toThrow();
    expect(signInTarget()).toEqual({ to: '/' });
  });
});
