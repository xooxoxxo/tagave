import { describe, expect, it } from 'vitest';
import { stepUpErrorMessage } from './stepUp';

const dom = (name: string) => Object.assign(new Error('x'), { name });

describe('stepUpErrorMessage', () => {
  it('says the passkey wait ran out, and how long it was', () => {
    expect(stepUpErrorMessage(dom('TimeoutError'))).toMatch(/within 60 seconds/);
  });

  it('explains a closed prompt or a passkey without PIN or fingerprint check', () => {
    expect(stepUpErrorMessage(dom('NotAllowedError'))).toMatch(/closed or timed out.*PIN or fingerprint/);
  });

  it('names another open passkey request', () => {
    expect(stepUpErrorMessage(dom('InvalidStateError'))).toMatch(/Another passkey request/);
    expect(stepUpErrorMessage(dom('OperationError'))).toMatch(/Another passkey request/);
  });

  it('points at PUBLIC_URL for a wrong address', () => {
    const msg = stepUpErrorMessage(dom('SecurityError'), 'http://192.168.1.5:3100');
    expect(msg).toContain('PUBLIC_URL');
    expect(msg).toContain('http://192.168.1.5:3100');
  });

  it('shows the server answer for a refused passkey, code or password', () => {
    expect(stepUpErrorMessage({ status: 401, title: 'Unauthorized', detail: 'The passkey was not accepted.' })).toBe('The passkey was not accepted.');
  });

  it('has a fallback', () => {
    expect(stepUpErrorMessage(null)).toMatch(/did not work/);
  });
});
