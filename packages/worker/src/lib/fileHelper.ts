/**
 * The file helper: a small process the file gate (fileGate.ts) forks to run
 * file calls on a music share. A call that blocks for good on a dead share
 * holds this process, never the worker's; the gate kills it and forks a new
 * one.
 *
 * Protocol (HelperRequest / HelperMessage in fileGate.ts): the gate sends
 * `{ id, rootId, op }`; the helper answers `{ id, progress }` any number of times,
 * then once `{ id, ok: true, value }` or `{ id, ok: false, code, message }`,
 * with the real errno as `code` so the gate can tell an offline share from a
 * missing file. One op at a time. A bad op is answered, never thrown. A
 * write whose tag-writer sidecar hung is answered with `stuck: true`.
 *
 * Progress: while a long op runs, every 5 s the helper reads its bytes read
 * (`rchar` in /proc/self/io) and sends `{ progress: bytes }` only when they
 * grew. A timer alone is not progress: this event loop keeps running while a
 * read hangs in the threadpool. Without /proc/self/io (macOS) no progress is
 * sent and the gate's idle deadline is a plain deadline.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { lstat, mkdir, open, opendir, realpath, rename, rmdir, stat, statfs, unlink, access } from 'node:fs/promises';
import { parseFile } from 'music-metadata';
import { fileTypeHandler, type FileTypeHandler } from '@tagave/core/files';
import type { GateOp, HelperMessage, HelperRequest } from './fileGate.js';
import { safeWriteSteps, type WriteStepHooks } from './safeFileWriter.js';
import { MutagenTagWriter } from './tagWriter.js';
import { OFFLINE_CODES } from './folderOffline.js';

const PROGRESS_MS = 5_000;
const READ_SMALL_MAX = 32 * 1024 * 1024;
const PAGE_LIMIT = 500;
const LONG_OPS = new Set<GateOp['op']>(['parse', 'contentHash', 'cover', 'parseAudio', 'readSmall', 'writeTagged']);

type EntryType = 'file' | 'dir' | 'link' | 'other';
export interface DirPage {
  entries: Array<{ name: string; type: EntryType }>;
  /** The last name of this page, to pass for the next; null when the folder is done. */
  cursor: string | null;
}

/** An error the helper answers with its own code. */
function opError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

function str(v: unknown, field: string): string {
  if (typeof v !== 'string' || v === '') throw opError('EINVAL', `The op needs a ${field}`);
  return v;
}

function handlerOf(id: unknown): FileTypeHandler {
  const h = fileTypeHandler(typeof id === 'string' ? id : null);
  if (!h) throw opError('ENOHANDLER', `No file-type handler "${String(id)}" in this version`);
  return h;
}

