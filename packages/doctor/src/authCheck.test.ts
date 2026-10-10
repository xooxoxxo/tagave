import { describe, expect, it } from 'vitest';
import { checkPublicUrl } from './authCheck.js';
import { remediationFor } from './remediation.js';

describe('checkPublicUrl (no database)', () => {
  it('warns when PUBLIC_URL is unset, with a fix', async () => {
    const check = await checkPublicUrl(undefined, {});
    expect(check).toMatchObject({ id: 'publicUrl', status: 'warn' });
    expect(check.detail).toMatch(/not set here/);
    expect(remediationFor(check)).toMatch(/does not start without it/);
  });

  it('fails on a malformed PUBLIC_URL', async () => {
    const check = await checkPublicUrl(undefined, { PUBLIC_URL: 'https://example.com/tagave' });
    expect(check.status).toBe('fail');
    expect(remediationFor(check)).toMatch(/scheme, host and port/);
  });

  it('warns that passkeys need https off localhost', async () => {
    const check = await checkPublicUrl(undefined, { PUBLIC_URL: 'http://192.168.1.5:3100' });
    expect(check.status).toBe('warn');
    expect(check.detail).toMatch(/https or localhost/);
  });

  it('passes for an https URL', async () => {
    expect(await checkPublicUrl(undefined, { PUBLIC_URL: 'https://music.example.com' })).toMatchObject({
      status: 'pass',
      detail: 'https://music.example.com',
    });
  });
});
