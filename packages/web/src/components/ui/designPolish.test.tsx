import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { Button } from './Button';
import { CoverArt, CoverChip, coverInitials } from './CoverArt';

const stripComments = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, '');
const read = (rel: string) => stripComments(readFileSync(new URL(rel, import.meta.url), 'utf8'));
const rule = (css: string, selector: RegExp) => css.match(new RegExp(`${selector.source}\\s*\\{([^}]*)\\}`))?.[1] ?? '';

describe('button motion', () => {
  const css = read('./Button.module.css');

  it('never moves the capsule on hover: no transform, no scale, no filter', () => {
    const hovers = [...css.matchAll(/\n\.[\w-]+:hover:not\([^)]*\)[^{]*\{([^}]*)\}/g)].map((m) => m[1] ?? '');
    expect(hovers.length).toBeGreaterThan(0);
    for (const hover of hovers) expect(hover).not.toMatch(/transform|scale|filter|translate/);
    // hover lights the surface instead: the sheen brightens
    expect(rule(css, /\n\.button:hover:not\([^)]*\)/)).toMatch(/--b-sheen-boost:\s*0\.\d+/);
  });

  it('keeps the outer drop shadow of rest on hover and press (nothing lifts or grows)', () => {
    const outer = /0 10px 22px -10px color-mix\(in srgb, var\(--b-glow\) 70%, transparent\)/;
    expect(rule(css, /\n\.button/)).toMatch(outer);
    expect(rule(css, /\n\.button:hover:not\([^)]*\)/)).toMatch(outer);
    expect(rule(css, /\n\.button:active:not\([^)]*\)/)).toMatch(outer);
  });

  it('presses as an inset: the element stays put, the label sinks and springs back', () => {
    const active = rule(css, /\n\.button:active:not\([^)]*\)/);
    expect(active).not.toMatch(/transform/);
    expect(active).toMatch(/inset 0 3px 7px/);
    for (const m of css.slice(0, css.indexOf('prefers-reduced-motion')).matchAll(/\n[^{]*:active[^{]*\{([^}]*)\}/g)) {
      const block = m[0];
      if (/>\s*\.label/.test(block)) expect(block).toMatch(/transform:\s*translateY\(1px\)/);
      else expect(m[1]).not.toMatch(/transform|scale/);
    }
    expect(rule(css, /\n\.button/)).toMatch(/transform:\s*none/);
    expect(rule(css, /\n\.label/)).toMatch(/transition:\s*transform var\(--dur-pop\) var\(--ease-pop\)/);
  });

  it('drops every transform under reduced motion', () => {
    const reduced = css.slice(css.indexOf('prefers-reduced-motion'));
    expect(reduced).toMatch(/\.button:active:not\(:disabled\) > \.label\s*\{\s*transform:\s*none/);
  });

  it('has a quiet danger variant with no fill, in the danger ink', () => {
    expect(rule(css, /\n\.quiet-danger/)).toMatch(/--b-ink:\s*var\(--danger\)/);
    const html = renderToStaticMarkup(<Button variant="quiet-danger">Delete</Button>);
    expect(html).toMatch(/class="[^"]*quiet-danger/);
  });
});

describe('no danger drop at rest on a page', () => {
  const src = fileURLToPath(new URL('../../', import.meta.url));
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.tsx$/.test(name) && !/\.test\.tsx$/.test(name)) files.push(full);
    }
  };
  walk(src);

  it('uses variant="danger" only in the confirm dialog and the catalogue', () => {
    const offenders = files
      .filter((f) => !/ConfirmDialog\.tsx$|DesignSystemCatalog\.tsx$/.test(f))
      .filter((f) => /variant=(\{[^}]*'danger'|"danger")/.test(readFileSync(f, 'utf8')));
    expect(offenders.map((f) => f.slice(src.length))).toEqual([]);
  });
});

describe('CoverArt', () => {
  it('takes initials from the title, skipping a leading article', () => {
    expect(coverInitials('Drums and Wires')).toBe('DA');
    expect(coverInitials('The Big Express')).toBe('BE');
    expect(coverInitials('Skylarking')).toBe('S');
    expect(coverInitials('ägaetis byrjun')).toBe('ÄB');
    expect(coverInitials('The')).toBe('T');
    expect(coverInitials('...')).toBe('·');
  });

  it('draws a placeholder without emoji or counts when there is no art', () => {
    const html = renderToStaticMarkup(<CoverArt title="Black Sea" />);
    expect(html).not.toMatch(/🎵|♫|♪/u);
    expect(html).toContain('>BS<');
    expect(html).not.toContain('<img');
  });

  it('keeps overlays outside the faded art', () => {
    const html = renderToStaticMarkup(
      <CoverArt title="Black Sea" src="/x.jpg" dimmed="missing"><CoverChip tone="warn">Missing</CoverChip></CoverArt>,
    );
    expect(html).toMatch(/<img[^>]*src="\/x\.jpg"/);
    expect(html).toMatch(/class="[^"]*missing[^"]*"/);
    expect(html).toContain('Missing</span>');
  });
});
