/**
 * Tiny book files for tests (@tagave/core/files/fixtures): EPUB 2 and 3,
 * PDF and CBZ, built in memory. Every title, name and number here is made
 * up for the tests; no real book's content. The ISBNs are made-up numbers
 * with valid check digits.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { crc32, deflateRawSync } from 'node:zlib';

export interface ZipFixtureEntry {
  name: string;
  data: string | Buffer;
  /** stored, not deflated (an EPUB's mimetype must be) */
  store?: boolean;
}

/** A zip file holding these entries, in this order. */
export function zipBytes(entries: readonly ZipFixtureEntry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const data = typeof e.data === 'string' ? Buffer.from(e.data, 'utf8') : e.data;
    const packed = e.store ? data : deflateRawSync(data);
    const name = Buffer.from(e.name, 'utf8');
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x800, 6);
    local.writeUInt16LE(e.store ? 0 : 8, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x800, 8);
    central.writeUInt16LE(e.store ? 0 : 8, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(packed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, packed);
    centrals.push(central, name);
    offset += local.length + name.length + packed.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

/** A 1×1 PNG: decodable by sharp, 68 bytes. */
export const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export interface EpubFixture {
  title: string;
  authors: string[];
  /** a creator who is not an author (role ill): never listed among the authors */
  illustrator?: string;
  isbn?: string;
  language?: string;
  publisher?: string;
  date?: string;
  series?: string;
  seriesIndex?: number;
  /** EPUB 3 (belongs-to-collection, cover-image) or EPUB 2 (calibre metas, meta name=cover) */
  version?: 2 | 3;
  cover?: Buffer;
}

export function epubBytes(f: EpubFixture): Buffer {
  const v3 = (f.version ?? 3) === 3;
  const creators = f.authors.map((a, i) => v3
    ? `<dc:creator id="c${i}">${esc(a)}</dc:creator><meta refines="#c${i}" property="role" scheme="marc:relators">aut</meta>`
    : `<dc:creator opf:role="aut">${esc(a)}</dc:creator>`);
  if (f.illustrator) {
    creators.push(v3
      ? `<dc:creator id="ill">${esc(f.illustrator)}</dc:creator><meta refines="#ill" property="role" scheme="marc:relators">ill</meta>`
      : `<dc:creator opf:role="ill">${esc(f.illustrator)}</dc:creator>`);
  }
  const series = f.series
    ? v3
      ? `<meta property="belongs-to-collection" id="s1">${esc(f.series)}</meta><meta refines="#s1" property="collection-type">series</meta>` +
        (f.seriesIndex != null ? `<meta refines="#s1" property="group-position">${f.seriesIndex}</meta>` : '')
      : `<meta name="calibre:series" content="${esc(f.series)}"/>` +
        (f.seriesIndex != null ? `<meta name="calibre:series_index" content="${f.seriesIndex}"/>` : '')
    : '';
  const coverItem = f.cover
    ? v3 ? '<item id="cover-img" href="images/cover.png" media-type="image/png" properties="cover-image"/>' : '<item id="cover-img" href="images/cover.png" media-type="image/png"/>'
    : '';
  const opf = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="${v3 ? '3.0' : '2.0'}" unique-identifier="uid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="http://www.idpf.org/2007/opf">
    <dc:title>${esc(f.title)}</dc:title>
    ${creators.join('\n    ')}
    <dc:identifier id="uid">urn:uuid:00000000-0000-4000-8000-${String(f.title.length).padStart(12, '0')}</dc:identifier>
    ${f.isbn ? (v3 ? `<dc:identifier id="isbn">urn:isbn:${esc(f.isbn)}</dc:identifier>` : `<dc:identifier opf:scheme="ISBN">${esc(f.isbn)}</dc:identifier>`) : ''}
    <dc:language>${esc(f.language ?? 'en')}</dc:language>
    ${f.publisher ? `<dc:publisher>${esc(f.publisher)}</dc:publisher>` : ''}
    ${f.date ? `<dc:date>${esc(f.date)}</dc:date>` : ''}
    ${series}
    ${!v3 && f.cover ? '<meta name="cover" content="cover-img"/>' : ''}
  </metadata>
  <manifest>
    <item id="ch1" href="text/ch1.xhtml" media-type="application/xhtml+xml"/>
    ${coverItem}
  </manifest>
  <spine><itemref idref="ch1"/></spine>
</package>`;
  const entries: ZipFixtureEntry[] = [
    { name: 'mimetype', data: 'application/epub+zip', store: true },
    { name: 'META-INF/container.xml', data: '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>' },
    { name: 'OEBPS/content.opf', data: opf },
    { name: 'OEBPS/text/ch1.xhtml', data: `<html xmlns="http://www.w3.org/1999/xhtml"><body><p>${esc(f.title)}: a test page.</p></body></html>` },
  ];
  if (f.cover) entries.push({ name: 'OEBPS/images/cover.png', data: f.cover, store: true });
  return zipBytes(entries);
}

export interface PdfFixture {
  title?: string;
  author?: string;
  pages: number;
  /** also an uncompressed XMP packet (dc:title, dc:creator, dc:language) */
  xmp?: boolean;
  /** UTF-16BE title in the Info dictionary (non-ASCII) */
  utf16Title?: boolean;
}

/** A minimal PDF: catalog, page tree with `pages` empty pages, an Info dictionary. Offsets in xref are exact. */
export function pdfBytes(f: PdfFixture): Buffer {
  const objs: string[] = [];
  const kids = Array.from({ length: f.pages }, (_, i) => `${4 + i} 0 R`).join(' ');
  objs.push(`<< /Type /Catalog /Pages 2 0 R${f.xmp ? ` /Metadata ${4 + f.pages} 0 R` : ''} >>`);
  objs.push(`<< /Type /Pages /Kids [${kids}] /Count ${f.pages} >>`);
  const pdfString = (s: string) => {
    if (!f.utf16Title) return `(${s.replace(/([()\\])/g, '\\$1')})`;
    const be = Buffer.from(s, 'utf16le').swap16();
    return `<FEFF${be.toString('hex').toUpperCase()}>`;
  };
  const info = [f.title ? `/Title ${pdfString(f.title)}` : '', f.author ? `/Author (${f.author})` : '', '/Producer (tagave tests)', '/CreationDate (D:20240102030405Z)'];
  objs.push(`<< ${info.filter(Boolean).join(' ')} >>`);
  for (let i = 0; i < f.pages; i++) objs.push('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 300] >>');
  if (f.xmp) {
    const packet = `<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?><x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:dc="http://purl.org/dc/elements/1.1/">` +
      (f.title ? `<dc:title><rdf:Alt><rdf:li xml:lang="x-default">${esc(f.title)}</rdf:li></rdf:Alt></dc:title>` : '') +
      (f.author ? `<dc:creator><rdf:Seq><rdf:li>${esc(f.author)}</rdf:li></rdf:Seq></dc:creator>` : '') +
      '<dc:language><rdf:Bag><rdf:li>en</rdf:li></rdf:Bag></dc:language></rdf:Description></rdf:RDF></x:xmpmeta><?xpacket end="w"?>';
    const bytes = Buffer.from(packet, 'utf8');
    objs.push(`<< /Type /Metadata /Subtype /XML /Length ${bytes.length} >>\nstream\n${bytes.toString('latin1')}\nendstream`);
  }
  let out = '%PDF-1.4\n%\xe2\xe3\xcf\xd3\n';
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(Buffer.byteLength(out, 'latin1'));
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R /Info 3 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

export interface CbzFixture {
  pages: number;
  comicInfo?: { title?: string; series?: string; number?: string; writer?: string; publisher?: string; year?: number; language?: string; gtin?: string; frontCover?: number };
}

export function cbzBytes(f: CbzFixture): Buffer {
  // page names out of natural order on purpose: '10' sorts after '2'
  const entries: ZipFixtureEntry[] = Array.from({ length: f.pages }, (_, i) => ({ name: `page${i + 1}.png`, data: TINY_PNG, store: true }));
  const c = f.comicInfo;
  if (c) {
    const tag = (k: string, v: string | number | undefined) => (v === undefined ? '' : `<${k}>${esc(String(v))}</${k}>`);
    const pages = c.frontCover !== undefined
      ? `<Pages>${Array.from({ length: f.pages }, (_, i) => `<Page Image="${i}"${i === c.frontCover ? ' Type="FrontCover"' : ''}/>`).join('')}</Pages>`
      : '';
    entries.unshift({
      name: 'ComicInfo.xml',
      data: `<?xml version="1.0" encoding="utf-8"?><ComicInfo xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">${tag('Title', c.title)}${tag('Series', c.series)}${tag('Number', c.number)}` +
        `${tag('Writer', c.writer)}${tag('Publisher', c.publisher)}${tag('Year', c.year)}${tag('LanguageISO', c.language)}${tag('GTIN', c.gtin)}${tag('PageCount', f.pages)}${pages}</ComicInfo>`,
    });
  }
  return zipBytes(entries);
}

