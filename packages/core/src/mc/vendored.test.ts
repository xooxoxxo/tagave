/**
 * packages/music-connections is generated from one tag of the
 * music-connections repository (scripts/sync-music-connections.sh). The tag
 * VENDORED.md names must be the version package.json carries, and the file
 * must say the copy is not edited by hand.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const dir = fileURLToPath(new URL('../../../music-connections/', import.meta.url));

describe('vendored music-connections', () => {
  it('VENDORED.md names the tag that package.json is at', () => {
    const vendored = readFileSync(`${dir}VENDORED.md`, 'utf8');
    const pkg = JSON.parse(readFileSync(`${dir}package.json`, 'utf8')) as { name: string; version: string };
    const tag = /^- Tag: (v\S+)$/m.exec(vendored)?.[1];
    expect(pkg.name).toBe('music-connections');
    expect(tag).toBe(`v${pkg.version}`);
    expect(/^- Commit: [0-9a-f]{40}$/m.test(vendored)).toBe(true);
    expect(vendored).toContain('Do not edit anything in this');
    expect(vendored).not.toMatch(/\/Users\/|\/home\//);
  });
});
