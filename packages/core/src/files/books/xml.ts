/**
 * A small, tolerant XML reader for the metadata files books carry: an EPUB's
 * container.xml and OPF package, a comic's ComicInfo.xml, a PDF's XMP
 * packet. It builds an element tree (names with their prefixes, attributes,
 * direct text) and never throws on malformed input: an unclosed element
 * closes at the end, a stray end tag is skipped. No DTDs, no external
 * entities (nothing is ever fetched or expanded beyond the five XML
 * entities and character references).
 */

export interface XmlElement {
  /** As written, with its prefix ('dc:title'). */
  name: string;
  /** Without the prefix ('title'). */
  local: string;
  attrs: Readonly<Record<string, string>>;
  children: XmlElement[];
  /** Its own text (not its children's), entities decoded. */
  text: string;
}

const NAMED: Readonly<Record<string, string>> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

export function decodeEntities(s: string): string {
  if (!s.includes('&')) return s;
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z][a-zA-Z0-9]*);/g, (m, ref: string) => {
    if (ref[0] === '#') {
      const code = ref[1] === 'x' || ref[1] === 'X' ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
    }
    return NAMED[ref] ?? m;
  });
}

export const localName = (name: string): string => {
  const i = name.indexOf(':');
  return i < 0 ? name : name.slice(i + 1);
};

const ATTR_RE = /([^\s=/>]+)\s*=\s*("([^"]*)"|'([^']*)')/g;

function element(name: string, attrSrc: string): XmlElement {
  const attrs: Record<string, string> = {};
  for (const m of attrSrc.matchAll(ATTR_RE)) attrs[m[1]!] = decodeEntities(m[3] ?? m[4] ?? '');
  return { name, local: localName(name), attrs, children: [], text: '' };
}

/** The document as a tree under a synthetic root (name ''). */
export function parseXml(src: string): XmlElement {
  const root: XmlElement = { name: '', local: '', attrs: {}, children: [], text: '' };
  const stack: XmlElement[] = [root];
  let i = 0;
  const top = () => stack[stack.length - 1]!;
  while (i < src.length) {
    const lt = src.indexOf('<', i);
    if (lt < 0) {
      top().text += decodeEntities(src.slice(i));
      break;
    }
    if (lt > i) top().text += decodeEntities(src.slice(i, lt));
    if (src.startsWith('<!--', lt)) {
      const end = src.indexOf('-->', lt + 4);
      i = end < 0 ? src.length : end + 3;
    } else if (src.startsWith('<![CDATA[', lt)) {
      const end = src.indexOf(']]>', lt + 9);
      top().text += src.slice(lt + 9, end < 0 ? src.length : end);
      i = end < 0 ? src.length : end + 3;
    } else if (src.startsWith('<?', lt)) {
      const end = src.indexOf('?>', lt + 2);
      i = end < 0 ? src.length : end + 2;
    } else if (src.startsWith('<!', lt)) {
      // <!DOCTYPE …> with an optional [internal subset]: skipped, never expanded
      let depth = 0;
      let j = lt + 2;
      for (; j < src.length; j++) {
        const c = src[j];
        if (c === '[') depth++;
        else if (c === ']') depth--;
        else if (c === '>' && depth <= 0) break;
      }
      i = j + 1;
    } else if (src[lt + 1] === '/') {
      const end = src.indexOf('>', lt);
      const name = src.slice(lt + 2, end < 0 ? src.length : end).trim();
      i = end < 0 ? src.length : end + 1;
      // close up to the matching open element; a stray end tag is ignored
      for (let k = stack.length - 1; k > 0; k--) {
        if (stack[k]!.name === name) {
          stack.length = k;
          break;
        }
      }
    } else {
      // a start tag: find its '>' outside quoted attribute values
      let j = lt + 1;
      let quote: string | null = null;
      for (; j < src.length; j++) {
        const c = src[j];
        if (quote) {
          if (c === quote) quote = null;
        } else if (c === '"' || c === "'") quote = c;
        else if (c === '>') break;
      }
      const body = src.slice(lt + 1, j);
      i = j + 1;
      const selfClosing = body.endsWith('/');
      const inner = selfClosing ? body.slice(0, -1) : body;
      const m = /^([^\s/>]+)/.exec(inner);
      if (!m) continue;
      const el = element(m[1]!, inner.slice(m[1]!.length));
      top().children.push(el);
      if (!selfClosing) stack.push(el);
    }
  }
  return root;
}

/** Every descendant element with this local name, in document order. */
export function findAll(el: XmlElement, local: string): XmlElement[] {
  const out: XmlElement[] = [];
  const walk = (e: XmlElement) => {
    for (const c of e.children) {
      if (c.local === local) out.push(c);
      walk(c);
    }
  };
  walk(el);
  return out;
}

export function findFirst(el: XmlElement, local: string): XmlElement | null {
  return findAll(el, local)[0] ?? null;
}

/** An attribute by its local name ('role' finds opf:role and role). */
export function attr(el: XmlElement, local: string): string | null {
  if (el.attrs[local] !== undefined) return el.attrs[local]!;
  for (const [k, v] of Object.entries(el.attrs)) if (localName(k) === local) return v;
  return null;
}

/** The element's text and its descendants', trimmed, whitespace collapsed. */
export function textOf(el: XmlElement | null): string | null {
  if (!el) return null;
  const parts: string[] = [];
  const walk = (e: XmlElement) => {
    parts.push(e.text);
    for (const c of e.children) walk(c);
  };
  walk(el);
  const t = parts.join(' ').replace(/\s+/g, ' ').trim();
  return t === '' ? null : t;
}
