/**
 * packages/music-connections is generated from one tag of the
 * music-connections repository (scripts/sync-music-connections.sh). The tag
 * VENDORED.md names must be the version package.json carries, the file must
 * say the copy is not edited by hand, and the files must still hash to the
 * `Content:` line the script wrote (so a hand edit fails here).
 */
import { createHash } from 'node:crypto';
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const dir = fileURLToPath(new URL('../../../music-connections/', import.meta.url));

/** The same hash the sync script writes: sha256 of the sorted "sha256  path" lines. */
function contentHash(root: string, entries: string[]): string {
  const lines: string[] = [];
  const walk = (rel: string): void => {
    const p = join(root, rel);
    if (statSync(p).isDirectory()) for (const e of readdirSync(p)) walk(`${rel}/${e}`);
    else lines.push(`${createHash('sha256').update(readFileSync(p)).digest('hex')}  ${rel}`);
  };
  for (const e of entries) walk(e);
  lines.sort();
  return createHash('sha256').update(`${lines.join('\n')}\n`).digest('hex');
}

const vendored = readFileSync(`${dir}VENDORED.md`, 'utf8');
const copied = [...(/^- Copied: (.+)$/m.exec(vendored)?.[1] ?? '').matchAll(/`([^`]+)`/g)].map((m) => m[1]!);
const recorded = /^- Content: sha256:([0-9a-f]{64})$/m.exec(vendored)?.[1];

describe('vendored music-connections', () => {
  it('VENDORED.md names the tag that package.json is at', () => {
    const pkg = JSON.parse(readFileSync(`${dir}package.json`, 'utf8')) as { name: string; version: string };
    const tag = /^- Tag: (v\S+)$/m.exec(vendored)?.[1];
    expect(pkg.name).toBe('music-connections');
    expect(tag).toBe(`v${pkg.version}`);
    expect(/^- Commit: [0-9a-f]{40}$/m.test(vendored)).toBe(true);
    expect(vendored).toContain('Do not edit anything in this');
    expect(vendored).not.toMatch(/\/Users\/|\/home\//);
  });

  it('the files hash to the Content line in VENDORED.md', () => {
    expect(copied.length).toBeGreaterThan(0);
    expect(recorded).toBeDefined();
    expect(contentHash(dir, copied)).toBe(recorded);
  });

  it('a modified copy fails the check (a temp copy is mutated, never the real tree)', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'mc-vendored-'));
    try {
      for (const e of copied) cpSync(join(dir, e), join(tmp, e), { recursive: true });
      expect(contentHash(tmp, copied)).toBe(recorded);
      appendFileSync(join(tmp, 'src/index.ts'), '\n// hand edit\n');
      expect(contentHash(tmp, copied)).not.toBe(recorded);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
