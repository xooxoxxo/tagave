/**
 * What the book handlers (epub, pdf, cbz) read from a file, stored as
 * files.tags_raw: one shape for the three formats, so the Books app groups
 * them without caring which one a file is. Read-only in this spike: nothing
 * is ever written back to a book file.
 */
import { createHash } from 'node:crypto';
import { noNul, stableStringify } from '../audioMetadata.js';

export type BookFormat = 'epub' | 'pdf' | 'cbz';

export interface BookIdentifier {
  /** isbn, uuid, asin, doi … (lower case), or null when the file names none */
  scheme: string | null;
  value: string;
}

export interface BookMetadata {
  format: BookFormat;
  title: string | null;
  /** In the file's order: EPUB creators whose role is author (or unset), ComicInfo Writer, PDF Author. */
  authors: string[];
  series: string | null;
  seriesIndex: number | null;
  /** The first valid ISBN the file carries, as ISBN-13 (an ISBN-10 is converted). */
  isbn13: string | null;
  identifiers: BookIdentifier[];
  language: string | null;
  publisher: string | null;
  /** As the file gives it (dc:date, ComicInfo Year[-Month[-Day]], XMP or Info CreationDate year). */
  published: string | null;
  /** Where it is cheap: a CBZ's images, ComicInfo PageCount, a PDF's page tree count. Null for EPUB. */
  pages: number | null;
  /** The zip entry of the cover image (epub, cbz); null when there is none (pdf, always). */
  cover: string | null;
}

const MAX_TEXT = 1000;

/** A free-text value as stored: no NUL (Postgres jsonb), whitespace collapsed, capped, null when empty. */
export function cleanText(v: string | null | undefined): string | null {
  if (v == null) return null;
  const t = noNul(v)!.replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT);
  return t === '' ? null : t;
}

function isbn13Check(d12: string): string {
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(d12[i]) * (i % 2 === 0 ? 1 : 3);
  return String((10 - (sum % 10)) % 10);
}

function isbn10Valid(s: string): boolean {
  let sum = 0;
  for (let i = 0; i < 10; i++) {
    const c = s[i]!;
    const v = c === 'X' ? 10 : Number(c);
    if (c === 'X' && i !== 9) return false;
    sum += v * (10 - i);
  }
  return sum % 11 === 0;
}

/**
 * The ISBN-13 a value names, or null when it is not a valid ISBN. Accepts
 * 'urn:isbn:…', 'isbn:…', hyphens and spaces, ISBN-10 (converted) and
 * ISBN-13 (978/979, check digit verified).
 */
export function normalizeIsbn(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const s = raw.trim().replace(/^(urn:)?isbn:?/i, '').replace(/[\s-]/g, '').toUpperCase();
  if (/^97[89]\d{10}$/.test(s)) return isbn13Check(s.slice(0, 12)) === s[12] ? s : null;
  if (/^\d{9}[\dX]$/.test(s) && isbn10Valid(s)) {
    const d12 = `978${s.slice(0, 9)}`;
    return d12 + isbn13Check(d12);
  }
  return null;
}

/** A numeric series position ('2', '2.5', '#3', '003'), or null. */
export function seriesNumber(v: string | null | undefined): number | null {
  if (!v) return null;
  const m = /-?\d+(?:[.,]\d+)?/.exec(v);
  if (!m) return null;
  const n = Number(m[0].replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

const norm = (s: string | null) => (s ?? '').normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();

/**
 * Move-safe Tier 2 for books: what identifies a moved copy whose size and
 * mtime changed (files.core_tags_digest). The format, the ISBN (or the first
 * identifier), title, authors and series position. Null when the file names
 * neither a title nor an identifier: nothing to pair on.
 */
export function bookIdentityDigest(metadata: unknown): string | null {
  const m = metadata as Partial<BookMetadata> | null;
  if (!m || typeof m !== 'object' || !m.format) return null;
  const id = m.isbn13 ?? m.identifiers?.[0]?.value ?? null;
  if (!m.title && !id) return null;
  const key = stableStringify({
    v: 1, f: m.format, i: norm(id), t: norm(m.title ?? null),
    a: (m.authors ?? []).map((a) => norm(a)), s: norm(m.series ?? null), n: m.seriesIndex ?? null,
  });
  return createHash('sha1').update(key).digest('hex');
}

/** The MIME type of an image entry, by its extension; null when it is not an image a browser shows. */
export function imageMediaType(name: string): string | null {
  const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase();
  return ({ jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp' } as Record<string, string>)[ext] ?? null;
}