/** Made-up ISBNs with valid check digits. */
export const FIXTURE_ISBN = {
  lanterns13: '9780000000002',
  harbour10: '0000000019',
  harbour13: '9780000000019',
  nightShift13: '9790000000001',
} as const;

/**
 * A folder of books as the round-trip tests scan it:
 *
 *   Ada Example/A Test of Lanterns.epub   EPUB 3, ISBN, series Lantern Tales #1, cover
 *   Ada Example/A Test of Lanterns.pdf    the same work as a PDF (Info + XMP), 3 pages
 *   Ben Sample/Quiet Harbour.epub         EPUB 2, ISBN-10, calibre series, cover, an illustrator
 *   Comics/Night Shift 001.cbz            ComicInfo, GTIN, 4 pages, front cover the 2nd
 *   Comics/loose pages.cbz                no ComicInfo: the name is the title
 *   Papers/untitled.pdf                   no title or author
 *   Broken/not really.epub                not a zip: a parse error
 *   Ada Example/cover.jpg                 an image beside the books (a music library's sidecar kind)
 */
export async function writeBookFixtures(dir: string): Promise<string[]> {
  const files: Array<[string, Buffer]> = [
    ['Ada Example/A Test of Lanterns.epub', epubBytes({ title: 'A Test of Lanterns', authors: ['Ada Example'], isbn: FIXTURE_ISBN.lanterns13, series: 'Lantern Tales', seriesIndex: 1, publisher: 'Fixture Press', date: '2021-05-04', cover: TINY_PNG })],
    ['Ada Example/A Test of Lanterns.pdf', pdfBytes({ title: 'A Test of Lanterns', author: 'Ada Example', pages: 3, xmp: true })],
    ['Ben Sample/Quiet Harbour.epub', epubBytes({ title: 'Quiet Harbour', authors: ['Ben Sample'], illustrator: 'Cy Drawer', isbn: FIXTURE_ISBN.harbour10, series: 'Harbour', seriesIndex: 2, version: 2, language: 'nl', cover: TINY_PNG })],
    ['Comics/Night Shift 001.cbz', cbzBytes({ pages: 4, comicInfo: { title: 'Night Shift', series: 'Night Shift', number: '1', writer: 'Cleo Placeholder, Dan Standin', year: 2020, language: 'en', gtin: FIXTURE_ISBN.nightShift13, frontCover: 1 } })],
    ['Comics/loose pages.cbz', cbzBytes({ pages: 2 })],
    ['Papers/untitled.pdf', pdfBytes({ pages: 1 })],
    ['Broken/not really.epub', Buffer.from('this is not a zip file')],
    ['Ada Example/cover.jpg', TINY_PNG],
  ];
  for (const [rel, bytes] of files) {
    await mkdir(path.join(dir, path.dirname(rel)), { recursive: true });
    await writeFile(path.join(dir, rel), bytes);
  }
  return files.map(([rel]) => rel);
}
