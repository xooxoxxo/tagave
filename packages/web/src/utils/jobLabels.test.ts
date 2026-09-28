import { describe, expect, it } from 'vitest';
import { jobStateLabel, jobTypeLabel } from './jobLabels';

describe('job labels', () => {
  it('names known job types in plain words', () => {
    expect(jobTypeLabel('tags.preview')).toBe('Tag plan preview');
    expect(jobTypeLabel('worker.heartbeat')).toBe('Worker check-in');
  });
  it('never shows a dotted id for an unknown type', () => {
    expect(jobTypeLabel('fingerprint.sweep')).toBe('Fingerprint sweep');
    expect(jobTypeLabel('')).toBe('Background job');
  });
  it('capitalises states, and names a created job queued', () => {
    expect(jobStateLabel('created')).toBe('Queued');
    expect(jobStateLabel('running')).toBe('Running');
    expect(jobStateLabel('')).toBe('Unknown');
  });
});
