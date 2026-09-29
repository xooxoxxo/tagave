import { describe, expect, it } from 'vitest';
import { identifyRateLine, summaryMessage } from './jobsSummary';

const quiet = { running: 0, waiting: 0, needsAttention: 0, lastFinishedAt: '2026-09-28T10:00:00.000Z', queue: { waiting: 0, active: 0 } };
const base = { runningNames: [], anyRetryable: false, relative: () => '5 minutes ago' };

describe('summaryMessage', () => {
  it('says all caught up only when nothing runs, nothing waits and no album is waiting', () => {
    const m = summaryMessage({ ...base, summary: quiet, pendingAlbums: 0 });
    expect(m.tone).toBe('success');
    expect(m.lead).toBe('All caught up.');
  });

  it('does not say all caught up while albums wait to be identified', () => {
    const m = summaryMessage({ ...base, summary: quiet, pendingAlbums: 27902 });
    expect(m.lead).not.toMatch(/caught up/);
    expect(m.text).toContain('27,902 albums');
  });

  it('counts the background queue, which most small tasks never leave a row for', () => {
    const m = summaryMessage({ ...base, summary: { ...quiet, queue: { waiting: 7374, active: 1 } } });
    expect(m.lead).toBe('Working.');
    expect(m.text).toContain('7,374 tasks waiting to start');
    expect(m.text).toContain('1 task running');
  });

  it('puts tasks that need the owner first', () => {
    const m = summaryMessage({ ...base, summary: { ...quiet, needsAttention: 2, queue: { waiting: 5, active: 0 } }, pendingAlbums: 3 });
    expect(m.tone).toBe('danger');
    expect(m.text).toMatch(/They cannot be restarted/);
  });

  it('never renders undefined, even from an older API without queue counts', () => {
    const { queue: _queue, ...old } = quiet;
    for (const pendingAlbums of [undefined, 0, 1]) {
      const m = summaryMessage({ ...base, summary: old, pendingAlbums });
      expect(`${m.lead} ${m.text}`).not.toContain('undefined');
    }
  });
});

describe('identifyRateLine', () => {
  it('never says "about 0 albums a minute": a slow rate is given per hour', () => {
    expect(identifyRateLine({ perMin: 0.4 }, 480)).toBe('About 24 albums an hour, done in about 8 min.');
    expect(identifyRateLine({ perMin: 12.3 }, 480)).toBe('About 12 albums a minute, done in about 8 min.');
  });
  it('has no line, and so no finish time, without a rate', () => {
    expect(identifyRateLine({ perMin: 0 }, 480)).toBeNull();
    expect(identifyRateLine({ perMin: 0.001 }, 480)).toBeNull();
  });
  it('drops the finish time when there is none', () => {
    expect(identifyRateLine({ perMin: 1 }, null)).toBe('About 1 album a minute.');
    expect(identifyRateLine({ perMin: 3 }, 30)).toBe('About 3 albums a minute, done in under a minute.');
    expect(identifyRateLine({ perMin: 3 }, 3 * 3600 + 600)).toBe('About 3 albums a minute, done in about 3 h 10 min.');
  });
});
