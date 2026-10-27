/**
 * EPUB (2 and 3): the package document (OPF) found through
 * META-INF/container.xml. Title, authors (creators whose role is aut, or
 * unset), identifiers (ISBN verified), language, publisher, date, series
 * (calibre:series / series_index, or EPUB 3 belongs-to-collection with
 * group-position) and the cover image (EPUB 3 cover-image, or EPUB 2
 * <meta name="cover">). Page count is not cheap for EPUB: left null.
 */
import path from 'node:path/posix';
import { withZip, type ZipReader } from './zip.js';
import { attr, findAll, findFirst, parseXml, textOf, type XmlElement } from './xml.js';
import { cleanText, imageMediaType, normalizeIsbn, seriesNumber, type BookIdentifier, type BookMetadata } from './metadata.js';

const OPF_MAX = 4 * 1024 * 1024;

async function opfPath(zip: ZipReader): Promise<string> {
  const container = zip.find('META-INF/container.xml', true);
  if (!container) throw new Error('not an EPUB: META-INF/container.xml is missing');
  const doc = parseXml((await zip.read(container, OPF_MAX)).toString('utf8'));
  const roots = findAll(doc, 'rootfile');
  const pick = roots.find((r) => (attr(r, 'media-type') ?? '') === 'application/oebps-package+xml') ?? roots[0];
  const full = pick ? attr(pick, 'full-path') : null;
  if (!full) throw new Error('not an EPUB: container.xml names no package document');
  return full;
}

/** An href in the OPF, as the zip entry it names (relative to the OPF's folder, URL-decoded). */
function resolveHref(opf: string, href: string): string {
  let h = href.split('#')[0]!;
  try {
    h = decodeURIComponent(h);
  } catch {
    /* keep it as written */
  }
  return path.normalize(path.join(path.dirname(opf), h)).replace(/^\.\//, '');
}

function refinesOf(meta: XmlElement[], id: string | null, property: string): string | null {
  if (!id) return null;
  const m = meta.find((x) => attr(x, 'refines') === `#${id}` && attr(x, 'property') === property);
  return m ? textOf(m) : null;
}

function coverEntry(zip: ZipReader, opf: string, pkg: XmlElement, meta: XmlElement[]): string | null {
  const items = findAll(pkg, 'item');
  const exists = (href: string | null) => {
    if (!href) return null;
    const name = resolveHref(opf, href);
    return zip.find(name) ? name : null;
  };
  // EPUB 3: the manifest item whose properties include cover-image
  const v3 = items.find((it) => (attr(it, 'properties') ?? '').split(/\s+/).includes('cover-image'));
  const a = exists(v3 ? attr(v3, 'href') : null);
  if (a) return a;
  // EPUB 2: <meta name="cover" content="<item id>">
  const m = meta.find((x) => attr(x, 'name') === 'cover');
  const idRef = m ? attr(m, 'content') : null;
  const v2 = idRef ? items.find((it) => attr(it, 'id') === idRef) : undefined;
  const b = exists(v2 ? attr(v2, 'href') : null);
  if (b && imageMediaType(b)) return b;
  // neither: an image item called cover
  const guess = items.find((it) => /cover/i.test(`${attr(it, 'id') ?? ''} ${attr(it, 'href') ?? ''}`) && (attr(it, 'media-type') ?? '').startsWith('image/'));
  return exists(guess ? attr(guess, 'href') : null);
}

export async function readEpub(absPath: string): Promise<BookMetadata> {
  return withZip(absPath, async (zip) => {
    const opf = await opfPath(zip);
    const entry = zip.find(opf) ?? zip.find(opf, true);
    if (!entry) throw new Error(`not an EPUB: the package document ${opf} is missing`);
    const doc = parseXml((await zip.read(entry, OPF_MAX)).toString('utf8'));
    const pkg = findFirst(doc, 'package') ?? doc;
    const md = findFirst(pkg, 'metadata') ?? pkg;
    const meta = findAll(md, 'meta');
    // dc:* elements, also inside an OEB 1.2 <dc-metadata> wrapper
    const dc = (local: string) => findAll(md, local);
    const named = (name: string) => {
      const m = meta.find((x) => attr(x, 'name') === name);
      return m ? attr(m, 'content') : null;
    };

    // creators: role from opf:role (EPUB 2) or a refining meta (EPUB 3); authors are 'aut' or unset
    const creators = dc('creator').map((c) => ({
      name: cleanText(textOf(c)),
      role: (attr(c, 'role') ?? refinesOf(meta, attr(c, 'id'), 'role'))?.toLowerCase() ?? null,
    })).filter((c): c is { name: string; role: string | null } => c.name !== null);
    const authored = creators.filter((c) => c.role === null || c.role === 'aut');
    const authors = (authored.length ? authored : creators).map((c) => c.name);

    const identifiers: BookIdentifier[] = [];
    let isbn13: string | null = null;
    for (const el of dc('identifier')) {
      const value = cleanText(textOf(el));
      if (!value) continue;
      const declared = attr(el, 'scheme')?.toLowerCase() ?? refinesOf(meta, attr(el, 'id'), 'identifier-type')?.toLowerCase() ?? null;
      const prefixed = /^urn:([a-z0-9]+):/i.exec(value)?.[1]?.toLowerCase() ?? null;
      const isbn = normalizeIsbn(value);
      const scheme = declared ?? prefixed ?? (isbn ? 'isbn' : null);
      identifiers.push({ scheme, value });
      // a number another scheme names (a calibre id, an ASIN) is not taken for an ISBN
      if (!isbn13 && isbn && scheme === 'isbn') isbn13 = isbn;
    }

    // series: calibre's metas, else EPUB 3 belongs-to-collection
    let series = cleanText(named('calibre:series'));
    let seriesIndex = seriesNumber(named('calibre:series_index'));
    if (!series) {
      const coll = meta.find((m) => attr(m, 'property') === 'belongs-to-collection');
      if (coll) {
        series = cleanText(textOf(coll));
        seriesIndex = seriesNumber(refinesOf(meta, attr(coll, 'id'), 'group-position'));
      }
    }

    const first = (local: string) => cleanText(textOf(dc(local)[0] ?? null));
    return {
      format: 'epub',
      title: first('title'),
      authors,
      series,
      seriesIndex: series ? seriesIndex : null,
      isbn13,
      identifiers,
      language: first('language'),
      publisher: first('publisher'),
      published: first('date'),
      pages: null,
      cover: coverEntry(zip, opf, pkg, meta),
    };
  });
}
