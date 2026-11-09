import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { GATED_QUEUES, MAINTENANCE_QUEUES, MUSIC_FOLDER_QUEUES, QUEUES_RIDING_WITH, WORKER_QUEUES, unservedWork, workedWith } from '@tagave/core';
import { maintenanceSender } from '@tagave/db';
import { QUEUE_POLICIES } from './lib/queueSetup.js';

// Every compose file that splits the worker into TAGAVE_QUEUES roles must, taken
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

/** Each TAGAVE_QUEUES value in a compose file, as a list of queue names. */
function queueLists(file: string): string[][] {
  const text = readFileSync(path.join(repo, file), 'utf8');
  return [...text.matchAll(/^\s*TAGAVE_QUEUES:\s*(\S+)\s*$/gm)].map((m) => m[1]!.split(',').map((q) => q.trim()));
}

/** Each service of a compose file that sets TAGAVE_QUEUES: its queues, and whether it mounts the music folder. */
function workerServices(file: string): Array<{ name: string; queues: string[]; music: boolean }> {
  const lines = readFileSync(path.join(repo, file), 'utf8').split('\n');
  const out: Array<{ name: string; queues: string[]; music: boolean }> = [];
  let cur: { name: string; queues: string[]; music: boolean } | null = null;
  for (const line of lines) {
    const svc = /^  ([\w-]+):\s*$/.exec(line);
    if (svc) {
      if (cur?.queues.length) out.push(cur);
      cur = { name: svc[1]!, queues: [], music: false };
      continue;
    }
    if (!cur) continue;
    const q = /^\s*TAGAVE_QUEUES:\s*(\S+)\s*$/.exec(line);
    if (q) cur.queues = q[1]!.split(',').map((x) => x.trim());
    if (/^\s*-\s*.*:\/mnt\/music(:|\s*$)/.test(line)) cur.music = true;
  }
  if (cur?.queues.length) out.push(cur);
  return out;
}

const COMPOSE_FILES = [
  'deploy/compose.yml',
  'docker-compose.prod.yml',
  'deploy/templates/compose.yml',
  'deploy/templates/dokploy/docker-compose.yml',
  'deploy/templates/coolify/tagave.yml',
];

describe.each(COMPOSE_FILES)('%s worker roles', (file) => {
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

  it('reads as fully served in the worker check', () => {
    expect(unservedWork(lists)).toEqual([]);
  });

  it('works every queue that touches the music folder on the worker that mounts it', () => {
    const services = workerServices(file);
    const files = services.filter((s) => s.music);
    expect(files.map((s) => s.name)).toHaveLength(1);
    const served = new Set(files[0]!.queues);
    expect(MUSIC_FOLDER_QUEUES.filter((q) => !served.has(workedWith(q)))).toEqual([]);
  });

  it('gives each queue to one worker only', () => {
    const all = lists.flat();
    expect(all.filter((q, i) => all.indexOf(q) !== i)).toEqual([]);
  });
});

describe('worker check queue list', () => {
  it('names exactly the queues index.ts gates on', () => {
    expect([...GATED_QUEUES].sort()).toEqual(gatedQueues());
  });
});

