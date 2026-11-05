/**
 * A tag plan's splits on the plan page (0089): one line by state, the new
 * files once the cuts are found, Check cuts while ready; and Tag… in the
 * album's ⋮ for library care.
 */
import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { PlanSplit } from '@tagave/shared';
import { PlanSplits, splitStateLine } from './PlanSplits';
import { albumMenu } from './albumActions';

const split = (over: Partial<PlanSplit>): PlanSplit => ({
  splitId: 's1', albumId: 'a1', state: 'ready', tracks: 2, low: 0, medium: 0, error: null, outputs: null,
  plan: {
    sampleRate: 44100, channels: 2, bitsPerSample: 16, totalSamples: 44100 * 300,
    tracks: [
      { n: 1, disc: 1, position: 1, title: 'One', startSample: 0, endSample: 44100 * 180, fileName: '01 - One.flac', shiftMs: null, confidence: null },
      { n: 2, disc: 1, position: 2, title: 'Two', startSample: 44100 * 180, endSample: 44100 * 300, fileName: '02 - Two.flac', shiftMs: 400, confidence: 'low' },
    ],
  },
  ...over,
});

describe('a plan\'s splits', () => {
  it('says where each stands in one line', () => {
    expect(splitStateLine(split({ state: 'analyzing' }))).toBe('Finding cut points · 2 tracks');
    expect(splitStateLine(split({ low: 1 }))).toBe('Splits into 2 tracks first · 1 Low cut');
    expect(splitStateLine(split({ state: 'splitting' }))).toBe('Splitting into 2 tracks…');
    expect(splitStateLine(split({ state: 'done' }))).toBe('Split into 2 tracks · tagged');
    expect(splitStateLine(split({ state: 'failed', error: 'The music folder is read-only' }))).toBe('Split stopped: The music folder is read-only');
    expect(splitStateLine(split({ state: 'undone' }))).toBe('Split undone');
  });

  it('lists the new files with their lengths and the cuts to check', () => {
    const html = renderToStaticMarkup(<PlanSplits splits={[split({ low: 1 })]} onCheck={() => undefined} />);
    expect(html).toContain('01 - One.flac');
    expect(html).toContain('3:00');
    expect(html).toContain('02 - Two.flac');
    expect(html).toContain('2:00');
    expect(html).toContain('Low');
    expect(html).toContain('Check cuts');
    expect(renderToStaticMarkup(<PlanSplits splits={[]} onCheck={null} />)).toBe('');
  });
});

describe('Tag… in the album ⋮', () => {
  const base = { maintenance: false, artists: [], onInfo: () => undefined, onToggleMaintenance: () => undefined, tag: () => undefined };
  it('is there for library care only', () => {
    expect(albumMenu({ ...base, canCare: true }).rows.map((r) => r.key)).toContain('tag');
    expect(albumMenu({ ...base, canCare: false }).rows.map((r) => r.key)).not.toContain('tag');
  });
});
