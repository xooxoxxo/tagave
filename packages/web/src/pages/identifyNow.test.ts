import { describe, expect, it } from 'vitest';
import { actionProblem, identifyNowNote, identifyProgressLine } from './identifyNow';

describe('actionProblem', () => {
  it('shows what the server said', () => {
    expect(actionProblem({ status: 500, title: 'Internal Server Error', detail: 'cannot cast type record to uuid[]' }, 'Could not queue the albums.'))
      .toBe('cannot cast type record to uuid[]');
    expect(actionProblem({ status: 502, title: 'Bad Gateway' }, 'Could not queue the albums.')).toBe('Bad Gateway');
  });

  it('falls back when nothing came back', () => {
    expect(actionProblem(new TypeError('Failed to fetch'), 'Could not queue the albums.')).toBe('Could not queue the albums.');
    expect(actionProblem(undefined, 'Could not queue the albums.')).toBe('Could not queue the albums.');
  });
});

describe('identifyNowNote', () => {
  it('says how many albums were queued', () => {
    expect(identifyNowNote({ waiting: 7, enqueued: 7 })).toBe('7 albums queued');
    expect(identifyNowNote({ waiting: 1, enqueued: 1 })).toBe('1 album queued');
  });

  it('says when there is nothing to do', () => {
    expect(identifyNowNote({ waiting: 0, enqueued: 0 })).toBe('Nothing to identify');
  });

  it('says when every waiting album already has a job', () => {
    expect(identifyNowNote({ waiting: 3, enqueued: 0 })).toBe('Already queued');
  });

  it('says nothing for an older server that answered { ok: true }', () => {
    expect(identifyNowNote({ ok: true })).toBeNull();
    expect(identifyNowNote(undefined)).toBeNull();
  });
});

describe('identifyProgressLine', () => {
  const queue = { queued: 0, active: 0, retry: 0 };
  it('shows the rate and time left while albums are being decided', () => {
    expect(identifyProgressLine({ perMin: 2, etaSeconds: 180, queue, workerLive: true })).toMatch(/^2\/min · .* left$/);
  });

  it('says it is working while a job runs', () => {
    expect(identifyProgressLine({ perMin: 0, etaSeconds: null, queue: { ...queue, active: 1 }, workerLive: true })).toBe('Working');
  });

  it('waits for the worker only while jobs are queued and a worker is alive', () => {
    expect(identifyProgressLine({ perMin: 0, etaSeconds: null, queue: { ...queue, queued: 4 }, workerLive: true })).toBe('Waiting for the worker');
    expect(identifyProgressLine({ perMin: 0, etaSeconds: null, queue: { ...queue, queued: 4 }, workerLive: undefined })).toBe('Waiting for the worker');
  });

  it('says no worker is running instead of waiting for one', () => {
    expect(identifyProgressLine({ perMin: 0, etaSeconds: null, queue: { ...queue, queued: 4 }, workerLive: false })).toBe('No worker is running');
  });

  it('says nothing is queued instead of waiting for nothing', () => {
    expect(identifyProgressLine({ perMin: 0, etaSeconds: null, queue, workerLive: true })).toBe('Nothing queued');
  });
});
