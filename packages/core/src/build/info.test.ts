/**
 * The version a process reports. Images get TAGAVE_BUILD_VERSION as a build arg;
 * a build without it sets the variable empty, and the root package.json must
 * then win over any baked-in default (the app once reported 0.1.0 at 0.3.0).
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const rootVersion = (JSON.parse(readFileSync(fileURLToPath(new URL('../../../../package.json', import.meta.url)), 'utf-8')) as { version: string }).version;

async function freshBuildInfo() {
  vi.resetModules();
  const mod = await import('./info.js');
  return mod.readBuildInfo();
}

describe('readBuildInfo version', () => {
  const names = ['TAGAVE_BUILD_VERSION', 'LINER_VERSION'] as const;
  const saved = names.map((n) => process.env[n]);
  afterEach(() => {
    names.forEach((n, i) => {
      if (saved[i] === undefined) delete process.env[n];
      else process.env[n] = saved[i];
    });
  });

  it('uses TAGAVE_BUILD_VERSION when a build passed one', async () => {
    process.env['TAGAVE_BUILD_VERSION'] = '9.8.7';
    process.env['LINER_VERSION'] = '1.0.0';
    expect((await freshBuildInfo()).version).toBe('9.8.7');
  });

  it('still reads the pre-0.9 LINER_VERSION when the new name is unset', async () => {
    delete process.env['TAGAVE_BUILD_VERSION'];
    process.env['LINER_VERSION'] = '9.8.6';
    expect((await freshBuildInfo()).version).toBe('9.8.6');
  });

  it('falls back to the root package.json when the version is empty', async () => {
    process.env['TAGAVE_BUILD_VERSION'] = '';
    process.env['LINER_VERSION'] = '';
    expect((await freshBuildInfo()).version).toBe(rootVersion);
  });
});