describe('queues riding with another', () => {
  const src = readFileSync(path.join(here, 'index.ts'), 'utf8');

  it.each(Object.entries(QUEUES_RIDING_WITH))('%s is worked by the worker that serves %s', (queue, host) => {
    expect(WORKER_QUEUES as readonly string[]).toContain(queue);
    expect(GATED_QUEUES).toContain(host);
    expect(src).toMatch(new RegExp(`boss\\.work(<[^(]*>)?\\('${queue.replace('.', '\\.')}'`));
  });

  it('Music Connections pulls ride with identify.album, the tick every 15 minutes', () => {
    expect(QUEUES_RIDING_WITH['connections.pull']).toBe('identify.album');
    expect(src).toMatch(/boss\.schedule\('connections\.pull', '\*\/15 \* \* \* \*'/);
  });

  it('the Music Connections tombstone purge rides with facets.refresh, daily', () => {
    expect(QUEUES_RIDING_WITH['mc.purge']).toBe('facets.refresh');
    expect(src).toMatch(/boss\.schedule\('mc\.purge', '\d+ \d+ \* \* \*'/);
  });
});

/** Where each boss.work() sits in index.ts: the wants() guard just before it, and the job functions its handler calls. */
function handlers(): Array<{ queue: string; guard: string | null; calls: string[] }> {
  const src = readFileSync(path.join(here, 'index.ts'), 'utf8');
  const fromFile = new Map<string, string>();
  for (const m of src.matchAll(/import\s*\{([^}]+)\}\s*from\s*'\.\/jobs\/([\w]+)\.js'/g)) {
    for (const name of m[1]!.split(',').map((x) => x.replace(/^\s*type\s+/, '').trim()).filter(Boolean)) fromFile.set(name, m[2]!);
  }
  const works = [...src.matchAll(/boss\.work(?:<[^(]*>)?\('([^']+)'/g)];
  return works.map((w, i) => {
    const start = w.index!;
    const end = works[i + 1]?.index ?? src.length;
    const before = src.slice(0, start);
    const guards = [...before.matchAll(/wants\('([^']+)'\)/g)];
    const body = src.slice(start, end);
    const calls = [...fromFile.keys()].filter((fn) => new RegExp(`\\b${fn}\\(`).test(body)).map((fn) => fromFile.get(fn)!);
    return { queue: w[1]!, guard: guards.at(-1)?.[1] ?? null, calls: [...new Set(calls)] };
  });
}

/** A job file that opens, reads or writes files on disk itself. */
const TOUCHES_FILES = /from 'node:fs(?:\/promises)?'|from 'music-metadata'|fpcalcFingerprint\(|filesUnder\(|from '\.\.\/lib\/(?:walk|safeFileWriter|tagWriter)\.js'/;
/** Queues whose files are tagave's own cache volume (mounted in both workers), not the music folder. */
const CACHE_ONLY = ['art.thumb', 'art.thumbSweep', 'art.sweep'];

describe('queues that touch the music folder', () => {
  const hs = handlers().filter((h) => (WORKER_QUEUES as readonly string[]).includes(h.queue));

  it('each is registered under the wants() of the queue it rides with', () => {
    expect(hs.length).toBeGreaterThan(30);
    expect(hs.filter((h) => h.guard !== workedWith(h.queue)).map((h) => `${h.queue} under ${h.guard}`)).toEqual([]);
  });

  it('every handler that touches files is listed in MUSIC_FOLDER_QUEUES', () => {
    const touching = hs
      .filter((h) => h.calls.some((f) => TOUCHES_FILES.test(readFileSync(path.join(here, 'jobs', `${f}.ts`), 'utf8'))))
      .map((h) => h.queue)
      .filter((q) => !CACHE_ONLY.includes(q));
    expect(touching).toContain('pool.scan');
    expect(touching.filter((q) => !MUSIC_FOLDER_QUEUES.includes(q))).toEqual([]);
  });

  it('pool.scan rides with the tag writer, on the file worker', () => {
    expect(QUEUES_RIDING_WITH['pool.scan']).toBe('tags.apply');
  });
});

/** The queue of every maintenance task the app saves (saveMaintenanceTask({ …, queue: '…' })). */
function appMaintenanceQueues(): string[] {
  const api = path.join(repo, 'packages/api/src');
  const out = new Set<string>();
  for (const dir of ['routes', 'lib']) {
    for (const name of readdirSync(path.join(api, dir)).filter((f) => f.endsWith('.ts') && !f.includes('.test.'))) {
      const text = readFileSync(path.join(api, dir, name), 'utf8');
      for (const m of text.matchAll(/saveMaintenanceTask\([^)]*?queue: '([^']+)'/gs)) out.add(m[1]!);
    }
  }
  return [...out].sort();
}

// 0.29.0: the owner's split analyses and cover lookups waited for ever. Every
// maintenance job on a 'stately' queue was sent with no singletonKey, so all
// of them shared one slot: a second album's cut points could not be queued,
// and a job a stopped worker left active held every split back for hours.
describe('maintenance tasks', () => {
  it('MAINTENANCE_QUEUES names every queue the app dispatches a task to', () => {
    const used = appMaintenanceQueues();
    expect(used.length).toBeGreaterThan(4);
    expect(used.filter((q) => !(MAINTENANCE_QUEUES as readonly string[]).includes(q))).toEqual([]);
  });

  it('each is worked on the file worker, which handles the task under its claim', () => {
    const src = readFileSync(path.join(here, 'index.ts'), 'utf8');
    const fromFile = new Map<string, string>();
    for (const m of src.matchAll(/import\s*\{([^}]+)\}\s*from\s*'\.\/((?:jobs|lib)\/[\w]+)\.js'/g)) {
      for (const name of m[1]!.split(',').map((x) => x.replace(/^\s*type\s+/, '').trim()).filter(Boolean)) fromFile.set(name, m[2]!);
    }
    for (const queue of MAINTENANCE_QUEUES) {
      expect(MUSIC_FOLDER_QUEUES, queue).toContain(queue);
      const at = src.search(new RegExp(`boss\\.work(<[^(]*>)?\\('${queue.replace('.', '\\.')}'`));
      expect(at, queue).toBeGreaterThan(0);
      const body = src.slice(at, src.indexOf('});', at));
      const files = [...fromFile].filter(([fn]) => new RegExp(`\\b${fn}\\(`).test(body)).map(([, file]) => file);
      const claims = files.some((file) => /runMaintenance\(|withMaintenanceClaim\(/.test(readFileSync(path.join(here, `${file}.ts`), 'utf8')));
      expect(claims, `${queue} handler (${files.join(', ')}) runs a maintenance task under its claim`).toBe(true);
    }
  });

  it.each(MAINTENANCE_QUEUES)('a job on %s carries its attempt\'s own id and singletonKey, whatever the queue policy', async (queue) => {
    const sent: Array<Record<string, unknown>> = [];
    const send = maintenanceSender({ send: async (_name, _data, options) => { sent.push(options); return String(options['id']); } });
    const tx = {} as never;
    await send(tx, queue, '00000000-0000-4000-8000-000000000001', { localAlbumId: 'a', splitId: 's' });
    await send(tx, queue, '00000000-0000-4000-8000-000000000002', { localAlbumId: 'a', splitId: 's' });
    expect(sent.map((o) => o['id'])).toEqual(['00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002']);
    // under 'stately' (or any singleton policy) two jobs with one key cannot both wait
    if (QUEUE_POLICIES[queue]) {
      expect(sent[0]!['singletonKey']).toBeTruthy();
      expect(sent[0]!['singletonKey']).not.toBe(sent[1]!['singletonKey']);
    }
  });

  it('the file worker recovers what a stopped worker left behind before it registers a handler', () => {
    const src = readFileSync(path.join(here, 'index.ts'), 'utf8');
    const recover = src.indexOf('recoverMaintenanceTasks(');
    expect(recover).toBeGreaterThan(0);
    expect(recover).toBeLessThan(src.search(/boss\.work(<[^(]*>)?\(/));
  });
});
