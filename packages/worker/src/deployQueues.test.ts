import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// Every compose file that splits the worker into LINER_QUEUES roles must, taken
// together, give each queue the worker can run to some worker. A queue left
// out is never worked: the API enqueues it and the job waits forever.

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../../..');

/** The names index.ts gates handlers on: wants('name'). */
function gatedQueues(): string[] {
  const src = readFileSync(path.join(here, 'index.ts'), 'utf8');
  const names = [...src.matchAll(/wants\('([^']+)'\)/g)].map((m) => m[1]!);
  return [...new Set(names)].sort();
}

/** Each LINER_QUEUES value in a compose file, as a list of queue names. */
function queueLists(file: string): string[][] {
  const text = readFileSync(path.join(repo, file), 'utf8');
  return [...text.matchAll(/^\s*LINER_QUEUES:\s*(\S+)\s*$/gm)].map((m) => m[1]!.split(',').map((q) => q.trim()));
}

describe.each(['deploy/compose.yml', 'docker-compose.prod.yml'])('%s worker roles', (file) => {
  const lists = queueLists(file);

  it('has a file worker and an identify worker', () => {
    expect(lists.length).toBe(2);
  });

  it('covers every queue the worker gates on', () => {
    const covered = new Set(lists.flat());
    const gated = gatedQueues();
    expect(gated.length).toBeGreaterThan(20);
    expect(gated.filter((q) => !covered.has(q))).toEqual([]);
  });

  it('names no queue the worker does not know', () => {
    const gated = new Set(gatedQueues());
    expect(lists.flat().filter((q) => !gated.has(q))).toEqual([]);
  });

  it('gives each queue to one worker only', () => {
    const all = lists.flat();
    expect(all.filter((q, i) => all.indexOf(q) !== i)).toEqual([]);
  });
});