/** Bytes this process has read, or null where /proc/self/io is missing. Local procfs: never the share. */
function bytesRead(): number | null {
  try {
    const m = /^rchar:\s*(\d+)/m.exec(readFileSync('/proc/self/io', 'utf8'));
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

/** The folder's entries after `cursor`, in name order, at most `limit`. */
async function readdirPage(path: string, cursor: string | null, limit: number): Promise<DirPage> {
  // Name order, not readdir order: the cursor then still works when its entry
  // went away between pages. The whole folder is read for each page, keeping
  // at most 2 * limit names in hand.
  let kept: Array<{ name: string; type: EntryType; unknown: boolean }> = [];
  let more = false;
  const trim = () => {
    kept.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    if (kept.length > limit) {
      more = true;
      kept = kept.slice(0, limit);
    }
  };
  const dir = await opendir(path);
  try {
    for await (const ent of dir) {
      if (cursor !== null && ent.name <= cursor) continue;
      const type: EntryType = ent.isFile() ? 'file' : ent.isDirectory() ? 'dir' : ent.isSymbolicLink() ? 'link' : 'other';
      const known = type !== 'other' || ent.isFIFO() || ent.isSocket() || ent.isBlockDevice() || ent.isCharacterDevice();
      kept.push({ name: ent.name, type, unknown: !known });
      if (kept.length >= 2 * limit) trim();
    }
  } finally {
    await dir.close().catch(() => undefined);
  }
  trim();
  const entries: DirPage['entries'] = [];
  for (const e of kept) {
    // Some shares do not say what an entry is: ask.
    let type = e.type;
    if (e.unknown) {
      const s = await lstat(join(path, e.name)).catch(() => null);
      type = !s ? 'other' : s.isFile() ? 'file' : s.isDirectory() ? 'dir' : s.isSymbolicLink() ? 'link' : 'other';
    }
    entries.push({ name: e.name, type });
  }
  return { entries, cursor: more && entries.length > 0 ? entries[entries.length - 1]!.name : null };
}

async function readSmall(path: string, maxBytes: number): Promise<Buffer> {
  // open first: that is the call a dead share (or a FIFO nobody writes to) hangs in.
  const fh = await open(path, 'r');
  try {
    const tooBig = () => opError('E2BIG', `The file is larger than ${maxBytes} bytes`);
    if ((await fh.stat()).size > maxBytes) throw tooBig();
    // Read on to the end, not to the stat size: a file that grew is refused too.
    const chunk = Buffer.alloc(Math.min(1024 * 1024, maxBytes + 1));
    const chunks: Buffer[] = [];
    let total = 0;
    for (;;) {
      const { bytesRead: n } = await fh.read(chunk, 0, chunk.length, null);
      if (n === 0) break;
      total += n;
      if (total > maxBytes) throw tooBig();
      chunks.push(Buffer.from(chunk.subarray(0, n)));
    }
    return Buffer.concat(chunks, total);
  } finally {
    await fh.close().catch(() => undefined);
  }
}

function statValue(s: import('node:fs').Stats | import('node:fs').BigIntStats) {
  return { size: s.size, mtimeMs: s.mtimeMs, ino: s.ino, dev: s.dev, mode: s.mode, isFile: s.isFile(), isDirectory: s.isDirectory() };
}

let tagWriter: MutagenTagWriter | null = null;
/** Set when the tag writer gave up on a stuck sidecar during the current op. */
let sidecarStuck = false;

/** The sidecar's response deadline: the writer's own, or TAGAVE_HELPER_TEST_SIDECAR_MS in tests. */
function sidecarMs(): number | undefined {
  const n = Number(process.env.TAGAVE_HELPER_TEST_SIDECAR_MS);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

/** The test hooks of the write steps (TAGAVE_HELPER_TEST_STOP_AFTER=copy hangs after the temp copy). */
function writeHooks(): WriteStepHooks {
  if (process.env.TAGAVE_HELPER_TEST_STOP_AFTER === 'copy') return { afterCopy: () => new Promise<void>(() => undefined) };
  return {};
}

async function runOp(op: GateOp, rootId: string | undefined): Promise<unknown> {
  if (op === null || typeof op !== 'object') throw opError('EINVAL', 'The request has no op');
  const o = op as Record<string, unknown>;
  switch (op.op) {
    case 'stat':
    case 'lstat': {
      const path = str(o.path, 'path');
      const bigint = op.bigint === true;
      return statValue(op.op === 'stat' ? await stat(path, { bigint }) : await lstat(path, { bigint }));
    }
    case 'access':
      await access(str(o.path, 'path'), typeof op.mode === 'number' ? op.mode : undefined);
      return true;
    case 'realpath':
      return realpath(str(o.path, 'path'));
    case 'unlink':
      await unlink(str(o.path, 'path'));
      return null;
    case 'rmdir':
      await rmdir(str(o.path, 'path'));
      return null;
    case 'statfs': {
      const s = await statfs(str(o.path, 'path'), { bigint: op.bigint === true });
      return { type: s.type, bsize: s.bsize, blocks: s.blocks, bfree: s.bfree, bavail: s.bavail, files: s.files, ffree: s.ffree };
    }
    case 'readdirPage': {
      const limit = typeof op.limit === 'number' && Number.isInteger(op.limit) && op.limit > 0 ? op.limit : PAGE_LIMIT;
      return readdirPage(str(o.path, 'path'), typeof op.cursor === 'string' ? op.cursor : null, limit);
    }
    case 'mkdir':
      await mkdir(str(o.path, 'path'), { recursive: op.recursive === true });
      return null;
    case 'rename':
      await rename(str(o.from, 'from'), str(o.to, 'to'));
      return null;
    case 'readSmall': {
      const max = typeof op.maxBytes === 'number' && op.maxBytes >= 0 ? op.maxBytes : READ_SMALL_MAX;
      return readSmall(str(o.path, 'path'), max);
    }
    case 'parse':
      return handlerOf(op.handlerId).parse(str(o.path, 'path'));
    case 'contentHash': {
      const h = handlerOf(op.handlerId);
      if (!h.contentHash) throw opError('ENOTSUP', `The ${h.id} handler has no content hash`);
      return h.contentHash(str(o.path, 'path'));
    }
    case 'cover': {
      const h = handlerOf(op.handlerId);
      if (!h.cover) throw opError('ENOTSUP', `The ${h.id} handler reads no cover`);
      return h.cover(str(o.path, 'path'), op.metadata);
    }
    case 'parseAudio': {
      const options: { duration?: boolean; skipCovers?: boolean } = {};
      if (typeof op.options?.duration === 'boolean') options.duration = op.options.duration;
      if (typeof op.options?.skipCovers === 'boolean') options.skipCovers = op.options.skipCovers;
      return parseFile(str(o.path, 'path'), options);
    }
    case 'writeTagged': {
      const h = handlerOf(op.handlerId);
      const path = str(o.path, 'path');
      if (op.values === null || typeof op.values !== 'object') throw opError('EINVAL', 'The op needs values');
      // The helper's own writer: a sidecar stuck on the share is replaced (never reused) and the gate counts it.
      const ms = sidecarMs();
      tagWriter ??= new MutagenTagWriter({ ...(ms ? { responseMs: ms } : {}), onStuck: () => { sidecarStuck = true; } });
      tagWriter.rootId = rootId;
      sidecarStuck = false;
      const result = await safeWriteSteps(path, h, op.values, tagWriter, op.options, writeHooks());
      if (sidecarStuck) throw Object.assign(opError('ETIMEDOUT', 'The tag writer did not answer'), { stuck: true });
      // A step that failed on an offline share is the share's answer, not the write's.
      if (result.errno && OFFLINE_CODES.has(result.errno)) throw opError(result.errno, result.error ?? 'The write failed');
      return result;
    }
    default:
      throw opError('EINVAL', `Unknown op "${String((op as { op?: unknown }).op)}"`);
  }
}

function send(msg: HelperMessage): void {
  try {
    process.send?.(msg);
  } catch (err) {
    // A value the channel cannot carry: answer that instead.
    if ('ok' in msg && msg.ok === true) {
      process.send?.({ id: msg.id, ok: false, code: 'ESERIALIZE', message: `The answer could not be sent: ${(err as Error).message}` });
    }
  }
}

async function handle(req: HelperRequest): Promise<void> {
  const { id, op } = req;
  const rootId = typeof req.rootId === 'string' ? req.rootId : undefined;
  let timer: NodeJS.Timeout | null = null;
  let last = LONG_OPS.has((op as { op?: GateOp['op'] } | null)?.op as GateOp['op']) ? bytesRead() : null;
  if (last !== null) {
    timer = setInterval(() => {
      const now = bytesRead();
      if (now !== null && last !== null && now > last) {
        last = now;
        send({ id, progress: now });
      }
    }, PROGRESS_MS);
  }
  try {
    send({ id, ok: true, value: await runOp(op, rootId) });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    const message = err instanceof Error ? err.message : String(err);
    const answer: HelperMessage = typeof code === 'string' && code !== '' ? { id, ok: false, code, message } : { id, ok: false, message };
    if ((err as { stuck?: unknown }).stuck === true) Object.assign(answer, { stuck: true });
    send(answer);
  } finally {
    if (timer) clearInterval(timer);
  }
}

// One op at a time, in the order they came.
let chain: Promise<void> = Promise.resolve();
process.on('message', (msg: unknown) => {
  const req = msg as Partial<HelperRequest> | null;
  if (req === null || typeof req !== 'object' || typeof req.id !== 'number') return;
  chain = chain.then(() => handle(req as HelperRequest));
});

// The gate let go of us: leave, and take the tag writer's sidecar along.
process.once('disconnect', () => {
  void Promise.race([tagWriter?.close(), new Promise((r) => setTimeout(r, 500))]).finally(() => process.exit(0));
});
