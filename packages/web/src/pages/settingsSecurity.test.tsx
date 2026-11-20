/**
 * Your settings › Account › Security on the settings layout (spec §6):
 * groups in order, help behind `?`, Off and On instead of a checkbox.
 */
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SecurityView } from './SettingsSecurityPage';
import type { SecurityStatus } from './securityModel';

const data: SecurityStatus = {
  config: { publicUrl: 'https://music.example.com', passkeysAvailable: true },
  password: { set: true, changedAt: '2026-10-01T10:00:00.000Z' },
  twoFactor: { enabled: true, backupCodesLeft: 7 },
  passkeys: [],
  trustedDevices: [
    { id: 'd1', userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15', ipAddress: null, createdAt: '2026-11-01T10:00:00.000Z', lastUsedAt: '2026-11-19T10:00:00.000Z', expiresAt: '2026-12-01T10:00:00.000Z', current: true },
  ],
};

const render = (status: SecurityStatus = data) =>
  renderToStaticMarkup(<QueryClientProvider client={new QueryClient()}><SecurityView data={status} email="robin@example.com" /></QueryClientProvider>);
/** The markup with every closed help region taken out. */
const visible = (html: string) => html.replace(/<div[^>]*hidden=""[^>]*>[\s\S]*?<\/div>/g, '');

describe('Your settings › Account › Security', () => {
  it('the groups in order', () => {
    const html = render();
    const at = (title: string) => html.indexOf(`<section aria-label="${title}"`);
    expect(at('Sign-in')).toBeGreaterThan(-1);
    expect(at('Sign-in')).toBeLessThan(at('Authenticator app'));
    expect(at('Authenticator app')).toBeLessThan(at('Backup codes'));
    expect(at('Backup codes')).toBeLessThan(at('Trusted devices'));
    expect(at('Trusted devices')).toBeLessThan(at('Password'));
    expect(html).not.toMatch(/<h2/);
  });

  it('values, not sentences', () => {
    const html = render();
    expect(html).toContain('7 of 10 left');
    expect(html).toMatch(/>On</);
    expect(html).toContain('Turn off');
    const off = render({ ...data, twoFactor: { enabled: false, backupCodesLeft: null }, trustedDevices: [] });
    expect(off).toContain('Not set');
    expect(off).toContain('Set up');
    expect(off).toMatch(/>None</);
    expect(off).not.toContain('aria-label="Backup codes"');
  });

  it('help, not hints', () => {
    const html = render();
    expect(visible(html)).not.toContain('also forgets trusted devices');
    expect(visible(html)).not.toContain('At least 12 characters');
    expect(html).toContain('also forgets trusted devices and backup codes');
    expect(html).toContain('At least 12 characters');
  });

  it('Sign out other devices is Off and On', () => {
    const html = render();
    expect(html).not.toContain('type="checkbox"');
    expect(html).toMatch(/role="radiogroup" aria-label="Sign out other devices"/);
    expect(html).toMatch(/<button[^>]*type="submit"[^>]*>(?:(?!<\/button>)[\s\S])*Change password/);
  });
});
