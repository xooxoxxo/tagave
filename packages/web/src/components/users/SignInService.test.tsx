import { readFileSync } from 'node:fs';
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { OidcSettingsResponse } from '@tagave/shared';
import { SegmentedControl, SettingsSave } from '../ui';
import { SignInServiceForm, draftFrom, instantRequest, requestFrom, serviceState, type SignInServiceFormProps } from './SignInService';
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

/** Every element in a tree, through children and every element-valued prop. */
function elements(node: ReactNode): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement(node)) return [];
  const el = node as ReactElement<Record<string, unknown>>;
  return [el, ...Object.values(el.props).flatMap((v) => (Array.isArray(v) || isValidElement(v) ? elements(v as ReactNode) : []))];
}
const form = (over: Partial<SignInServiceFormProps> = {}): SignInServiceFormProps => {
  const v = over.view ?? view();
  return { view: v, draft: draftFrom(v), onChange: vi.fn(), onTest: noop, onSave: noop, onInstant: vi.fn(), onSaveGroup: vi.fn(), ...over };
};
const choice = (p: SignInServiceFormProps, label: string) =>
  elements(SignInServiceForm(p)).find((e) => e.type === SegmentedControl && e.props.label === label)!;

describe('sign-in service settings', () => {
  it('never puts a secret in the form, only whether one is set', () => {
    const v = view();
    const d = draftFrom(v);
    expect(d.clientSecret).toBe('');
    const html = renderToStaticMarkup(<SignInServiceForm view={v} draft={d} onChange={noop} onTest={noop} onSave={noop} />);
    expect(html).toMatch(/>Set<\/span>/);
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

describe('the sign-in service on the settings layout', () => {
  it('two groups: Sign-in service, then Join; no heading of its own', () => {
    const html = renderToStaticMarkup(<SignInServiceForm {...form()} />);
    expect(html).toMatch(/<section aria-label="Sign-in service"/);
    expect(html).toMatch(/<section aria-label="Join"/);
    expect(html.indexOf('aria-label="Sign-in service"')).toBeLessThan(html.indexOf('aria-label="Join"'));
    expect(html).not.toMatch(/<h2/);
    // the client secret is a secret: never a value, only whether one is set
    expect(html).toMatch(/>Set<\/span>/);
  });

  it("a saved service's Sign-in button saves at once", () => {
    const p = form();
    (choice(p, 'Sign-in button').props.onChange as (v: string) => void)('off');
    expect(p.onInstant).toHaveBeenCalledWith({ enabled: false });
    expect(p.onChange).not.toHaveBeenCalled();
    // the container's PUT: the saved settings with that one change, the secret left out
    const body = instantRequest(view(), { enabled: false });
    expect(body).toEqual({ name: 'Zitadel', issuer: 'https://auth.example.com', clientId: 'tagave', enabled: false, joinEnabled: true, joinGroup: 'music' });
    expect('clientSecret' in body).toBe(false);
    expect(instantRequest(view(), { joinEnabled: false }).joinGroup).toBeNull();
    const src = readFileSync(new URL('./SignInService.tsx', import.meta.url), 'utf8');
    expect(src).toMatch(/instantRequest\(view, patch\)/);
  });

  it('a new service shows no Join: its one Save is Name, Issuer, Client ID and Client secret', () => {
    const fresh = view({ settings: null, active: false });
    const html = renderToStaticMarkup(<SignInServiceForm {...form({ view: fresh })} />);
    expect(html).toMatch(/<section aria-label="Sign-in service"/);
    expect(html).not.toMatch(/<section aria-label="Join"/);
    for (const label of ['Sign-in button', 'Anyone can join', 'Group']) expect(html).not.toContain(`>${label}</span>`);
    for (const label of ['Name', 'Issuer', 'Client ID', 'Client secret']) expect(html).toContain(`>${label}</span>`);
    expect(elements(SignInServiceForm(form({ view: fresh }))).filter((e) => e.type === SegmentedControl)).toHaveLength(0);
    expect(elements(SignInServiceForm(form({ view: fresh }))).filter((e) => e.type === SettingsSave)).toHaveLength(1);
    // the first save turns the button on and lets nobody join yet: Join's choices come once it is saved
    expect(requestFrom(draftFrom(fresh))).toMatchObject({ enabled: true, joinEnabled: false, joinGroup: null });
  });

  it('once saved, Join shows with its instant choices', () => {
    const html = renderToStaticMarkup(<SignInServiceForm {...form()} />);
    expect(html).toMatch(/<section aria-label="Join"/);
    expect(html).toMatch(/role="radiogroup" aria-label="Sign-in button"/);
  });

  it('Group has its own Save', () => {
    const saves = (p: SignInServiceFormProps) => elements(SignInServiceForm(p)).filter((e) => e.type === SettingsSave);
    const same = saves(form());
    expect(same).toHaveLength(2);
    // the service's Save waits for a typed change, the Group's for its own
    expect(same.map((s) => s.props.dirty)).toEqual([false, false]);
    const group = form({ draft: { ...draftFrom(view()), joinGroup: 'friends' } });
    expect(saves(group).map((s) => s.props.dirty)).toEqual([false, true]);
    (saves(group)[1]!.props.onSave as () => void)();
    expect(group.onSaveGroup).toHaveBeenCalledWith('friends');
    const typed = form({ draft: { ...draftFrom(view()), clientId: 'tagave-2' } });
    expect(saves(typed).map((s) => s.props.dirty)).toEqual([true, false]);
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
