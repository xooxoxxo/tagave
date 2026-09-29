import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ConfirmDialog, confirmDialog } from './ConfirmDialog';
import { scrollFadeEdges } from './useScrollFade';
import { BrandMark } from '../BrandMark';

const stripComments = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, '');
const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');

describe('button gloss', () => {
  const css = stripComments(read('./Button.module.css'));

  it('has no discrete glint (no ::after layer at all)', () => {
    expect(css).not.toMatch(/::after/);
    expect(stripComments(read('../../styles/tokens.css'))).not.toContain('--clear-glint');
  });

  it('keeps the sheen above the label: at most 30% of the height, fading to nothing', () => {
    const sheen = css.match(/\.button::before\s*\{([^}]*)\}/)?.[1] ?? '';
    const height = Number(sheen.match(/height:\s*(\d+)%/)?.[1]);
    expect(height).toBeLessThanOrEqual(30);
    expect(sheen).toMatch(/rgba\(255, 255, 255, 0\) 100%/);
  });

  it('sets the label weight on the label itself, so a button and a link button match', () => {
    const label = css.match(/\n\.label\s*\{([^}]*)\}/)?.[1] ?? '';
    expect(label).toMatch(/font-weight:\s*600/);
  });
});

describe('scrollFadeEdges', () => {
  it('fades nothing when the strip fits', () => {
    expect(scrollFadeEdges(0, 300, 300)).toBe('none');
    expect(scrollFadeEdges(0, 300.5, 300)).toBe('none');
  });
  it('fades the end at the start, both in the middle, the start at the end', () => {
    expect(scrollFadeEdges(0, 800, 360)).toBe('end');
    expect(scrollFadeEdges(120, 800, 360)).toBe('both');
    expect(scrollFadeEdges(440, 800, 360)).toBe('start');
  });
});

describe('ConfirmDialog', () => {
  it('is a dialog labelled by its title and described by its message', () => {
    const html = renderToStaticMarkup(<ConfirmDialog title="Delete this view?" message="Only the filters go." onResult={() => {}} />);
    expect(html).toMatch(/^<dialog/);
    const labelledBy = html.match(/aria-labelledby="([^"]+)"/)?.[1];
    const describedBy = html.match(/aria-describedby="([^"]+)"/)?.[1];
    expect(html).toContain(`<h2 id="${labelledBy}"`);
    expect(html).toContain(`id="${describedBy}"`);
    expect(html).toContain('Only the filters go.');
  });

  it('uses the danger drop for a destructive confirm, and names both actions', () => {
    const html = renderToStaticMarkup(<ConfirmDialog title="Delete?" confirmLabel="Delete" cancelLabel="Keep it" tone="danger" onResult={() => {}} />);
    expect(html).toMatch(/class="[^"]*danger[^"]*"[^>]*><span[^>]*>Delete</);
    expect(html).toContain('Keep it');
    expect(html).not.toContain('aria-describedby');
  });

  it('treats a replaced request as cancelled', async () => {
    const first = confirmDialog({ title: 'One' });
    void confirmDialog({ title: 'Two' });
    await expect(first).resolves.toBe(false);
  });
});

describe('no native dialogs', () => {
  const src = fileURLToPath(new URL('../../', import.meta.url));
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) files.push(full);
    }
  };
  walk(src);

  it('never calls window.confirm, confirm() or alert()', () => {
    const offenders = files.filter((f) => /(^|[^\w.])(window\.)?(confirm|alert)\(/m.test(stripComments(readFileSync(f, 'utf8')).replace(/^\s*\/\/.*$/gm, '').replace(/confirmDialog\(/g, '')));
    expect(offenders.map((f) => f.slice(src.length))).toEqual([]);
  });
});

describe('BrandMark', () => {
  it('is decorative and themed by the dew tokens', () => {
    const html = renderToStaticMarkup(<BrandMark />);
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain('var(--dew-ink)');
    expect(html).toContain('var(--dew-hi)');
  });
});
