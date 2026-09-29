/**
 * The App Secret check as Settings › System status shows it: plain words,
 * never an environment variable name or a raw length readout.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { checkAppSecret } from './checks.js';

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
