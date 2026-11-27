import { describe, expect, it } from 'vitest';
import { applyToast, diffRowKind, diffValueText, pausedNoticeTone, planRunButtons, planStatusView, planUsesId3 } from './planStatus';

describe('the plan header\'s run buttons', () => {
  it('a waiting plan has Pause and Cancel, like one applying', () => {
    expect(planRunButtons('applying', false)).toBe('pause');
    expect(planRunButtons('waiting', false)).toBe('pause');
    expect(planRunButtons('paused', false)).toBe('resume');
  });
  it('none while an apply task line carries its own actions, and none for other statuses', () => {
    for (const status of ['applying', 'waiting', 'paused']) expect(planRunButtons(status, true), status).toBeNull();
    for (const status of ['draft', 'previewed', 'applied', 'cancelled']) expect(planRunButtons(status, false), status).toBeNull();
  });
});

describe('the paused plan\'s "stopped early" line', () => {
  const OFFLINE = 'Paused while the music folder is offline';
  it('is left out when the apply task line already says the pause, its help and Continue', () => {
    expect(pausedNoticeTone(OFFLINE, true)).toBeNull();
  });
  it('is one quiet line when no task line shows', () => {
    expect(pausedNoticeTone(OFFLINE, false)).toBe('info');
  });
  it('another stop stays a danger line', () => {
    expect(pausedNoticeTone('Disk full', true)).toBe('danger');
    expect(pausedNoticeTone('Disk full', false)).toBe('danger');
  });
});

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
  it('says a plan waits for its music folder, with what that means behind "?"', () => {
    expect(planStatusView('waiting')).toMatchObject({
      label: 'Waiting for the music folder',
      help: 'tagave writes these tags when the folder is back. Nothing is lost.',
    });
    expect(planStatusView('applied').help).toBeUndefined();
  });
  it('tells a plan whose split was cut off by the offline folder to Continue when it is back', () => {
    expect(planStatusView('paused', null, 'Paused while the music folder is offline')).toMatchObject({ label: 'paused', help: 'Press Continue when the folder is back.' });
    expect(planStatusView('paused', null, 'Disk full').help).toBeUndefined();
  });
});

describe('the apply toast', () => {
  it('says the tags are written when the folder is back, only while it waits', () => {
    expect(applyToast({ waiting: true })).toBe('Queued. tagave writes the tags when the music folder is back.');
    expect(applyToast({})).toBeNull();
    expect(applyToast(undefined)).toBeNull();
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
  it('shows an empty value as (empty)', () => {
    expect(diffValueText('')).toBe('(empty)');
    expect(diffValueText(null)).toBe('(empty)');
    expect(diffValueText(['a', 'b'])).toBe('a; b');
  });
});
