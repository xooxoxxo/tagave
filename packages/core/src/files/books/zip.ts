/**
 * A small read-only ZIP reader for the book handlers: an EPUB and a CBZ are
 * zip files. It reads the central directory, then one entry at a time
 * (stored or deflated), so a 400 MB comic costs a few reads, never the whole
 * file in memory. No dependency: node:fs and node:zlib.
 *
 * Not supported (each throws ZipError, which scan.parse records as the file's
 * parse error): zip64 (an archive or an entry over 4 GiB, more than 65,535
 * entries), encrypted entries, compression other than stored and deflate.
 */
import { open, type FileHandle } from 'node:fs/promises';
import { inflateRawSync } from 'node:zlib';

export interface ZipEntry {
  name: string;
  /** 0 stored, 8 deflate */
  method: number;
  flags: number;
  compressedSize: number;
  size: number;
  localHeaderOffset: number;
}

export class ZipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ZipError';
  }
}

const EOCD_SIG = 0x06054b50;
const CEN_SIG = 0x02014b50;
const LOC_SIG = 0x04034b50;
const EOCD_MIN = 22;
const MAX_COMMENT = 0xffff;

async function readAt(fh: FileHandle, length: number, position: number): Promise<Buffer> {
  const buf = Buffer.alloc(length);
  let got = 0;
  while (got < length) {
    const { bytesRead } = await fh.read(buf, got, length - got, position + got);
    if (bytesRead === 0) throw new ZipError('unexpected end of file');
    got += bytesRead;
  }
  return buf;
}

async function readEntries(fh: FileHandle, fileSize: number): Promise<ZipEntry[]> {
  if (fileSize < EOCD_MIN) throw new ZipError('not a zip file (too short)');
  const tailLen = Math.min(fileSize, EOCD_MIN + MAX_COMMENT);
  const tail = await readAt(fh, tailLen, fileSize - tailLen);
  let eocd = -1;
  for (let i = tailLen - EOCD_MIN; i >= 0; i--) {
    if (tail.readUInt32LE(i) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new ZipError('not a zip file (no end of central directory)');
  const count = tail.readUInt16LE(eocd + 10);
  const cdSize = tail.readUInt32LE(eocd + 12);
  const cdOffset = tail.readUInt32LE(eocd + 16);
  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) throw new ZipError('zip64 archives are not supported');
  if (cdOffset + cdSize > fileSize) throw new ZipError('central directory out of range');
  const cd = await readAt(fh, cdSize, cdOffset);
  const entries: ZipEntry[] = [];
  let p = 0;
  for (let n = 0; n < count; n++) {
    if (p + 46 > cd.length || cd.readUInt32LE(p) !== CEN_SIG) throw new ZipError('broken central directory');
    const flags = cd.readUInt16LE(p + 8);
    const nameLen = cd.readUInt16LE(p + 28);
    const extraLen = cd.readUInt16LE(p + 30);
    const commentLen = cd.readUInt16LE(p + 32);
    entries.push({
      // bit 11: the name is UTF-8; older archivers write CP437, read as latin1 (exact for ASCII names)
      name: cd.toString(flags & 0x800 ? 'utf8' : 'latin1', p + 46, p + 46 + nameLen),
      method: cd.readUInt16LE(p + 10),
      flags,
      compressedSize: cd.readUInt32LE(p + 20),
      size: cd.readUInt32LE(p + 24),
      localHeaderOffset: cd.readUInt32LE(p + 42),
    });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

async function readEntry(fh: FileHandle, fileSize: number, e: ZipEntry, maxBytes: number): Promise<Buffer> {
  if (e.flags & 0x1) throw new ZipError(`${e.name} is encrypted`);
  if (e.method !== 0 && e.method !== 8) throw new ZipError(`${e.name}: compression method ${e.method} is not supported`);
  // Every size below is the archive's own claim: nothing is allocated before it is checked
  // against the file and the cap, and inflating stops at the cap whatever the entry says.
  if (e.size > maxBytes) throw new ZipError(`${e.name} is larger than ${maxBytes} bytes`);
  if (e.compressedSize > maxBytes) throw new ZipError(`${e.name} is larger than ${maxBytes} bytes`);
  if (e.method === 0 && e.compressedSize !== e.size) throw new ZipError(`${e.name}: a stored entry whose sizes differ`);
  if (e.localHeaderOffset + 30 > fileSize) throw new ZipError(`broken local header for ${e.name}`);
  const loc = await readAt(fh, 30, e.localHeaderOffset);
  if (loc.readUInt32LE(0) !== LOC_SIG) throw new ZipError(`broken local header for ${e.name}`);
  const start = e.localHeaderOffset + 30 + loc.readUInt16LE(26) + loc.readUInt16LE(28);
  if (start + e.compressedSize > fileSize) throw new ZipError(`${e.name} runs past the end of the file`);
  const raw = await readAt(fh, e.compressedSize, start);
  if (e.method === 0) return raw;
  try {
    return inflateRawSync(raw, { maxOutputLength: Math.max(maxBytes, 1) });
  } catch (err) {
    // ERR_BUFFER_TOO_LARGE: the entry inflates past the cap, whatever size it declares
    if ((err as { code?: string }).code === 'ERR_BUFFER_TOO_LARGE' || err instanceof RangeError) throw new ZipError(`${e.name} is larger than ${maxBytes} bytes`);
    throw new ZipError(`${e.name}: broken deflate data`);
  }
}

/** An open zip file: its entries, and the bytes of one. */
export interface ZipReader {
  readonly entries: readonly ZipEntry[];
  /** The entry with this name; with `anyCase`, compared without case (tolerant readers). */
  find(name: string, anyCase?: boolean): ZipEntry | null;
  /** The entry's uncompressed bytes; refuses an entry larger than `maxBytes` (declared, compressed or inflated). */
  read(entry: ZipEntry, maxBytes?: number): Promise<Buffer>;
}

/** 16 MiB: far above any OPF, ComicInfo.xml or cover image. */
export const ZIP_ENTRY_MAX = 16 * 1024 * 1024;

/** Opens the zip at `absPath`, runs `fn` on it and closes it. */
export async function withZip<T>(absPath: string, fn: (zip: ZipReader) => Promise<T>): Promise<T> {
  const fh = await open(absPath, 'r');
  try {
    const { size } = await fh.stat();
    const entries = await readEntries(fh, size);
    const byName = new Map(entries.map((e) => [e.name, e]));
    const byLower = new Map(entries.map((e) => [e.name.toLowerCase(), e]));
    return await fn({
      entries,
      find: (name, anyCase) => byName.get(name) ?? (anyCase ? byLower.get(name.toLowerCase()) ?? null : null),
      read: (entry, maxBytes = ZIP_ENTRY_MAX) => readEntry(fh, size, entry, maxBytes),
    });
  } finally {
    await fh.close();
  }
}
