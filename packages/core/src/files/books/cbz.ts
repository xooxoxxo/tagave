/**
 * CBZ: a zip of page images, with an optional ComicInfo.xml (the
 * ComicRack schema: Title, Series, Number, Writer, Publisher, Year, Month,
 * Day, LanguageISO, GTIN, PageCount, Pages/Page[@Type="FrontCover"]).
 * Without ComicInfo the file has pages and a cover, nothing else. Comics
 * identity (ComicVine and the like) is parked: what the file says is all.
 */
import { withZip } from './zip.js';
import { attr, findAll, findFirst, parseXml, textOf, type XmlElement } from './xml.js';
import { cleanText, imageMediaType, normalizeIsbn, seriesNumber, type BookMetadata } from './metadata.js';

const COMIC_INFO_MAX = 1024 * 1024;

const isPage = (name: string) => !name.endsWith('/') && !name.startsWith('__MACOSX/') && !/(^|\/)\./.test(name) && imageMediaType(name) !== null;

/** Page order: names compared with their numbers as numbers ('2.jpg' before '10.jpg'). */
const byPage = new Intl.Collator('en', { numeric: true, sensitivity: 'base' }).compare;

export async function readCbz(absPath: string): Promise<BookMetadata> {
  return withZip(absPath, async (zip) => {
    const pages = zip.entries.map((e) => e.name).filter(isPage).sort(byPage);
    const infoEntry = zip.entries.find((e) => /(^|\/)comicinfo\.xml$/i.test(e.name)) ?? null;
    let info: XmlElement | null = null;
    if (infoEntry) {
      const doc = parseXml((await zip.read(infoEntry, COMIC_INFO_MAX)).toString('utf8'));
      info = findFirst(doc, 'ComicInfo') ?? doc;
    }
    const field = (name: string) => (info ? cleanText(textOf(info.children.find((c) => c.local === name) ?? null)) : null);

    const series = field('Series');
    const number = field('Number');
    const title = field('Title') ?? (series && number ? `${series} ${number}` : null);
    const authors = (field('Writer') ?? '').split(/[,;]/).map((a) => cleanText(a)).filter((a): a is string => a !== null);
    const gtin = field('GTIN');
    const isbn13 = normalizeIsbn(gtin);
    const year = field('Year');
    const month = field('Month');
    const day = field('Day');
    const published = year ? [year, month, day].filter(Boolean).map((p, i) => (i === 0 ? p! : p!.padStart(2, '0'))).join('-') : null;
    const declaredPages = seriesNumber(field('PageCount'));

    // the cover: the page ComicInfo marks FrontCover, else the first page
    let cover = pages[0] ?? null;
    if (info) {
      const front = findAll(info, 'Page').find((p) => (attr(p, 'Type') ?? '').toLowerCase() === 'frontcover');
      const idx = front ? Number(attr(front, 'Image')) : NaN;
      if (Number.isInteger(idx) && idx >= 0 && idx < pages.length) cover = pages[idx]!;
    }

    return {
      format: 'cbz',
      title,
      authors,
      series,
      seriesIndex: series ? seriesNumber(number) : null,
      isbn13,
      identifiers: gtin ? [{ scheme: isbn13 ? 'isbn' : 'gtin', value: gtin }] : [],
      language: field('LanguageISO'),
      publisher: field('Publisher'),
      published,
      pages: declaredPages && declaredPages > 0 ? Math.round(declaredPages) : pages.length || null,
      cover,
    };
  });
}
