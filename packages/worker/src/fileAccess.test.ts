import { readdirSync, readFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/*
 * The file gate is the only way worker code reaches a music path (vault
 * "tagave - Offline Library Spec"): a dead hard NFS share holds the libuv
 * thread of any fs call made on it, and four of them take the pool. So no
 * file under src/jobs or src/lib (tests and testkit aside) imports the fs
 * module or music-metadata's parseFile, or calls a file type handler's
 * parse, contentHash, cover or write (each reads or writes the file itself),
 * unless it is listed below with the reason it never touches a music path
 * in this process. Reads the source with its comments taken out, as
 * web/src/copy.test.ts does; each failure names the file and line.
 */
const ALLOWED: Record<string, string> = {
  'lib/fileGate.ts': 'the gate: forks the helper, never touches a music path',
  'lib/fileHelper.ts': 'the helper: runs in its own process',
  'lib/watchdog.ts': 'writeSync to stderr only',
  'lib/tagWriter.ts': 'existsSync of the venv inside the image',
  'lib/writeSteps.ts': 'the safe write steps: run only inside the helper, behind the gate',
  'lib/folderWatch/mountTable.ts': 'reads /proc/self/mountinfo, never a music path',
  'lib/procIo.ts': 'reads /proc/<pid>/io, never a music path',
  'lib/localFiles.ts': 'the cache folder and /.dockerenv only, never a music path',
  'jobs/artThumb.ts': 'cover originals in the cache folder only, never a music path',
};

const src = fileURLToPath(new URL('./', import.meta.url));
const walk = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? walk(path) : [path];
  });
const rel = (file: string) => file.slice(src.length).split(sep).join('/');
/** The worker's own code under jobs/ and lib/: no tests, no testkit. */
const code = ['jobs', 'lib']
  .flatMap((d) => walk(join(src, d)))
  .filter((f) => /\.ts$/.test(f) && !/\.test\.ts$/.test(f) && !rel(f).split('/').includes('testkit'));

