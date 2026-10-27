/**
 * The book handlers (Core Platform Architecture §3.3, the Books spike):
 * epub, pdf and cbz, claimed by the books app. Read-only: no write, no
 * contentHash, so the change engine never touches a book file. Each stores
 * one BookMetadata as files.tags_raw; the typed audio columns stay null.
 */
import path from 'node:path';
import type { FileColumns, FileTypeHandler } from '../handlers.js';
import { readCbz } from './cbz.js';
import { readEpub } from './epub.js';
import { readPdf } from './pdf.js';
import { bookIdentityDigest, imageMediaType, type BookMetadata } from './metadata.js';
import { withZip } from './zip.js';

export * from './metadata.js';
export { readEpub } from './epub.js';
export { readCbz } from './cbz.js';
export { readPdf } from './pdf.js';
export { ZipError, withZip } from './zip.js';

const NO_AUDIO: Omit<FileColumns, 'container' | 'hasEmbeddedArt'> = {
  codec: null, lossless: null, durationMs: null, sampleRate: null, bitDepth: null, channels: null, bitrateKbps: null,
};

/** A cover image is never larger than this (a scan of a whole page is a few MB). */
const COVER_MAX = 16 * 1024 * 1024;

/** The cover image a zip-based book names (metadata.cover), read from the file. */
async function zipCover(absPath: string, metadata: unknown): Promise<{ bytes: Buffer; mediaType: string } | null> {
  const name = (metadata as Partial<BookMetadata> | null)?.cover;
  const mediaType = name ? imageMediaType(name) : null;
  if (!name || !mediaType) return null;
  return withZip(absPath, async (zip) => {
    const e = zip.find(name);
    return e ? { bytes: await zip.read(e, COVER_MAX), mediaType } : null;
  });
}

function bookHandler(id: 'epub' | 'pdf' | 'cbz', ext: string, mediaType: string, read: (p: string) => Promise<BookMetadata>, container: string): FileTypeHandler {
  return {
    id,
    version: '1',
    extensions: new Set([ext]),
    mediaType: (e) => (e === ext ? mediaType : null),
    async parse(absPath) {
      const metadata = await read(absPath);
      return { columns: { ...NO_AUDIO, container, hasEmbeddedArt: metadata.cover !== null }, metadata };
    },
    identityDigest: bookIdentityDigest,
    ...(id === 'pdf' ? {} : { cover: zipCover }),
  };
}

export const epubHandler = bookHandler('epub', '.epub', 'application/epub+zip', readEpub, 'EPUB');
export const pdfHandler = bookHandler('pdf', '.pdf', 'application/pdf', readPdf, 'PDF');
export const cbzHandler = bookHandler('cbz', '.cbz', 'application/vnd.comicbook+zip', readCbz, 'CBZ');

/** The file's name without its extension: the title of a book that names none. */
export function titleFromName(relPath: string): string {
  return path.basename(relPath, path.extname(relPath)).replace(/[_]+/g, ' ').trim() || relPath;
}
