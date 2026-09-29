import { describe, expect, it } from 'vitest';
import { diffRowKind, diffValueText, planStatusView, planUsesId3 } from './planStatus';

describe('planStatusView', () => {
  it('calls a plan where every file failed "failed"', () => {
    expect(planStatusView('partially_failed', { applied: 0, failed: 12 })).toEqual({ label: 'failed', tone: 'danger', allFailed: true });
  });
  it('keeps "partially failed" when some files were written', () => {
    expect(planStatusView('partially_failed', { applied: 3, failed: 1 })).toMatchObject({ label: 'partially failed', tone: 'warning', allFailed: false });
  });
  it('keeps the status when counts are unknown', () => {
    expect(planStatusView('partially_failed')).toMatchObject({ label: 'partially failed', allFailed: false });
    expect(planStatusView('applied', { applied: 0, failed: 0 })).toMatchObject({ label: 'applied', tone: 'success' });
  });
});

describe('planUsesId3', () => {
  it('is false for a FLAC-only plan and before the preview', () => {
    expect(planUsesId3(['flac'])).toBe(false);
    expect(planUsesId3([])).toBe(false);
    expect(planUsesId3(undefined)).toBe(false);
  });
  it('is true when an ID3 format is in the plan', () => {
    expect(planUsesId3(['flac', 'mp3'])).toBe(true);
    expect(planUsesId3(['AIFF'])).toBe(true);
  });
});

describe('diffRowKind', () => {
  it('reads a value over an empty tag as an add, whatever the policy', () => {
    expect(diffRowKind({ before: '', after: '1', reason: 'policy:overwrite' })).toBe('add');
    expect(diffRowKind({ before: null, after: '1', reason: 'policy:overwrite' })).toBe('add');
    expect(diffRowKind({ before: [], after: ['a'], reason: 'policy:fill' })).toBe('add');
  });
  it('keeps overwrite for a real change, and locked/revert as they are', () => {
    expect(diffRowKind({ before: '0', after: '1', reason: 'policy:overwrite' })).toBe('overwrite');
    expect(diffRowKind({ before: null, after: null, reason: 'locked' })).toBe('locked');
    expect(diffRowKind({ before: null, after: 'x', reason: 'revert' })).toBe('revert');
  });
  it('shows an empty value as a dash', () => {
    expect(diffValueText('')).toBe('—');
    expect(diffValueText(null)).toBe('—');
    expect(diffValueText(['a', 'b'])).toBe('a; b');
  });
});
