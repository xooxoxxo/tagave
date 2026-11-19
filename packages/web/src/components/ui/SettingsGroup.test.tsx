import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { SettingsGroup, SettingsRow } from './SettingsGroup';
import { HelpToggle } from './HelpToggle';

const stripComments = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, '');
const css = stripComments(readFileSync(new URL('./SettingsGroup.module.css', import.meta.url), 'utf8'));

describe('SettingsGroup', () => {
  it('renders a labelled section with an h3 title', () => {
    const html = renderToStaticMarkup(<SettingsGroup title="Weekly"><SettingsRow label="Keep"><select /></SettingsRow></SettingsGroup>);
    expect(html).toMatch(/^<section aria-label="Weekly"/);
    expect(html).toContain('<h3');
    expect(html).toMatch(/<h3[^>]*>Weekly<\/h3>/);
  });

  it('shows no help button without help', () => {
    const html = renderToStaticMarkup(<SettingsGroup title="Weekly"><SettingsRow label="Keep"><select /></SettingsRow></SettingsGroup>);
    expect(html).not.toContain('aria-expanded');
  });

  it('shows a help button beside the title when there is help', () => {
    const html = renderToStaticMarkup(<SettingsGroup title="Weekly" help="Kept for a week">rows</SettingsGroup>);
    expect(html).toContain('aria-label="Help: Weekly"');
    expect(html.indexOf('</h3>')).toBeLessThan(html.indexOf('aria-label="Help: Weekly"'));
  });
});

describe('SettingsRow', () => {
  it('defaults to a label element and puts the label first', () => {
    const html = renderToStaticMarkup(<SettingsRow label="Keep"><select /></SettingsRow>);
    expect(html).toMatch(/^<label/);
    expect(html.indexOf('Keep')).toBeLessThan(html.indexOf('<select'));
  });

  it('renders a div when the control is a group', () => {
    const html = renderToStaticMarkup(<SettingsRow label="Keep" as="div"><div role="radiogroup" /></SettingsRow>);
    expect(html).toMatch(/^<div/);
  });

  it('keeps the help button out of the label, so the label still names the control', () => {
    const html = renderToStaticMarkup(<SettingsRow label="Time" help="UTC"><select /></SettingsRow>);
    const label = html.match(/<label[\s\S]*?<\/label>/)?.[0] ?? '';
    expect(label).toContain('<select');
    expect(label).not.toContain('<button');
    expect(html).toContain('aria-label="Help: Time"');
  });
});

describe('HelpToggle', () => {
  it('starts closed', () => {
    const html = renderToStaticMarkup(<HelpToggle label="Keep">How many to keep</HelpToggle>);
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('aria-label="Help: Keep"');
    const controls = html.match(/aria-controls="([^"]+)"/)?.[1];
    expect(controls).toBeTruthy();
    expect(html).toMatch(new RegExp(`<div[^>]*id="${controls}"[^>]*hidden=""`));
    expect(html).toContain('How many to keep');
  });
});

describe('SettingsGroup CSS', () => {
  it('rows are divided by a hairline', () => {
    expect(css).toMatch(/\.row \+ \.row\s*\{[^}]*border-top:\s*1px solid var\(--line\)/);
  });
});
