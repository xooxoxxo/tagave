import { describe, expect, it } from 'vitest';
import { passkeyProblem, accountHealth, backupCodesFile, deviceLabel, passkeyKind, passkeyLabel, type PasskeyView, type SecurityStatus } from './securityModel';

const base: SecurityStatus = {
  config: { publicUrl: 'https://music.example.com', passkeysAvailable: true },
  password: { set: true, changedAt: null },
  twoFactor: { enabled: false, backupCodesLeft: null },
  passkeys: [],
  trustedDevices: [],
};

const key = (over: Partial<PasskeyView> = {}): PasskeyView => ({
  id: 'p', name: null, aaguid: null, deviceType: 'singleDevice', backedUp: false, transports: ['usb'], createdAt: null, ...over,
});

describe('accountHealth', () => {
  it('warns loudly with no second factor', () => {
    expect(accountHealth(base)).toMatchObject({ tone: 'danger', factors: 0 });
    expect(accountHealth(base).text).toBe('No second factor');
  });

  it('asks for a second factor with one, mentioning backup codes', () => {
    const h = accountHealth({ ...base, twoFactor: { enabled: true, backupCodesLeft: 9 } });
    expect(h).toMatchObject({ tone: 'warning', factors: 1 });
    expect(h.text).toContain('9 backup codes');
    expect(accountHealth({ ...base, passkeys: [key()] }).text).toMatch(/locks you out/);
  });

  it('is content with two', () => {
    expect(accountHealth({ ...base, passkeys: [key(), key({ id: 'q' })] })).toEqual({
      tone: 'success',
      factors: 2,
      text: '2 factors',
    });
  });
});

describe('labels', () => {
  it('names browsers and systems', () => {
    expect(deviceLabel('Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15')).toBe('Safari on macOS');
    expect(deviceLabel('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36 Edg/129.0')).toBe('Edge on Windows');
    expect(deviceLabel('Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0')).toBe('Firefox on Linux');
    expect(deviceLabel(null)).toBe('Unknown browser');
  });

  it('names passkeys by their name, their model, or their kind', () => {
    expect(passkeyLabel(key({ name: ' Desk key ' }))).toBe('Desk key');
    expect(passkeyLabel(key({ aaguid: 'FA2B99DC-9E39-4257-8F92-4A30D23C4118' }))).toBe('YubiKey 5 NFC');
    expect(passkeyLabel(key())).toBe('Security key');
    expect(passkeyLabel(key({ transports: ['internal'] }))).toBe('Passkey');
    expect(passkeyKind(key())).toBe('On this key or device only');
    expect(passkeyKind(key({ backedUp: true, deviceType: 'multiDevice' }))).toBe('Synced passkey');
  });
});

describe('backupCodesFile', () => {
  it('lists every code with what they are for', () => {
    const text = backupCodesFile(['aaaaa-11111', 'bbbbb-22222'], 'me@example.com', 'https://music.example.com', new Date('2026-10-10T12:00:00Z'));
    expect(text).toContain('me@example.com');
    expect(text).toContain('https://music.example.com - made 2026-10-10');
    expect(text).toContain('aaaaa-11111\nbbbbb-22222');
  });
});

describe('passkeyProblem', () => {
  it('is quiet on the PUBLIC_URL origin', () => {
    expect(passkeyProblem(base.config, 'https://music.example.com')).toBeNull();
  });
  it('names PUBLIC_URL when the page is elsewhere', () => {
    expect(passkeyProblem(base.config, 'http://192.168.1.5:3100')).toMatch(/tied to https:\/\/music\.example\.com/);
  });
  it('explains https', () => {
    expect(passkeyProblem({ publicUrl: 'http://10.0.0.2:3100', passkeysAvailable: false }, 'http://10.0.0.2:3100')).toMatch(/need https/);
  });
});
