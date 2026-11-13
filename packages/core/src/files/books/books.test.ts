/**
 * The book handlers (the Books spike) over tiny files built in memory
 * (fixtures.ts): EPUB 2 and 3, PDF with an Info dictionary and an XMP
 * packet, CBZ with and without ComicInfo, and broken files.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fileTypeHandler } from '../handlers.js';
import { cbzHandler, epubHandler, pdfHandler, titleFromName } from './index.js';
import { FIXTURE_ISBN, TINY_PNG, cbzBytes, epubBytes, pdfBytes, writeBookFixtures, zipBytes } from './fixtures.js';
import { bookIdentityDigest, normalizeIsbn, seriesNumber, type BookMetadata } from './metadata.js';
import { attr, findAll, parseXml, textOf } from './xml.js';
import { withZip } from './zip.js';
import { readPdf } from './pdf.js';

let dir: string;
const put = async (name: string, bytes: Buffer) => {
  const p = path.join(dir, name);
  await writeFile(p, bytes);
  return p;
};
const meta = async (h: typeof epubHandler, p: string) => (await h.parse(p)).metadata as BookMetadata;

beforeAll(async () => { dir = await mkdtemp(path.join(tmpdir(), 'tagave-books-')); });
afterAll(async () => { await rm(dir, { recursive: true, force: true }); });

describe('ISBN and series numbers', () => {
  it('verifies check digits, converts ISBN-10 to ISBN-13, strips urn:isbn: and hyphens', () => {
    expect(normalizeIsbn(FIXTURE_ISBN.lanterns13)).toBe(FIXTURE_ISBN.lanterns13);
    expect(normalizeIsbn(`urn:isbn:978-0-00-000000-2`)).toBe(FIXTURE_ISBN.lanterns13);
    expect(normalizeIsbn(FIXTURE_ISBN.harbour10)).toBe(FIXTURE_ISBN.harbour13);
    expect(normalizeIsbn('9780000000003')).toBeNull();
    expect(normalizeIsbn('0000000018')).toBeNull();
    expect(normalizeIsbn('urn:uuid:1234')).toBeNull();
    expect(normalizeIsbn('')).toBeNull();
    expect(seriesNumber('#3')).toBe(3);
    expect(seriesNumber('2,5')).toBe(2.5);
    expect(seriesNumber('one')).toBeNull();
  });
});

describe('the XML reader', () => {
  it('reads prefixed elements, attributes, entities and CDATA; skips comments, PIs and a DOCTYPE with a subset', () => {
    const doc = parseXml(`<?xml version="1.0"?><!DOCTYPE x [<!ENTITY e "boom">]><!-- c --><a xmlns:dc="d"><dc:title id='t'>Tom &amp; Jerry &#x263A;</dc:title><b><![CDATA[<raw>]]></b><dc:title/></a>`);
    const titles = findAll(doc, 'title');
    expect(titles).toHaveLength(2);
    expect(textOf(titles[0]!)).toBe('Tom & Jerry ☺');
    expect(attr(titles[0]!, 'id')).toBe('t');
    expect(textOf(findAll(doc, 'b')[0]!)).toBe('<raw>');
    // an undeclared entity is never expanded
    expect(textOf(parseXml('<a>&e;</a>'))).toBe('&e;');
  });

  it('never throws on broken input: unclosed elements close at the end, stray end tags are skipped', () => {
    const doc = parseXml('<a><b>one</c><d attr="x>y">two');
    expect(textOf(findAll(doc, 'b')[0]!)).toBe('one two');
    expect(attr(findAll(doc, 'd')[0]!, 'attr')).toBe('x>y');
  });
});

describe('the zip reader', () => {
  it('lists entries and reads stored and deflated ones', async () => {
    const p = await put('two.zip', zipBytes([{ name: 'a.txt', data: 'stored', store: true }, { name: 'dir/b.txt', data: 'x'.repeat(5000) }]));
    await withZip(p, async (zip) => {
      expect(zip.entries.map((e) => e.name)).toEqual(['a.txt', 'dir/b.txt']);
      expect((await zip.read(zip.find('a.txt')!)).toString()).toBe('stored');
      expect((await zip.read(zip.find('DIR/B.TXT', true)!)).toString()).toBe('x'.repeat(5000));
      await expect(zip.read(zip.find('dir/b.txt')!, 10)).rejects.toThrow(/larger than/);
    });
  });

  // the first central-directory entry's claimed sizes, rewritten (a hostile archive's lies)
  const lie = (zip: Buffer, sizes: { compressedSize?: number; size?: number }): Buffer => {
    const out = Buffer.from(zip);
    const cd = out.readUInt32LE(out.length - 22 + 16);
    if (sizes.compressedSize !== undefined) out.writeUInt32LE(sizes.compressedSize, cd + 20);
    if (sizes.size !== undefined) out.writeUInt32LE(sizes.size, cd + 24);
    return out;
  };

  it('trusts no size the archive claims: past the end, over the cap, stored sizes that differ', async () => {
    const stored = zipBytes([{ name: 'a.txt', data: 'stored', store: true }]);
    // a compressed size past the end of the file (4 GiB - 1): refused before anything is allocated
    await withZip(await put('past-end.zip', lie(stored, { compressedSize: 0xfffffffe, size: 6 })), async (zip) => {
      await expect(zip.read(zip.entries[0]!)).rejects.toThrow(/larger than|past the end/);
    });
    await withZip(await put('past-end-small.zip', lie(stored, { compressedSize: 5000, size: 5000 })), async (zip) => {
      await expect(zip.read(zip.entries[0]!)).rejects.toThrow(/past the end/);
    });
    // a compressed size over the cap, whatever the declared size
    const deflated = zipBytes([{ name: 'b.txt', data: 'x'.repeat(5000) }]);
    await withZip(await put('over-cap.zip', lie(deflated, { size: 1 })), async (zip) => {
      await expect(zip.read(zip.entries[0]!, 2)).rejects.toThrow(/larger than/);
    });
    // stored: the two sizes must agree
    await withZip(await put('stored-lie.zip', lie(stored, { size: 3 })), async (zip) => {
      await expect(zip.read(zip.entries[0]!)).rejects.toThrow(/sizes differ/);
    });
  });

  it('a deflate bomb that declares a tiny size stops inflating at the cap', async () => {
    // 8 MiB of zeros deflates to a few KiB; the entry claims 10 bytes
    const bomb = lie(zipBytes([{ name: 'bomb.xml', data: Buffer.alloc(8 * 1024 * 1024) }]), { size: 10 });
    await withZip(await put('bomb.zip', bomb), async (zip) => {
      expect(zip.entries[0]!.compressedSize).toBeLessThan(64 * 1024);
      await expect(zip.read(zip.entries[0]!, 64 * 1024)).rejects.toThrow(/larger than/);
    });
  });

  it('refuses what is not a zip', async () => {
    const p = await put('nope.zip', Buffer.from('plain text, no central directory'));
    await expect(withZip(p, async () => 1)).rejects.toThrow(/not a zip/);
  });
});

describe('epub', () => {
  it('EPUB 3: title, authors by role, ISBN, language, publisher, date, collection series and the cover-image item', async () => {
    const p = await put('v3.epub', epubBytes({ title: 'A Test of Lanterns', authors: ['Ada Example', 'Eve Second'], illustrator: 'Cy Drawer', isbn: FIXTURE_ISBN.lanterns13, series: 'Lantern Tales', seriesIndex: 1, publisher: 'Fixture Press', date: '2021-05-04', cover: TINY_PNG }));
    const parsed = await epubHandler.parse(p);
    expect(parsed.columns).toMatchObject({ container: 'EPUB', codec: null, durationMs: null, hasEmbeddedArt: true });
    expect(parsed.metadata).toEqual({
      format: 'epub', title: 'A Test of Lanterns', authors: ['Ada Example', 'Eve Second'], series: 'Lantern Tales', seriesIndex: 1,
      isbn13: FIXTURE_ISBN.lanterns13,
      identifiers: [{ scheme: 'uuid', value: expect.stringMatching(/^urn:uuid:/) }, { scheme: 'isbn', value: `urn:isbn:${FIXTURE_ISBN.lanterns13}` }],
      language: 'en', publisher: 'Fixture Press', published: '2021-05-04', pages: null, cover: 'OEBPS/images/cover.png',
    });
    const cover = await epubHandler.cover!(p, parsed.metadata);
    expect(cover).toEqual({ bytes: TINY_PNG, mediaType: 'image/png' });
  });

  it('EPUB 2: opf:role, opf:scheme ISBN-10, calibre series and <meta name="cover">', async () => {
    const p = await put('v2.epub', epubBytes({ title: 'Quiet Harbour', authors: ['Ben Sample'], illustrator: 'Cy Drawer', isbn: FIXTURE_ISBN.harbour10, series: 'Harbour', seriesIndex: 2, version: 2, language: 'nl', cover: TINY_PNG }));
    expect(await meta(epubHandler, p)).toMatchObject({
      title: 'Quiet Harbour', authors: ['Ben Sample'], series: 'Harbour', seriesIndex: 2, isbn13: FIXTURE_ISBN.harbour13, language: 'nl', cover: 'OEBPS/images/cover.png',
    });
  });

  it('no cover, no ISBN: nulls, never a guess', async () => {
    const p = await put('bare.epub', epubBytes({ title: 'Bare', authors: [] }));
    expect(await meta(epubHandler, p)).toMatchObject({ title: 'Bare', authors: [], isbn13: null, series: null, seriesIndex: null, cover: null });
    expect(await epubHandler.cover!(p, await meta(epubHandler, p))).toBeNull();
  });

  it('a zip without container.xml, and a file that is no zip, fail to parse', async () => {
    await expect(epubHandler.parse(await put('nocontainer.epub', zipBytes([{ name: 'mimetype', data: 'application/epub+zip', store: true }])))).rejects.toThrow(/container\.xml/);
    await expect(epubHandler.parse(await put('text.epub', Buffer.from('hello')))).rejects.toThrow(/not a zip/);
  });
});

describe('pdf', () => {
  it('XMP first (title, creator, language), the page tree count, the creation year', async () => {
    const p = await put('xmp.pdf', pdfBytes({ title: 'A Test of Lanterns', author: 'Ada Example', pages: 3, xmp: true }));
    const parsed = await pdfHandler.parse(p);
    expect(parsed.columns).toMatchObject({ container: 'PDF', hasEmbeddedArt: false });
    expect(parsed.metadata).toEqual({
      format: 'pdf', title: 'A Test of Lanterns', authors: ['Ada Example'], series: null, seriesIndex: null, isbn13: null, identifiers: [],
      language: 'en', publisher: null, published: '2024', pages: 3, cover: null,
    });
    expect(pdfHandler.cover).toBeUndefined();
  });

  it('the Info dictionary the trailer names: a UTF-16 title, several authors', async () => {
    const p = await put('info.pdf', pdfBytes({ title: 'Ünïcode — Title (2)', author: 'Ada Example; Ben Sample', pages: 2, utf16Title: true }));
    expect(await meta(pdfHandler, p)).toMatchObject({ title: 'Ünïcode — Title (2)', authors: ['Ada Example', 'Ben Sample'], pages: 2, language: null });
  });

  it('a hostile PDF (many /Info refs and page trees, a huge unterminated dictionary, an unclosed XMP) parses fast', async () => {
    const hostile = [
      '%PDF-1.4\n<x:xmpmeta\n',
      ...Array.from({ length: 5000 }, (_, i) => `${i} 0 obj\n`),
      '1 0 obj\n<< /Title (', '<<('.repeat(150_000),
      '/Info 1 0 R\n'.repeat(60_000),
      '<< /Type /Pages /Kids [ '.repeat(15_000),
    ].join('');
    expect(hostile.length).toBeLessThan(2 * 1024 * 1024); // one window: every byte is examined
    const p = await put('hostile.pdf', Buffer.from(hostile, 'latin1'));
    const started = performance.now();
    const m = await readPdf(p);
    expect(performance.now() - started).toBeLessThan(1500);
    expect(m).toMatchObject({ format: 'pdf', title: null, pages: null });
  });

  it('no title: null (the app names it after the file); a file that is no PDF fails', async () => {
    expect(await meta(pdfHandler, await put('untitled.pdf', pdfBytes({ pages: 1 })))).toMatchObject({ title: null, authors: [], pages: 1 });
    await expect(pdfHandler.parse(await put('fake.pdf', Buffer.from('not a pdf')))).rejects.toThrow(/%PDF-/);
    expect(titleFromName('Papers/untitled_draft.pdf')).toBe('untitled draft');
  });
});

describe('cbz', () => {
  it('ComicInfo: title, series and number, writers, GTIN as ISBN, year, language, page count, the FrontCover page', async () => {
    const p = await put('ns.cbz', cbzBytes({ pages: 4, comicInfo: { title: 'Night Shift', series: 'Night Shift', number: '1', writer: 'Cleo Placeholder, Dan Standin', year: 2020, language: 'en', gtin: FIXTURE_ISBN.nightShift13, frontCover: 1 } }));
    const parsed = await cbzHandler.parse(p);
    expect(parsed.metadata).toEqual({
      format: 'cbz', title: 'Night Shift', authors: ['Cleo Placeholder', 'Dan Standin'], series: 'Night Shift', seriesIndex: 1,
      isbn13: FIXTURE_ISBN.nightShift13, identifiers: [{ scheme: 'isbn', value: FIXTURE_ISBN.nightShift13 }],
      language: 'en', publisher: null, published: '2020', pages: 4, cover: 'page2.png',
    });
    expect((await cbzHandler.cover!(p, parsed.metadata))?.mediaType).toBe('image/png');
  });

  it('no ComicInfo: pages in natural order, the first one the cover, nothing else', async () => {
    const p = await put('loose.cbz', zipBytes(['page10.png', 'page2.png', '__MACOSX/._page1.png', 'page1.png', 'notes.txt'].map((name) => ({ name, data: TINY_PNG, store: true }))));
    expect(await meta(cbzHandler, p)).toMatchObject({ title: null, authors: [], pages: 3, cover: 'page1.png', isbn13: null });
  });
});

describe('identity digest (move-safe Tier 2)', () => {
  it('stable for the same book, different for another format or title, null with nothing to go by', () => {
    const m: BookMetadata = { format: 'epub', title: 'T', authors: ['A'], series: null, seriesIndex: null, isbn13: null, identifiers: [], language: null, publisher: null, published: null, pages: null, cover: null };
    expect(bookIdentityDigest(m)).toMatch(/^[0-9a-f]{40}$/);
    expect(bookIdentityDigest({ ...m, cover: 'x.png', pages: 9 })).toBe(bookIdentityDigest(m));
    expect(bookIdentityDigest({ ...m, format: 'pdf' })).not.toBe(bookIdentityDigest(m));
    expect(bookIdentityDigest({ ...m, title: 'U' })).not.toBe(bookIdentityDigest(m));
    expect(bookIdentityDigest({ ...m, title: null })).toBeNull();
    expect(bookIdentityDigest(null)).toBeNull();
  });
});

describe('the fixture folder', () => {
  it('every file reads as the test expects (the round-trip tests scan this folder)', async () => {
    const root = path.join(dir, 'library');
    const rels = await writeBookFixtures(root);
    const out: Record<string, string | null> = {};
    for (const rel of rels) {
      const h = fileTypeHandler(path.extname(rel).slice(1));
      if (!h) { out[rel] = 'not a book'; continue; }
      try {
        out[rel] = ((await h.parse(path.join(root, rel))).metadata as BookMetadata).title ?? '(untitled)';
      } catch (err) {
        out[rel] = `error: ${(err as Error).message}`;
      }
    }
    expect(out).toEqual({
      'Ada Example/A Test of Lanterns.epub': 'A Test of Lanterns',
      'Ada Example/A Test of Lanterns.pdf': 'A Test of Lanterns',
      'Ben Sample/Quiet Harbour.epub': 'Quiet Harbour',
      'Comics/Night Shift 001.cbz': 'Night Shift',
      'Comics/loose pages.cbz': '(untitled)',
      'Papers/untitled.pdf': '(untitled)',
      'Broken/not really.epub': 'error: not a zip file (no end of central directory)',
      'Ada Example/cover.jpg': 'not a book',
    });
  });
});
