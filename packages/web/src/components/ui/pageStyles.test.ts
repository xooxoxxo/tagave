import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/*
 * Page and feature CSS (everything outside components/ui) stays on the design
 * system: colours come from tokens so both themes work, no control gets the
 * old small radius, and a class on an h1/h2 never asks the thin display face
 * for a weight it is not loaded in (that would be a synthesised bold).
 */
const src = fileURLToPath(new URL('../../', import.meta.url));
const walk = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'ui' ? [] : walk(path);
    return [path];
  });
const files = [...walk(join(src, 'pages')), ...walk(join(src, 'components'))];
const cssFiles = files.filter(f => f.endsWith('.module.css'));
const tsxFiles = files.filter(f => f.endsWith('.tsx') && !f.endsWith('.test.tsx'));
const stripComments = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, '');
const css = (file: string) => stripComments(readFileSync(file, 'utf8'));
const rel = (file: string) => file.slice(src.length);

describe('page CSS', () => {
  it('finds the page styles', () => {
    expect(cssFiles.length).toBeGreaterThan(20);
  });

  it.each(cssFiles.map(f => [rel(f), f]))('%s uses colour tokens, not literals', (_name, file) => {
    const source = css(file);
    expect(source.match(/#[0-9a-fA-F]{3,8}\b/g) ?? []).toEqual([]);
    expect(source.match(/rgba?\(\s*\d/g) ?? []).toEqual([]);
    expect(source.match(/:\s*(white|black)\s*[;}]/g) ?? []).toEqual([]);
  });

  it.each(cssFiles.map(f => [rel(f), f]))('%s has no small literal radius', (_name, file) => {
    const small = [...css(file).matchAll(/border-radius:\s*([^;}]+)/g)]
      .map(m => m[1]!.trim())
      .filter(value => /\b([1-9]|1[0-2])px\b/.test(value));
    expect(small).toEqual([]);
  });
});

describe('h1 and h2 classes', () => {
  const offenders: string[] = [];
  for (const tsx of tsxFiles) {
    const source = readFileSync(tsx, 'utf8');
    const imported = source.match(/import styles from '([^']+\.module\.css)'/);
    if (!imported) continue;
    const classes = new Set([...source.matchAll(/<h[12][^>]*className=\{styles\.([A-Za-z0-9_]+)\}/g)].map(m => m[1]!));
    if (classes.size === 0) continue;
    const cssFile = resolve(dirname(tsx), imported[1]!);
    for (const match of css(cssFile).matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const selectors = match[1]!.split(',').map(s => s.trim());
      const onlyHeadings = selectors.every(s => {
        const m = s.match(/^\.([A-Za-z0-9_]+)$/);
        return m && classes.has(m[1]!);
      });
      const weight = match[2]!.match(/font-weight:\s*(\d+)/);
      if (onlyHeadings && weight && Number(weight[1]) > 400) offenders.push(`${rel(cssFile)} ${match[1]!.trim()} ${weight[0]}`);
    }
  }

  it('never set a weight above 400 (Urbanist is loaded at 200 to 400)', () => {
    expect(offenders).toEqual([]);
  });
});
