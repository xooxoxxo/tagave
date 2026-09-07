/**
 * Wikipedia reception-section client tests (spec REV-1, ENR-7). Fixtures are
 * live Action API responses for OK_Computer captured 2026-09-06.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { WikipediaClient, findReceptionSection, wikiHtmlToText } from './wikipedia.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const loadFixture = (name: string) => JSON.parse(readFileSync(join(__dirname, '__fixtures__', name), 'utf-8'));

describe('findReceptionSection', () => {
  it('finds "Critical reception" in the live section list', () => {
    const sections = loadFixture('wikipedia_sections_okcomputer.json').parse.sections;
    expect(findReceptionSection(sections)).toEqual({ index: 17, line: 'Critical reception' });
  });

  it('prefers a top-level reception heading and accepts plain "Reception"', () => {
    expect(findReceptionSection([
      { index: '3', line: 'Reception', toclevel: 2 },
      { index: '5', line: 'Critical reception', toclevel: 1 },
    ])).toEqual({ index: 5, line: 'Critical reception' });
    expect(findReceptionSection([{ index: '2', line: 'Reception', toclevel: 1 }])).toEqual({ index: 2, line: 'Reception' });
    expect(findReceptionSection([{ index: '2', line: 'Reception and legacy', toclevel: 1 }])).toEqual({ index: 2, line: 'Reception and legacy' });
  });

  it('returns null when there is no reception section', () => {
    expect(findReceptionSection([{ index: '1', line: 'Track listing', toclevel: 1 }])).toBeNull();
    expect(findReceptionSection([])).toBeNull();
  });
});

describe('wikiHtmlToText', () => {
  it('turns the live section HTML into attributed plain text', () => {
    const html = loadFixture('wikipedia_section_text_okcomputer.json').parse.text as string;
    const text = wikiHtmlToText(html);
    expect(text.length).toBeGreaterThan(1000);
    expect(text).toContain('OK Computer');
    expect(text).not.toContain('<');
    expect(text).not.toContain('Review scores'); // the ratings table is dropped
    expect(text).not.toMatch(/\[\d+\]/); // reference markers are dropped
    expect(text).not.toMatch(/^Critical reception/); // the heading itself is dropped
    expect(text.split('\n\n').length).toBeGreaterThan(2); // paragraphs preserved
    expect(text).not.toMatch(/&\w+;/); // entities decoded
  });

  it('decodes entities and collapses whitespace', () => {
    expect(wikiHtmlToText('<p>Rock &amp; roll&nbsp;<sup class="reference">[1]</sup>  is<br/> loud.</p>\n<p>Second.</p>'))
      .toBe('Rock & roll is loud.\n\nSecond.');
  });
});

describe('WikipediaClient', () => {
  const sectionsFixture = loadFixture('wikipedia_sections_okcomputer.json');
  const textFixture = loadFixture('wikipedia_section_text_okcomputer.json');

  it('fetches the section list, then the reception section text', async () => {
    const urls: string[] = [];
    const fetchImpl = (async (url: string, init: { headers: Record<string, string> }) => {
      urls.push(url);
      expect(init.headers['User-Agent']).toBe('Liner/test (+test)');
      if (url.includes('prop=sections')) return new Response(JSON.stringify(sectionsFixture), { status: 200 });
      if (url.includes('section=17')) return new Response(JSON.stringify(textFixture), { status: 200 });
      return new Response('{}', { status: 500 });
    }) as unknown as typeof fetch;
    const client = new WikipediaClient({ userAgent: 'Liner/test (+test)', fetchImpl });

    const out = await client.getReceptionSection('OK_Computer');

    expect(urls).toHaveLength(2);
    expect(urls[0]).toContain('https://en.wikipedia.org/w/api.php?');
    expect(urls[0]).toContain('page=OK_Computer');
    expect(urls[0]).toContain('formatversion=2');
    expect(out?.sectionTitle).toBe('Critical reception');
    expect(out?.url).toBe('https://en.wikipedia.org/wiki/OK_Computer#Critical_reception');
    expect(out?.text.length).toBeGreaterThan(1000);
  });

  it('returns null for a missing page or a page without a reception section', async () => {
    const missing = new WikipediaClient({
      userAgent: 't',
      fetchImpl: (async () => new Response(JSON.stringify({ error: { code: 'missingtitle' } }), { status: 200 })) as unknown as typeof fetch,
    });
    expect(await missing.getReceptionSection('Nope')).toBeNull();

    const noSection = new WikipediaClient({
      userAgent: 't',
      fetchImpl: (async () => new Response(JSON.stringify({ parse: { title: 'X', pageid: 1, sections: [{ index: '1', line: 'Track listing', toclevel: 1 }] } }), { status: 200 })) as unknown as typeof fetch,
    });
    expect(await noSection.getReceptionSection('X')).toBeNull();
  });

  it('throws a rate-limit error on 429 so the pacer backs off', async () => {
    const limited = new WikipediaClient({
      userAgent: 't',
      fetchImpl: (async () => new Response('', { status: 429, headers: { 'Retry-After': '30' } })) as unknown as typeof fetch,
    });
    await expect(limited.getReceptionSection('X')).rejects.toThrow(/429/);
  });

  describe('getIntroExtract', () => {
    it('fetches intro extract with action=query', async () => {
      const extractFixture = loadFixture('wikipedia_extracts_artist.json');
      let capturedUrl = '';
      const fetchImpl = (async (url: string) => {
        capturedUrl = url;
        return new Response(JSON.stringify(extractFixture), { status: 200 });
      }) as unknown as typeof fetch;
      const client = new WikipediaClient({ userAgent: 'test', fetchImpl });

      const result = await client.getIntroExtract('Miles Davis');

      expect(capturedUrl).toContain('action=query');
      expect(capturedUrl).toContain('prop=extracts');
      expect(capturedUrl).toContain('exintro=1');
      expect(capturedUrl).toContain('explaintext=1');
      expect(capturedUrl).toContain('redirects=1');
      expect(result).toEqual({
        title: 'Miles Davis',
        extract: expect.stringContaining('Miles Dewey Davis III'),
        url: 'https://en.wikipedia.org/wiki/Miles_Davis',
      });
    });

    it('reads the formatversion=2 array shape the client actually requests', async () => {
      // Live shape (2026-09-07): query.pages is an array, not an id-keyed map.
      const fixture = {
        batchcomplete: true,
        query: {
          redirects: [{ from: 'Elton john', to: 'Elton John' }],
          pages: [{ pageid: 12140, ns: 0, title: 'Elton John', extract: 'Sir Elton Hercules John is an English singer.' }],
        },
      };
      const fetchImpl = (async () => new Response(JSON.stringify(fixture), { status: 200 })) as unknown as typeof fetch;
      const client = new WikipediaClient({ userAgent: 'test', fetchImpl });

      const result = await client.getIntroExtract('Elton john');

      expect(result).toEqual({
        title: 'Elton John',
        extract: 'Sir Elton Hercules John is an English singer.',
        url: 'https://en.wikipedia.org/wiki/Elton_John',
      });
    });

    it('returns null for a missing page in the array shape', async () => {
      const fixture = { batchcomplete: true, query: { pages: [{ ns: 0, title: 'Nope', missing: true }] } };
      const fetchImpl = (async () => new Response(JSON.stringify(fixture), { status: 200 })) as unknown as typeof fetch;
      const client = new WikipediaClient({ userAgent: 'test', fetchImpl });

      expect(await client.getIntroExtract('Nope')).toBeNull();
    });

    it('normalizes page title in URL (spaces → underscores)', async () => {
      const fixture = {
        query: {
          pages: {
            '999': {
              title: 'The Beatles',
              extract: 'The Beatles were an English rock band.',
            },
          },
        },
      };
      const fetchImpl = (async () => new Response(JSON.stringify(fixture), { status: 200 })) as unknown as typeof fetch;
      const client = new WikipediaClient({ userAgent: 'test', fetchImpl });

      const result = await client.getIntroExtract('The Beatles');

      expect(result?.url).toBe('https://en.wikipedia.org/wiki/The_Beatles');
    });

    it('returns null when the page is missing', async () => {
      const fixture = { error: { code: 'missingtitle' } };
      const fetchImpl = (async () => new Response(JSON.stringify(fixture), { status: 200 })) as unknown as typeof fetch;
      const client = new WikipediaClient({ userAgent: 'test', fetchImpl });

      const result = await client.getIntroExtract('Nonexistent Page');

      expect(result).toBeNull();
    });

    it('returns null when the extract is empty', async () => {
      const fixture = {
        query: {
          pages: {
            '123': {
              title: 'Stub Article',
              extract: '',
            },
          },
        },
      };
      const fetchImpl = (async () => new Response(JSON.stringify(fixture), { status: 200 })) as unknown as typeof fetch;
      const client = new WikipediaClient({ userAgent: 'test', fetchImpl });

      const result = await client.getIntroExtract('Stub Article');

      expect(result).toBeNull();
    });

    it('handles redirect normalization (returned title is normalized)', async () => {
      const fixture = {
        query: {
          pages: {
            '456': {
              title: 'Bob Dylan',
              extract: 'Robert Allen Zimmerman, known professionally as Bob Dylan...',
            },
          },
        },
      };
      const fetchImpl = (async () => new Response(JSON.stringify(fixture), { status: 200 })) as unknown as typeof fetch;
      const client = new WikipediaClient({ userAgent: 'test', fetchImpl });

      const result = await client.getIntroExtract('Robert Dylan');

      expect(result).toEqual({
        title: 'Bob Dylan',
        extract: expect.stringContaining('Robert Allen Zimmerman'),
        url: 'https://en.wikipedia.org/wiki/Bob_Dylan',
      });
    });

    it('throws on rate limit (429)', async () => {
      const fetchImpl = (async () => new Response('', { status: 429, headers: { 'Retry-After': '60' } })) as unknown as typeof fetch;
      const client = new WikipediaClient({ userAgent: 'test', fetchImpl });

      await expect(client.getIntroExtract('Title')).rejects.toThrow(/rate limited/);
    });
  });
});