/**
 * The source with every comment blanked out (newlines kept, so line
 * numbers hold). Strings and template literals are skipped over, so a `//`
 * inside a URL stays; a `/` that starts a regex literal is read as one.
 * (web/src/copy.test.ts's, copied: no package depends on another's tests.)
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
        else if (c !== '`' && text[j] === '\n') break;
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

/** An import of the fs module in any form: `from`, a bare import, `import(...)`, `require(...)`. */
const FS_MODULE = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)['"](?:node:)?fs(?:\/promises)?['"]/g;
/** A value import from music-metadata: each named import, or the whole module. */
const MM_IMPORT = /\bimport\s+(?!type\b)([^;]*?)\s*from\s*['"]music-metadata['"]/g;
const MM_DYNAMIC = /\b(?:import|require)\s*\(\s*['"]music-metadata['"]\s*\)/g;
/** A file type handler's own file call (`handler.parse(`, `fileHandler?.write(`, ...). */
const HANDLER_CALL = /\b\w*andler\s*[!?]?\s*\??\.\s*(?:parse|contentHash|cover|write)\s*\(/g;
/** createRequire: a require of its own, which loads fs (or anything) out of sight of the import checks. */
const CREATE_REQUIRE = /\bcreateRequire\b/g;

/** Every place in `text` (comments out) that reaches a file outside the gate, as `line: what`. */
function fileAccessIn(text: string): Array<{ line: number; what: string }> {
  const code = stripComments(text);
  const lineOf = (index: number) => code.slice(0, index).split('\n').length;
  const found: Array<{ line: number; what: string }> = [];
  for (const m of code.matchAll(FS_MODULE)) found.push({ line: lineOf(m.index!), what: 'imports the fs module' });
  for (const m of code.matchAll(MM_IMPORT)) {
    const names = m[1]!;
    if (/\*\s*as\b/.test(names) || /(?:^|[{,\s])parseFile\b/.test(names.replace(/\btype\s+\w+/g, ''))) {
      found.push({ line: lineOf(m.index!), what: 'imports parseFile from music-metadata' });
    }
  }
  for (const m of code.matchAll(MM_DYNAMIC)) found.push({ line: lineOf(m.index!), what: 'loads music-metadata' });
  for (const m of code.matchAll(HANDLER_CALL)) found.push({ line: lineOf(m.index!), what: `calls a file type handler: ${m[0].trim()}` });
  for (const m of code.matchAll(CREATE_REQUIRE)) found.push({ line: lineOf(m.index!), what: 'uses createRequire' });
  return found.sort((a, b) => a.line - b.line);
}

describe('the file access rule reads code, not comments', () => {
  it('sees every form of an fs import', () => {
    const text = [
      "import { stat } from 'node:fs/promises';",
      "import fs from 'fs';",
      "import 'node:fs';",
      "const p = await import('fs/promises');",
      "const f = require('node:fs');",
      "import { stat as s } from \"node:fs\";",
    ].join('\n');
    expect(fileAccessIn(text).map((h) => h.line)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('sees createRequire, the require that hides an fs load', () => {
    const text = "import { createRequire } from 'node:module';\nconst req = createRequire(import.meta.url);\nconst f = req('node:' + 'fs');";
    expect(fileAccessIn(text).map((h) => h.line)).toEqual([1, 2]);
  });

  it('sees parseFile from music-metadata, not its types', () => {
    expect(fileAccessIn("import { parseFile } from 'music-metadata';")).toHaveLength(1);
    expect(fileAccessIn("import {\n  type IAudioMetadata,\n  parseFile,\n} from 'music-metadata';")).toEqual([{ line: 1, what: 'imports parseFile from music-metadata' }]);
    expect(fileAccessIn("import * as mm from 'music-metadata';")).toHaveLength(1);
    expect(fileAccessIn("import type { IAudioMetadata } from 'music-metadata';")).toEqual([]);
    expect(fileAccessIn("import { type IAudioMetadata, parseBuffer } from 'music-metadata';")).toEqual([]);
  });

  it('sees a file type handler call, not another object\'s', () => {
    const text = 'await audioHandler.parse(p);\nawait handler!.write(t, v, w);\nh.cover(p);\nawait fileHandler?.contentHash(p);\nJSON.parse(x);';
    expect(fileAccessIn(text).map((h) => h.line)).toEqual([1, 2, 4]);
  });

  it('skips comments, and keeps line numbers', () => {
    const text = "// import fs from 'fs';\n/* handler.parse(p)\n   handler.write(x) */\nimport { readFile } from 'node:fs/promises';";
    expect(fileAccessIn(text)).toEqual([{ line: 4, what: 'imports the fs module' }]);
  });
});

describe('no music path outside the file gate', () => {
  it('reads every file of jobs/ and lib/', () => {
    expect(code.length).toBeGreaterThan(100);
    expect(code.some((f) => rel(f) === 'jobs/scanRoot.ts')).toBe(true);
    expect(code.some((f) => rel(f) === 'lib/folderWatch/watch.ts')).toBe(true);
    expect(code.some((f) => /\.test\.ts$/.test(f) || rel(f).includes('testkit/'))).toBe(false);
  });

  it('every allowed file is there, with its reason', () => {
    for (const [file, reason] of Object.entries(ALLOWED)) {
      expect(code.some((f) => rel(f) === file), `${file} is allowed but not found`).toBe(true);
      expect(reason.length).toBeGreaterThan(10);
    }
  });

  it('the write steps run only in the helper: no other file takes more than their temp copy name', () => {
    const found = code.filter((f) => rel(f) !== 'lib/fileHelper.ts').flatMap((f) => {
      const text = stripComments(readFileSync(f, 'utf8'));
      return [...text.matchAll(/\bimport\s+(?!type\b)\{([^}]*)\}\s*from\s*['"][./]+writeSteps\.js['"]/g)].flatMap((m) => {
        const names = m[1]!.split(',').map((n) => n.trim()).filter((n) => n && !n.startsWith('type '));
        return names.filter((n) => n !== 'tempPrefixFor').map((n) => `${rel(f)}: ${n}`);
      });
    });
    expect(found, `a write step outside the file helper (use SafeFileWriter, through the gate):\n${found.join('\n')}`).toEqual([]);
  });

  it('only the allowed files reach a file themselves', () => {
    const found = code
      .filter((f) => !(rel(f) in ALLOWED))
      .flatMap((f) => fileAccessIn(readFileSync(f, 'utf8')).map((h) => `${rel(f)}:${h.line}: ${h.what}`));
    expect(found, `file access outside the file gate (go through fileGate().run, or list the file with its reason):\n${found.join('\n')}`).toEqual([]);
  });
});
