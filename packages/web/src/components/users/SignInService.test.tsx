import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { OidcSettingsResponse } from '@tagave/shared';
import { SignInServiceForm, draftFrom, requestFrom, serviceState } from './SignInService';
import { OidcLinkPanel } from './OidcLinkSection';
import { InviteFormView } from '../../pages/InvitePage';
import { oidcSignInFailedText } from '../../pages/LoginPage';

const SECRET = 'very-secret-value';
const view = (over: Partial<OidcSettingsResponse> = {}): OidcSettingsResponse => ({
  settings: { name: 'Zitadel', issuer: 'https://auth.example.com', clientId: 'tagave', secretSet: true, enabled: true, joinEnabled: true, joinGroup: 'music', updatedAt: '2026-11-02T10:00:00Z' },
  redirectUri: 'https://music.example.com/api/auth/callback/oidc',
  active: true,
  secretUnreadable: false,
  ...over,
});
const noop = () => undefined;

describe('sign-in service settings', () => {
  it('never puts a secret in the form, only whether one is set', () => {
    const v = view();
    const d = draftFrom(v);
    expect(d.clientSecret).toBe('');
    const html = renderToStaticMarkup(<SignInServiceForm view={v} draft={d} onChange={noop} onTest={noop} onSave={noop} />);
    expect(html).toContain('placeholder="Set"');
    expect(html).toContain('https://music.example.com/api/auth/callback/oidc');
    expect(html).toContain('Anyone can join');
    expect(html).not.toContain('type="checkbox"');
    expect(html).not.toContain(SECRET);
  });

  it('an empty secret field keeps the stored secret; the group only with join', () => {
    const d = { ...draftFrom(view()), joinGroup: ' music ' };
    expect(requestFrom(d)).toEqual({ name: 'Zitadel', issuer: 'https://auth.example.com', clientId: 'tagave', enabled: true, joinEnabled: true, joinGroup: 'music' });
    expect(requestFrom({ ...d, clientSecret: SECRET }).clientSecret).toBe(SECRET);
    expect(requestFrom({ ...d, joinEnabled: false }).joinGroup).toBeNull();
  });

  it('says whether the button works', () => {
    expect(serviceState(view())).toBe('active');
    expect(serviceState(view({ active: false }))).toBe('unreachable');
    expect(serviceState(view({ settings: { ...view().settings!, enabled: false }, active: false }))).toBe('off');
    expect(serviceState(view({ settings: null, active: false }))).toBe('none');
  });
});

describe('Account link', () => {
  it('offers Link, and Unlink only when another way in is left', () => {
    const notLinked = renderToStaticMarkup(<OidcLinkPanel view={{ name: 'Zitadel', linked: false, linkedAt: null, canUnlink: false }} onLink={noop} onUnlink={noop} />);
    expect(notLinked).toContain('Not linked');
    expect(notLinked).toMatch(/>Link</);
    const only = renderToStaticMarkup(<OidcLinkPanel view={{ name: 'Zitadel', linked: true, linkedAt: '2026-11-02T10:00:00Z', canUnlink: false }} onLink={noop} onUnlink={noop} />);
    expect(only).toMatch(/<button[^>]*disabled[^>]*>[\s\S]*Unlink/);
  });
});

describe('sign-in and invite pages', () => {
  it('one message for any failed login-service sign-in', () => {
    expect(oidcSignInFailedText('Zitadel')).toBe('Couldn’t sign in with Zitadel.');
    expect(oidcSignInFailedText(null)).toBe('Couldn’t sign in with your login service.');
  });

  it('an invite offers the login service, an owner invite does not', () => {
    const link = { purpose: 'invite' as const, email: 'kim@example.com', role: 'listener' as const, name: null, expiresAt: '2026-11-09T00:00:00Z', clearSecondFactors: false };
    expect(renderToStaticMarkup(<InviteFormView link={link} onSubmit={noop} oidcName="Zitadel" onOidc={noop} />)).toContain('Continue with Zitadel');
    expect(renderToStaticMarkup(<InviteFormView link={{ ...link, role: 'owner' }} onSubmit={noop} oidcName="Zitadel" onOidc={noop} />)).not.toContain('Continue with');
    expect(renderToStaticMarkup(<InviteFormView link={{ ...link, purpose: 'reset' }} onSubmit={noop} oidcName="Zitadel" onOidc={noop} />)).not.toContain('Continue with');
  });
});
