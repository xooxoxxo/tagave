import { describe, it, expect } from 'vitest';
import { failureReason } from './batchFailure.js';

describe('failureReason', () => {
  it('labels a stopped run without its raw text', () => {
    expect(failureReason(Object.assign(new Error('deadlock detected'), { code: '40P01' }))).toBe('database error');
    expect(failureReason(Object.assign(new Error('write CONNECTION_CLOSED'), { code: 'CONNECTION_CLOSED' }))).toBe('lost connection');
    expect(failureReason(Object.assign(new Error('terminating connection'), { code: '08006' }))).toBe('lost connection');
    expect(failureReason(Object.assign(new Error('x'), { code: 'ECONNRESET' }))).toBe('lost connection');
    expect(failureReason(new RangeError('bad input'))).toBe('invalid item');
    expect(failureReason('boom')).toBe('unexpected error');
    expect(failureReason(new Error('select * from secrets'))).toBe('unexpected error');
  });
});
