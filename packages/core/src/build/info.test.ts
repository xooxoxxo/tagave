/**
 * The version a process reports. Images get LINER_VERSION as a build arg;
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
  const saved = process.env['LINER_VERSION'];
  afterEach(() => {
    if (saved === undefined) delete process.env['LINER_VERSION'];
    else process.env['LINER_VERSION'] = saved;
  });

  it('uses LINER_VERSION when a build passed one', async () => {
    process.env['LINER_VERSION'] = '9.8.7';
    expect((await freshBuildInfo()).version).toBe('9.8.7');
  });

  it('falls back to the root package.json when LINER_VERSION is empty', async () => {
    process.env['LINER_VERSION'] = '';
    expect((await freshBuildInfo()).version).toBe(rootVersion);
  });
});
