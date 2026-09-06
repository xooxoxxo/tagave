/**
 * Wikipedia "Critical reception" / "Reception" section for an album article
 * (spec REV-1, ENR-7, Appendix C): action=parse&prop=sections to find the
 * section, then action=parse&section=N&prop=text for its HTML, reduced to
 * attributed plain text (CC BY-SA 4.0 — the article link travels with it).
 * Concurrency 1 with an identifying User-Agent is the caller's job.
 */
import { z } from 'zod';

export interface WikiSection {
  index: string;
  line: string;
  toclevel?: number | undefined;
  anchor?: string | undefined;
}

export interface ReceptionSection {
  url: string;
  sectionTitle: string;
  text: string;
}

export interface IntroExtract {
  title: string;
  extract: string;
  url: string;
}

const SectionsSchema = z.object({
  parse: z.object({
    title: z.string(),
    pageid: z.number().nullish(),
    sections: z.array(z.object({
      index: z.string(),
      line: z.string(),
      toclevel: z.number().nullish(),
      anchor: z.string().nullish(),
    })),
  }).nullish(),
  error: z.object({ code: z.string().nullish() }).nullish(),
});

const TextSchema = z.object({
  parse: z.object({
    title: z.string(),
    text: z.string(),
  }).nullish(),
  error: z.object({ code: z.string().nullish() }).nullish(),
});

const ExtractsSchema = z.object({
  query: z.object({
    pages: z.record(z.object({
      title: z.string(),
      extract: z.string(),
    })).nullish(),
  }).nullish(),
  error: z.object({ code: z.string().nullish() }).nullish(),
});

const RECEPTION = /\breception\b/i;

/** The most prominent reception heading: "Critical reception" first, top-level before nested. */
export function findReceptionSection(sections: WikiSection[]): { index: number; line: string } | null {
  const candidates = sections
    .map((s) => ({ ...s, plain: s.line.replace(/<[^>]+>/g, '').trim() }))
    .filter((s) => RECEPTION.test(s.plain) && /^\d+$/.test(s.index));
  if (candidates.length === 0) return null;
  const score = (s: { plain: string; toclevel?: number | undefined }) =>
    (/^critical reception$/i.test(s.plain) ? 0 : /^reception$/i.test(s.plain) ? 1 : 2) * 10 + (s.toclevel ?? 1);
  candidates.sort((a, b) => score(a) - score(b) || parseInt(a.index, 10) - parseInt(b.index, 10));
  const best = candidates[0]!;
  return { index: parseInt(best.index, 10), line: best.plain };
}

const ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', thinsp: ' ', ensp: ' ', emsp: ' ',
};

function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&([a-z]+);/gi, (m, name: string) => ENTITIES[name.toLowerCase()] ?? m);
}

/**
 * Section HTML → plain paragraphs. Drops the heading, tables (review-score
 * boxes), reference superscripts, styles/scripts, edit links and hidden
 * hatnotes; keeps paragraph breaks; decodes entities; collapses whitespace.
 */
export function wikiHtmlToText(html: string): string {
  let s = html;
  s = s.replace(/<(style|script|table|figure)\b[\s\S]*?<\/\1>/gi, ' ');
  s = s.replace(/<div class="mw-heading[^"]*">[\s\S]*?<\/div>/gi, ' ');
  s = s.replace(/<h[1-6]\b[^>]*>[\s\S]*?<\/h[1-6]>/gi, ' ');
  s = s.replace(/<sup\b[^>]*class="[^"]*reference[^"]*"[^>]*>[\s\S]*?<\/sup>/gi, '');
  s = s.replace(/<span\b[^>]*class="[^"]*mw-editsection[^"]*"[^>]*>[\s\S]*?<\/span>/gi, '');
  s = s.replace(/<div\b[^>]*class="[^"]*(hatnote|navbox|reflist|mw-references-wrap|thumb|noprint)[^"]*"[^>]*>[\s\S]*?<\/div>/gi, ' ');
  s = s.replace(/<(?:br|hr)\s*\/?>/gi, ' ');
  s = s.replace(/<\/(p|li|blockquote|dd|dt)>/gi, '\n\n');
  s = s.replace(/<[^>]+>/g, '');
  s = decodeEntities(s);
  s = s.replace(/\[\d+\]/g, '');
  return s
    .split(/\n{2,}/)
    .map((p) => p.replace(/\s+/g, ' ').trim())
    .filter((p) => p.length > 0)
    .join('\n\n');
}

export class WikipediaClient {
  id = 'wikipedia';
  private userAgent: string;
  private fetchImpl: typeof fetch;
  private lang: string;

  constructor(options: { userAgent: string; fetchImpl?: typeof fetch; lang?: string }) {
    this.userAgent = options.userAgent;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.lang = options.lang ?? 'en';
  }

  private async call(params: Record<string, string>, action: string = 'parse'): Promise<unknown> {
    const url = new URL(`https://${this.lang}.wikipedia.org/w/api.php`);
    url.searchParams.set('action', action);
    url.searchParams.set('format', 'json');
    url.searchParams.set('formatversion', '2');
    url.searchParams.set('maxlag', '5');
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    const response = await this.fetchImpl(url.toString(), {
      headers: { 'User-Agent': this.userAgent, Accept: 'application/json' },
    });
    if (response.status === 429 || response.status === 503) {
      const retryAfter = response.headers.get('Retry-After');
      const err = new Error(`Wikipedia rate limited (${response.status})`);
      if (retryAfter) (err as { retryAfterMs?: number }).retryAfterMs = parseInt(retryAfter, 10) * 1000;
      throw err;
    }
    if (!response.ok) throw new Error(`Wikipedia request failed: ${response.status} ${response.statusText}`);
    return response.json();
  }

  /** null when the article is missing or has no reception section. */
  async getReceptionSection(title: string): Promise<ReceptionSection | null> {
    const sections = SectionsSchema.parse(await this.call({ page: title, prop: 'sections' }));
    if (!sections.parse) return null;
    const hit = findReceptionSection(sections.parse.sections.map((s) => ({
      index: s.index, line: s.line, toclevel: s.toclevel ?? undefined, anchor: s.anchor ?? undefined,
    })));
    if (!hit) return null;

    const body = TextSchema.parse(await this.call({
      page: title, prop: 'text', section: String(hit.index), disableeditsection: '1',
    }));
    if (!body.parse) return null;
    const text = wikiHtmlToText(body.parse.text);
    if (!text) return null;

    const anchor = (sections.parse.sections.find((s) => s.index === String(hit.index))?.anchor ?? hit.line).replace(/ /g, '_');
    return {
      url: `https://${this.lang}.wikipedia.org/wiki/${encodeURIComponent(sections.parse.title.replace(/ /g, '_'))}#${anchor}`,
      sectionTitle: hit.line,
      text,
    };
  }

  /** null when the article is missing or the extract is empty. */
  async getIntroExtract(title: string): Promise<IntroExtract | null> {
    const response = ExtractsSchema.parse(
      await this.call({
        titles: title,
        prop: 'extracts',
        exintro: '1',
        explaintext: '1',
        redirects: '1',
      }, 'query'),
    );

    if (!response.query?.pages) return null;

    const pages = Object.values(response.query.pages);
    if (pages.length === 0) return null;

    const page = pages[0];
    if (!page || !page.extract) return null;

    const normalizedTitle = page.title;
    const urlTitle = normalizedTitle.replace(/ /g, '_');

    return {
      title: normalizedTitle,
      extract: page.extract,
      url: `https://${this.lang}.wikipedia.org/wiki/${encodeURIComponent(urlTitle)}`,
    };
  }
}
