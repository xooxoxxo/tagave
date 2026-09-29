import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/*
 * The global baseline (styles/index.css) sits under every structural bare
 * <button> (rows, tabs, stars, disclosures). Page classes commonly set only
 * `background-color` or `background: transparent` on a bare <button>, so the
 * baseline must not add anything those classes do not reset: no gradient
 * (background-image), no box-shadow, no filter. The gummy-glass finish is
 * opt-in through Button.module.css.
 */
const stripComments = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, '');
const css = stripComments(readFileSync(new URL('../../styles/index.css', import.meta.url), 'utf8'));
const formCss = stripComments(readFileSync(new URL('./FormControl.module.css', import.meta.url), 'utf8'));

/** Every flat rule whose selector passes the test. */
function rules(source: string, test: (selector: string) => boolean): { selector: string; body: string }[] {
  const out: { selector: string; body: string }[] = [];
  for (const match of source.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = match[1]!.trim();
    if (test(selector)) out.push({ selector, body: match[2]! });
  }
  return out;
}

const withoutForcedColors = css.replace(/@media \(forced-colors: active\)\s*\{[\s\S]*?\}\s*\}/, '');
const buttonRules = rules(withoutForcedColors, selector => /:where\(button\b/.test(selector));

describe('bare <button> baseline', () => {
  it('exists', () => {
    expect(buttonRules.length).toBeGreaterThan(0);
  });

  it.each(['box-shadow', 'background-image', 'filter', 'text-shadow'])('never sets %s', property => {
    for (const { selector, body } of buttonRules) {
      expect(body, selector).not.toMatch(new RegExp(`(^|[;\\s])${property}\\s*:`));
    }
  });

  it('paints with background-color only, so `background: transparent` on a page class clears it', () => {
    for (const { selector, body } of buttonRules) {
      expect(body, selector).not.toMatch(/(^|[;\s])background\s*:/);
      expect(body, selector).not.toMatch(/gradient\(/);
    }
  });

  it('is a pill: no control in the system has a small radius', () => {
    const base = buttonRules.find(rule => rule.selector === ':where(button)');
    expect(base?.body).toMatch(/border-radius:\s*var\(--r-pill\)/);
  });
});

describe('bare headings', () => {
  it('h1 is the headline role and h2 the title role, both through --type-* tokens', () => {
    const h1 = rules(css, s => s === ':where(h1)');
    const h2 = rules(css, s => s === ':where(h2)');
    expect(h1.map(r => r.body).join('')).toMatch(/font:\s*var\(--type-headline\)/);
    expect(h2.map(r => r.body).join('')).toMatch(/font:\s*var\(--type-title\)/);
  });

  it('h3 and below stay in the body face, since they label data', () => {
    for (const { selector, body } of rules(css, s => /:where\(h[3-6]/.test(s))) {
      expect(body, selector).not.toMatch(/--font-display|--type-(display|headline|title)/);
    }
  });
});

describe('focus indicators', () => {
  it('form controls keep a solid 2px --ring outline on :focus-visible', () => {
    const focusVisible = rules(formCss, s => s === '.control:focus-visible');
    expect(focusVisible).toHaveLength(1);
    expect(focusVisible[0]!.body).toMatch(/outline:\s*2px solid var\(--ring\)/);
    for (const { selector, body } of rules(formCss, s => /\.control:focus/.test(s))) {
      expect(body, selector).not.toMatch(/outline:\s*none/);
    }
  });

  it('the baseline never removes the outline from focused fields', () => {
    for (const { selector, body } of rules(css, s => /:focus/.test(s))) {
      expect(body, selector).not.toMatch(/outline:\s*none/);
    }
  });
});
