/**
 * The App Secret check as Settings › System status shows it: plain words,
 * never an environment variable name or a raw length readout.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkAppSecret, getMigrationFiles } from './checks.js';

const saved = process.env.APP_SECRET;

describe('checkAppSecret wording', () => {
  afterEach(() => {
    if (saved === undefined) delete process.env.APP_SECRET;
    else process.env.APP_SECRET = saved;
  });

  it('skips in plain words when no secret is set and nothing needs one', async () => {
    delete process.env.APP_SECRET;
    const check = await checkAppSecret();
    expect(check.status).toBe('skip');
    expect(check.detail).not.toMatch(/APP_SECRET|Worker host/);
  });

  it('passes without a length readout', async () => {
    process.env.APP_SECRET = 'a'.repeat(40) + 'Zz!';
    const check = await checkAppSecret();
    expect(check).toMatchObject({ status: 'pass', detail: 'Set and long enough' });
  });

  it('fails a short secret with a plural count', async () => {
    process.env.APP_SECRET = 'short';
    const check = await checkAppSecret();
    expect(check.status).toBe('fail');
    expect(check.detail).toBe('The secret is too short: 5 characters, it needs at least 32');
  });

  it('warns on a short hex secret', async () => {
    process.env.APP_SECRET = 'ab'.repeat(20);
    const check = await checkAppSecret();
    expect(check.status).toBe('warn');
    expect(check.detail).not.toMatch(/</);
  });
});

describe('the migrations this build carries', () => {
  it('lists the core chain, then each module\u2019s; fails loudly on a bad folder or none at all', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tagave-chk-migs-'));
    try {
      await expect(getMigrationFiles(dir)).rejects.toThrow(/no migration files/);
      await writeFile(join(dir, '0001_a.sql'), '');
      await mkdir(join(dir, 'modules', 'decider'), { recursive: true });
      await writeFile(join(dir, 'modules', 'decider', '0001_d.sql'), '');
      expect(await getMigrationFiles(dir)).toEqual(['0001_a.sql', 'decider/0001_d.sql']);
      await mkdir(join(dir, 'modules', 'Not_An_Id'));
      await expect(getMigrationFiles(dir)).rejects.toThrow(/not a module id/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
    // this build's own
    expect((await getMigrationFiles()).length).toBeGreaterThan(60);
  });
});
