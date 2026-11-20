/**
 * Your settings › Appearance on the settings layout (spec §6): a group per
 * subject, each setting a row, no heading per setting.
 */
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { YouAppearanceView } from './YouAppearance';
import { ThemeGroup } from '../themes/ThemeSetting';

const render = () => renderToStaticMarkup(<YouAppearanceView theme={<ThemeGroup>gallery</ThemeGroup>} />);
/** One group's markup, from its section to the next. */
const group = (html: string, title: string) => {
  const start = html.search(new RegExp(`<section[^>]* aria-label="${title}"`));
  expect(start, title).toBeGreaterThan(-1);
  return html.slice(start, html.indexOf('</section>', start));
};

describe('Your settings › Appearance', () => {
  it('groups, not a heading per setting', () => {
    const html = render();
    expect(html).not.toMatch(/<h2/);
    const sidebar = group(html, 'Sidebar');
    for (const label of ['Sidebar', 'Search box', 'Wordmark']) expect(sidebar).toContain(`>${label}</span>`);
    expect(group(html, 'Theme')).toContain('>Light and dark</span>');
    expect(group(html, 'Albums')).toContain('>Short albums</span>');
    expect(group(html, 'Albums')).toContain('>Genre</span>');
    expect(group(html, 'Artists')).toContain('>Artist page</span>');
    expect(group(html, 'Player')).toContain('>Equalizer glow</span>');
  });

  it('every control sits in a row', () => {
    const html = render();
    const controls = html.match(/role="radiogroup"|<select/g) ?? [];
    expect(controls.length).toBeGreaterThan(8);
    // each control's nearest row: the count of rows is at least the count of controls
    const rows = html.match(/class="_row_[^"]*"/g) ?? [];
    expect(rows.length).toBeGreaterThanOrEqual(controls.length);
    expect(html).not.toMatch(/<\/section>\s*<div role="radiogroup"/);
  });

  it('the album header link still lands', () => {
    expect(render()).toMatch(/<section id="album-widgets" aria-label="Albums"/);
  });
});
