/**
 * The wantlist panel: suggestions with Accept / Dismiss, the reason as text
 * (never HTML), the app's 403 or 404 shown on the row, and the wantlist kept
 * in tagave. Hidden suggestions when Music Connections is off.
 */
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { WantlistView } from '@tagave/shared';
import { WantlistPanel, decisionError } from './WantlistSection';

const view: WantlistView = {
  available: true,
  suggestions: [{
    id: 's1', linkId: 'l1', service: 'review-gatherer', artist: 'Neu!', title: 'Neu! 75', releaseGroupId: null, rgMbid: null,
    reason: '<img src=x onerror=alert(1)> You rate Neu! highly', score: 8.5, suggestedAt: '2026-10-01T00:00:00.000Z', decision: null, decidedAt: null,
  }, {
    id: 's2', linkId: 'l1', service: 'review-gatherer', artist: 'Can', title: 'Ege Bamyasi', releaseGroupId: null, rgMbid: null,
    reason: 'Decided already', score: null, suggestedAt: '2026-10-01T00:00:00.000Z', decision: 'dismissed', decidedAt: '2026-10-02T00:00:00.000Z',
  }],
  wantlist: [{ id: 'w1', artist: 'Harmonia', title: 'Musik von Harmonia', releaseGroupId: null, releaseGroupMbid: null, discogsReleaseId: 1, dateAdded: '2026-10-03T00:00:00.000Z' }],
};
const noop = () => undefined;

describe('WantlistPanel', () => {
  it('lists undecided suggestions with Accept and Dismiss, and the wantlist', () => {
    const html = renderToStaticMarkup(<WantlistPanel view={view} onDecide={noop} />);
    expect(html).toContain('Neu! 75');
    expect(html).toContain('From review-gatherer · score 8.5 of 10');
    expect(html).toContain('Accept Neu! 75 by Neu!');
    expect(html).toContain('Dismiss Neu! 75 by Neu!');
    expect(html).not.toContain('Ege Bamyasi');
    expect(html).toContain('Musik von Harmonia');
  });

  it('sets the other app’s reason as text, never as HTML', () => {
    const html = renderToStaticMarkup(<WantlistPanel view={view} onDecide={noop} />);
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });

  it('shows the app’s 403 or 404 on the row', () => {
    const e403 = decisionError({ status: 502, detail: 'review-gatherer refused the decision (403): this connection may not send decisions.' });
    const e404 = decisionError({ status: 502, detail: 'review-gatherer no longer has this suggestion (404). It will drop off at the next sync.' });
    expect(renderToStaticMarkup(<WantlistPanel view={view} errors={{ s1: e403 }} onDecide={noop} />)).toContain('refused the decision (403)');
    const html = renderToStaticMarkup(<WantlistPanel view={view} errors={{ s1: e404 }} onDecide={noop} />);
    expect(html).toContain('role="alert"');
    expect(html).toContain('no longer has this suggestion (404)');
    expect(decisionError(null)).toBe('The decision did not go through. Try again.');
  });

  it('with Music Connections off there are no suggestions, only the wantlist', () => {
    const html = renderToStaticMarkup(<WantlistPanel view={{ ...view, available: false }} onDecide={noop} />);
    expect(html).not.toContain('>Suggestions<');
    expect(html).toContain('Musik von Harmonia');
  });
});
