/**
 * PDF, where it is cheap: the first and last MiB of the file (the whole
 * file when it is small), never a full parse.
 *
 *   title, authors, language, publisher   the XMP packet when it is stored
 *                                         uncompressed (dc:title, dc:creator,
 *                                         dc:language, dc:publisher), else
 *                                         the document information dictionary
 *                                         the trailer names (/Title, /Author)
 *   ISBN                                  XMP prism:isbn or an urn:isbn identifier
 *   pages                                 the linearization dictionary's /N,
 *                                         else the largest /Type /Pages /Count
 *
 * A PDF 1.5+ file that keeps these objects in compressed object streams
 * reads as untitled with no page count: the spike's known limit (a real
 * reader, pdf.js or PyMuPDF in the file writer, is the next step). No cover:
 * a PDF has no cover image, only a first page to render.
 */
import { open } from 'node:fs/promises';
import { findAll, findFirst, parseXml, textOf, type XmlElement } from './xml.js';
import { cleanText, normalizeIsbn, type BookIdentifier, type BookMetadata } from './metadata.js';

const WINDOW = 1024 * 1024;
/**
 * Bounds on the work one file can cause (the parse runs on the worker's
 * event loop): a dictionary is scanned for at most DICT_MAX characters, and
 * only the last MAX_CANDIDATES /Info references and /Type /Pages are looked
 * at (an incremental update appends a new trailer; the last ones are current).
 */
const DICT_MAX = 64 * 1024;
const MAX_CANDIDATES = 8;
/** The linearization dictionary is the file's first object (within its first KiB by the spec). */
const LINEARIZED_SCAN = 4 * 1024;

async function readWindows(absPath: string): Promise<string> {
  const fh = await open(absPath, 'r');
  try {
    const { size } = await fh.stat();
    const read = async (len: number, pos: number) => {
      const buf = Buffer.alloc(len);
      let got = 0;
      while (got < len) {
        const { bytesRead } = await fh.read(buf, got, len - got, pos + got);
        if (bytesRead === 0) break;
        got += bytesRead;
      }
      return buf.subarray(0, got).toString('latin1');
    };
    if (size <= 2 * WINDOW) return read(size, 0);
    // a gap marker no PDF token spans
    return `${await read(WINDOW, 0)}\n%tagave-gap\n${await read(WINDOW, size - WINDOW)}`;
  } finally {
    await fh.close();
  }
}

/** Bytes of a PDF string as text: UTF-16BE with its BOM, UTF-8 with its BOM, else PDFDocEncoding (read as latin1). */
function decodePdfBytes(bytes: number[]): string {
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    let s = '';
    for (let i = 2; i + 1 < bytes.length; i += 2) s += String.fromCharCode((bytes[i]! << 8) | bytes[i + 1]!);
    return s;
  }
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return Buffer.from(bytes.slice(3)).toString('utf8');
  return Buffer.from(bytes).toString('latin1');
}

/** A literal string's bytes from just after its '(' : escapes, nested parentheses, line continuations. */
function literalAt(src: string, start: number): number[] {
  const out: number[] = [];
  let depth = 1;
  for (let i = start; i < src.length; i++) {
    const c = src.charCodeAt(i);
    if (c === 0x5c /* \ */) {
      const n = src[++i];
      if (n === undefined) break;
      if (n === 'n') out.push(10);
      else if (n === 'r') out.push(13);
      else if (n === 't') out.push(9);
      else if (n === 'b') out.push(8);
      else if (n === 'f') out.push(12);
      else if (n === '\r') { if (src[i + 1] === '\n') i++; }
      else if (n === '\n') { /* line continuation */ }
      else if (/[0-7]/.test(n)) {
        let oct = n;
        while (oct.length < 3 && /[0-7]/.test(src[i + 1] ?? '')) oct += src[++i];
        out.push(parseInt(oct, 8) & 0xff);
      } else out.push(n.charCodeAt(0) & 0xff);
      continue;
    }
    if (c === 0x28) depth++;
    else if (c === 0x29 && --depth === 0) break;
    out.push(c & 0xff);
  }
  return out;
}

/** The value of `/Key` in a dictionary source: a literal or hex string, or null. */
function stringValue(dict: string, key: string): string | null {
  const m = new RegExp(`/${key}\\s*([(<])`).exec(dict);
  if (!m) return null;
  const at = m.index + m[0].length;
  if (m[1] === '(') return cleanText(decodePdfBytes(literalAt(dict, at)));
  const end = dict.indexOf('>', at);
  const hex = dict.slice(at, end < 0 ? undefined : end).replace(/[^0-9a-fA-F]/g, '');
  const bytes: number[] = [];
  for (let i = 0; i < hex.length; i += 2) bytes.push(parseInt(hex.slice(i, i + 2).padEnd(2, '0'), 16));
  return cleanText(decodePdfBytes(bytes));
}

