/**
 * Your settings › DJ on the settings layout (spec §6): one group of
 * single choices, each saved when changed, so no Save.
 */
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { DJ_DEFAULTS } from '@tagave/shared';
import { SettingsDjView } from './SettingsDjPage';

const noop = () => undefined;
const render = (over: Partial<Parameters<typeof SettingsDjView>[0]> = {}) =>
  renderToStaticMarkup(<SettingsDjView availableHere settings={DJ_DEFAULTS} onChange={noop} {...over} />);

describe('Your settings › DJ', () => {
  it('one group, four rows, no Save', () => {
    const html = render();
    expect(html).toMatch(/<section aria-label="DJ"/);
    const at = (label: string) => html.indexOf(`>${label}<`);
    expect(at('Crossfade')).toBeGreaterThan(-1);
    expect(at('Crossfade')).toBeLessThan(at('Length'));
    expect(at('Length')).toBeLessThan(at('Beat-aligned'));
    expect(at('Beat-aligned')).toBeLessThan(at('Gapless albums'));
    expect(html).not.toMatch(/>Save</);
    expect(html).not.toMatch(/<h2/);
    expect(html).toMatch(/role="radiogroup" aria-label="Beat-aligned"/);
  });

  it('Length waits for a fixed crossfade', () => {
    expect(render()).toMatch(/<select[^>]*disabled=""/);
    expect(render({ settings: { ...DJ_DEFAULTS, crossfade: 'fixed' } })).not.toMatch(/<select[^>]*disabled=""/);
  });

  it('the save shows in the head', () => {
    expect(render({ state: 'saved' })).toContain('✓ Saved');
    expect(render({ state: 'failed' })).toMatch(/role="alert">Not saved</);
  });

  it('a home-screen app says so as a value', () => {
    const html = render({ availableHere: false });
    expect(html).toMatch(/<section aria-label="DJ"/);
    expect(html).toContain('Not on this device');
    expect(html).not.toContain('radiogroup');
  });
});
