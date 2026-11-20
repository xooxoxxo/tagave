import { readdirSync, readFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/*
 * The app's copy (spec §7, DESIGN.md): no em dash anywhere a person reads,
 * and none of the Autotagger's words from before the rename. Reads the
 * source with its comments taken out, so a dash in a comment is fine and a
 * dash in a label, a value or a story's docs fails here with its file:line.
 */
const src = fileURLToPath(new URL('./', import.meta.url));
const walk = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? walk(path) : [path];
  });
const rel = (file: string) => file.slice(src.length).split(sep).join('/');
const all = walk(src).filter((f) => /\.tsx?$/.test(f));
/** The app's own source: no tests, no stories, no story fixtures (a real album title may keep its dash there). */
const app = all.filter((f) => !/\.(test|stories)\.tsx?$/.test(f) && !/^stories\/[^/]*Fixtures\.ts$/.test(rel(f)));
const stories = all.filter((f) => /\.stories\.tsx$/.test(f));

/** A splitting regex, not copy. */
const DASH_ALLOWED = new Set(['components/ui/CoverArt.tsx']);
/** Matches the API's own detail for a missing key. */
const OLD_COPY_ALLOWED = new Set(['pages/review/autotaggerDraft.ts']);
const OLD_COPY = ['TypeSafe key', 'Maximum error rate', '* any', '· bytes'];

/**
 * The source with every comment blanked out (newlines kept, so line
 * numbers hold). Strings and template literals are skipped over, so a `//`
 * inside a URL stays; a `/` that starts a regex literal is read as one.
 */
function stripComments(text: string): string {
  let out = '';
  let i = 0;
  let last = ''; // the last character that was not white space, outside comments
  const blank = (s: string) => s.replace(/[^\n]/g, ' ');
  while (i < text.length) {
    const c = text[i]!;
    const next = text[i + 1];
    if (c === '/' && next === '/') {
      const end = text.indexOf('\n', i);
      const stop = end === -1 ? text.length : end;
      out += blank(text.slice(i, stop));
      i = stop;
      continue;
    }
    if (c === '/' && next === '*') {
      const end = text.indexOf('*/', i + 2);
      const stop = end === -1 ? text.length : end + 2;
      out += blank(text.slice(i, stop));
      i = stop;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      while (j < text.length && text[j] !== c) {
        if (text[j] === '\\') j++;
        else if (c !== '`' && text[j] === '\n') break; // JSX text with an apostrophe, not a string
        j++;
      }
      out += text.slice(i, j + 1);
      last = c;
      i = j + 1;
      continue;
    }
    if (c === '/' && /^$|[(,=:[!&|?{};]$/.test(last)) {
      // a regex literal: up to its closing slash, past classes and escapes
      let j = i + 1;
      let inClass = false;
      while (j < text.length && text[j] !== '\n') {
        const d = text[j]!;
        if (d === '\\') j++;
        else if (d === '[') inClass = true;
        else if (d === ']') inClass = false;
        else if (d === '/' && !inClass) break;
        j++;
      }
      out += text.slice(i, j + 1);
      last = '/';
      i = j + 1;
      continue;
    }
    out += c;
    if (!/\s/.test(c)) last = c;
    i++;
  }
  return out;
}

/** Each line of `file` (comments out) holding `needle`, as `file:line: text`. */
function hits(file: string, needles: string[]): string[] {
  const lines = stripComments(readFileSync(file, 'utf8')).split('\n');
  return lines.flatMap((line, n) => (needles.some((s) => line.includes(s)) ? [`${rel(file)}:${n + 1}: ${line.trim()}`] : []));
}

/** The text of every `description:` in a story file: a string, or an object of strings (`{ component: '…' }`). */
function descriptions(text: string): Array<{ line: number; text: string }> {
  const found: Array<{ line: number; text: string }> = [];
  for (const m of text.matchAll(/\bdescription:\s*/g)) {
    const start = m.index! + m[0].length;
    const open = text[start];
    let end = start;
    if (open === '{') {
      let depth = 0;
      for (let j = start; j < text.length; j++) {
        const d = text[j]!;
        if (d === '"' || d === "'" || d === '`') {
          j++;
          while (j < text.length && text[j] !== d) { if (text[j] === '\\') j++; j++; }
        } else if (d === '{') depth++;
        else if (d === '}' && --depth === 0) { end = j + 1; break; }
      }
    } else if (open === '"' || open === "'" || open === '`') {
      let j = start + 1;
      while (j < text.length && text[j] !== open) { if (text[j] === '\\') j++; j++; }
      end = j + 1;
    }
    found.push({ line: text.slice(0, start).split('\n').length, text: text.slice(start, end) });
  }
  return found;
}

describe('the copy guard reads code, not comments', () => {
  it('drops line and block comments, keeps strings and line numbers', () => {
    const out = stripComments("const a = 'x — y'; // a — b\n/* c —\n d */ const u = 'http://example.com';");
    expect(out).toContain("'x — y'");
    expect(out).toContain("'http://example.com'");
    expect(out.split('—')).toHaveLength(2);
    expect(out.split('\n')).toHaveLength(3);
  });

  it('reads a regex literal as code', () => {
    const out = stripComments('const re = /a\\/\\/b/; const s = "—";');
    expect(out).toContain('/a\\/\\/b/');
    expect(out).toContain('"—"');
  });
});

describe("the app's copy", () => {
  it('no em dash in the app\'s copy', () => {
    const found = app.filter((f) => !DASH_ALLOWED.has(rel(f))).flatMap((f) => hits(f, ['—']));
    expect(found, `em dashes in UI copy:\n${found.join('\n')}`).toEqual([]);
  });

  it('no Autotagger copy from before the rename', () => {
    const found = app.filter((f) => !OLD_COPY_ALLOWED.has(rel(f))).flatMap((f) => hits(f, OLD_COPY));
    expect(found, `old Autotagger copy:\n${found.join('\n')}`).toEqual([]);
  });

  it('story docs carry no em dash', () => {
    const found = stories.flatMap((f) => {
      const text = stripComments(readFileSync(f, 'utf8'));
      return descriptions(text).filter((d) => d.text.includes('—')).map((d) => `${rel(f)}:${d.line}`);
    });
    expect(found, `em dashes in story docs:\n${found.join('\n')}`).toEqual([]);
  });

  it('reads the whole app', () => {
    expect(app.length).toBeGreaterThan(100);
    expect(app.some((f) => rel(f) === 'pages/SettingsBackupsPage.tsx')).toBe(true);
    expect(stories.length).toBeGreaterThan(10);
  });
});