/** The '<< … >>' dictionary that starts at or after `from`, nesting respected. */
function dictAt(src: string, from: number): string | null {
  const start = src.indexOf('<<', from);
  if (start < 0 || start - from > 64) return null;
  const end = Math.min(src.length, start + DICT_MAX);
  let depth = 0;
  for (let i = start; i < end - 1; i++) {
    if (src[i] === '<' && src[i + 1] === '<') { depth++; i++; }
    else if (src[i] === '>' && src[i + 1] === '>') { depth--; i++; if (depth === 0) return src.slice(start, i + 1); }
    else if (src[i] === '(') {
      // skip a literal string: a '>>' inside a title must not close the dictionary
      let d = 1;
      for (i++; i < end && d > 0; i++) {
        if (src[i] === '\\') i++;
        else if (src[i] === '(') d++;
        else if (src[i] === ')') d--;
      }
      i--;
    }
  }
  return null;
}

/** The document information dictionary the (last) trailer names, when its object is in the windows read. */
function infoDict(src: string): string | null {
  const refs = [...src.matchAll(/\/Info\s+(\d+)\s+(\d+)\s+R/g)].slice(-MAX_CANDIDATES);
  if (refs.length === 0) return null;
  // every 'N G obj' header in one pass: the last one of each object wins (an update rewrites it)
  const objEnd = new Map<string, number>();
  for (const m of src.matchAll(/(?:^|[\s>])(\d+)\s+(\d+)\s+obj\b/g)) objEnd.set(`${m[1]} ${m[2]}`, m.index + m[0].length);
  for (const ref of refs.reverse()) {
    const at = objEnd.get(`${ref[1]} ${ref[2]}`);
    if (at !== undefined) {
      const d = dictAt(src, at);
      if (d) return d;
    }
  }
  return null;
}

/** dc:<field> of an XMP packet: rdf:Alt / rdf:Seq / rdf:Bag items, or the element's own text. */
function xmpValues(xmp: XmlElement, field: string): string[] {
  const el = findAll(xmp, field).find((e) => e.name.startsWith('dc:') || e.name.startsWith('prism:') || e.name === field);
  if (!el) return [];
  const items = findAll(el, 'li').map((li) => cleanText(textOf(li))).filter((v): v is string => v !== null);
  if (items.length) return items;
  const own = cleanText(textOf(el));
  return own ? [own] : [];
}

function pageCount(src: string): number | null {
  const lin = /\/Linearized\s+[\d.]+[^>]*?\/N\s+(\d+)/.exec(src.slice(0, LINEARIZED_SCAN));
  if (lin) return Number(lin[1]);
  let best: number | null = null;
  for (const m of [...src.matchAll(/\/Type\s*\/Pages\b/g)].slice(-MAX_CANDIDATES)) {
    // the /Count of the dictionary around this /Type /Pages (opened at most a dictionary's length before it)
    const open = src.lastIndexOf('<<', m.index);
    if (open < 0 || m.index - open > DICT_MAX) continue;
    const d = open >= 0 ? dictAt(src, open) : null;
    const c = d ? /\/Count\s+(\d+)/.exec(d) : null;
    if (c) best = Math.max(best ?? 0, Number(c[1]));
  }
  return best && best > 0 ? best : null;
}

export async function readPdf(absPath: string): Promise<BookMetadata> {
  const src = await readWindows(absPath);
  if (!src.startsWith('%PDF-') && !src.slice(0, 1024).includes('%PDF-')) throw new Error('not a PDF: no %PDF- header');

  const xmpOpen = src.indexOf('<x:xmpmeta');
  const xmpClose = xmpOpen < 0 ? -1 : src.indexOf('</x:xmpmeta>', xmpOpen);
  const packet = xmpClose < 0 ? null : src.slice(xmpOpen, xmpClose + '</x:xmpmeta>'.length);
  // XMP is UTF-8; the windows were read as latin1
  const xmp = packet ? findFirst(parseXml(Buffer.from(packet, 'latin1').toString('utf8')), 'xmpmeta') : null;
  const info = infoDict(src);

  const xmpTitle = xmp ? xmpValues(xmp, 'title')[0] ?? null : null;
  const xmpAuthors = xmp ? xmpValues(xmp, 'creator') : [];
  const infoAuthor = info ? stringValue(info, 'Author') : null;
  const authors = xmpAuthors.length
    ? xmpAuthors
    : (infoAuthor ?? '').split(/;|\s+and\s+|,(?=\s*\S+\s+\S+)/).map((a) => cleanText(a)).filter((a): a is string => a !== null);

  const identifiers: BookIdentifier[] = [];
  let isbn13: string | null = null;
  const ids = xmp ? [...xmpValues(xmp, 'isbn'), ...xmpValues(xmp, 'identifier')] : [];
  for (const value of ids) {
    const isbn = normalizeIsbn(value);
    identifiers.push({ scheme: isbn ? 'isbn' : null, value });
    if (!isbn13 && isbn) isbn13 = isbn;
  }
  const created = info ? stringValue(info, 'CreationDate') : null;

  return {
    format: 'pdf',
    title: xmpTitle ?? (info ? stringValue(info, 'Title') : null),
    authors,
    series: null,
    seriesIndex: null,
    isbn13,
    identifiers,
    language: xmp ? xmpValues(xmp, 'language')[0] ?? null : null,
    publisher: xmp ? xmpValues(xmp, 'publisher')[0] ?? null : null,
    published: created ? /^(?:D:)?(\d{4})/.exec(created)?.[1] ?? null : null,
    pages: pageCount(src),
    cover: null,
  };
}
