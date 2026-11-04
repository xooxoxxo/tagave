/**
 * The equalizer glow's states: on only while music plays here, still where
 * the music cannot be read, held when a story passes its levels.
 */
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { BarGlow } from './BarGlow';

describe('BarGlow', () => {
  it('off while paused (or stopped, or casting: the player passes playing=false)', () => {
    const html = renderToStaticMarkup(<BarGlow playing={false} anchor="right" />);
    expect(html).toContain('data-on="false"');
    expect(html).toContain('data-anchor="right"');
  });

  it('playing without an analyser (iOS, before Web Audio starts): the still glow', () => {
    expect(renderToStaticMarkup(<BarGlow playing />)).toMatch(/data-on="true" data-mode="still"/);
  });

  it('a source that reads levels: live; levels held: held', () => {
    expect(renderToStaticMarkup(<BarGlow playing source={() => undefined} />)).toContain('data-mode="live"');
    expect(renderToStaticMarkup(<BarGlow playing levels={[0.5]} />)).toContain('data-mode="held"');
  });

  it('one canvas and one line, hidden from assistive technology', () => {
    const html = renderToStaticMarkup(<BarGlow playing />);
    expect(html).toContain('aria-hidden="true"');
    expect(html.match(/<canvas/g)).toHaveLength(1);
  });
});
