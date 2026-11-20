/**
 * Settings › Follow rules on the settings layout (spec §6): a release type
 * saves when ticked, Auto-follow at (typed) with its group's one Save.
 */
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { FollowRulesView, type FollowRulesViewProps } from './SettingsFollowRulesPage';

const RULES = { includePrimary: ['Album', 'EP'], excludeSecondary: ['Live'], autoFollowMinAlbums: 2 };
const render = (over: Partial<FollowRulesViewProps> = {}) => renderToStaticMarkup(
  <FollowRulesView rules={RULES} autoFollow={2} onRules={vi.fn()} onAutoFollow={vi.fn()} onSaveAutoFollow={vi.fn()} {...over} />,
);
const group = (html: string, title: string) => {
  const start = html.search(new RegExp(`<section[^>]* aria-label="${title}"`));
  expect(start, title).toBeGreaterThan(-1);
  return html.slice(start, html.indexOf('</section>', start));
};

describe('Settings › Follow rules', () => {
  it('Include, Exclude, Auto-follow', () => {
    const html = render();
    expect(html.indexOf('aria-label="Include"')).toBeGreaterThan(-1);
    expect(html.indexOf('aria-label="Include"')).toBeLessThan(html.indexOf('aria-label="Exclude"'));
    expect(html.indexOf('aria-label="Exclude"')).toBeLessThan(html.indexOf('aria-label="Auto-follow"'));
    expect(html).not.toMatch(/<h2/);
    expect(html).not.toContain('Loading settings');
  });

  it('a release type saves when ticked', () => {
    const include = group(render(), 'Include');
    expect(include).toContain('>Album</span>');
    expect(include).toMatch(/type="checkbox"[^>]*checked=""/);
    expect(include).not.toMatch(/>Save</);
    expect(group(render(), 'Exclude')).not.toMatch(/>Save</);
    expect(group(render({ changed: 'exclude', status: { state: 'saved' } }), 'Exclude')).toContain('✓ Saved');
  });

  it('Auto-follow has the one Save, disabled until changed', () => {
    const auto = group(render(), 'Auto-follow');
    expect(auto).toContain('>Auto-follow at</span>');
    expect(auto).toContain('>albums</span>');
    expect(auto).toMatch(/<button[^>]*disabled=""[^>]*>(<span[^>]*>)?Save</);
    expect(group(render({ autoFollow: 3 }), 'Auto-follow')).not.toMatch(/<button[^>]*disabled=""[^>]*>(<span[^>]*>)?Save</);
    expect(render()).not.toContain('Reset');
  });
});
