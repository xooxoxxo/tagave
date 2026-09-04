/**
 * Wikidata client tests.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { WikidataClient, parseWikidataBindings } from './wikidata.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function loadFixture(name: string) {
  const path = join(__dirname, '__fixtures__', name);
  return JSON.parse(readFileSync(path, 'utf-8'));
}

describe('parseWikidataBindings', () => {
  it('should parse Wikidata SPARQL response', () => {
    const fixture = loadFixture('wikidata_p436.json');
    const result = parseWikidataBindings(fixture);

    expect(result.length).toBeGreaterThan(0);
    const binding = result[0];
    expect(binding?.item).toBeDefined();
    expect(binding?.item?.startsWith('Q')).toBe(true);
  });

  it('should extract QID from entity URL', () => {
    const response = {
      results: {
        bindings: [
          {
            item: { value: 'http://www.wikidata.org/entity/Q918304' },
            master: { value: '96568' },
            enwiki: { value: 'https://en.wikipedia.org/wiki/Whenever_You_Need_Somebody' },
          },
        ],
      },
    };

    const result = parseWikidataBindings(response);

    expect(result).toHaveLength(1);
    expect(result[0]?.item).toBe('Q918304');
    expect(result[0]?.master).toBe(96568);
    expect(result[0]?.enwiki).toBe('Whenever_You_Need_Somebody');
  });

  it('should decode URL-encoded Wikipedia titles', () => {
    const response = {
      results: {
        bindings: [
          {
            enwiki: { value: 'https://en.wikipedia.org/wiki/Album_(Song)' },
          },
        ],
      },
    };

    const result = parseWikidataBindings(response);

    expect(result[0]?.enwiki).toBe('Album_(Song)');
  });

  it('should handle missing optional fields', () => {
    const response = {
      results: {
        bindings: [
          {
            item: { value: 'http://www.wikidata.org/entity/Q123456' },
          },
        ],
      },
    };

    const result = parseWikidataBindings(response);

    expect(result[0]?.item).toBe('Q123456');
    expect(result[0]?.master).toBeUndefined();
    expect(result[0]?.enwiki).toBeUndefined();
  });

  it('should return empty array for empty results', () => {
    const response = {
      results: {
        bindings: [],
      },
    };

    expect(parseWikidataBindings(response)).toEqual([]);
  });
});

describe('WikidataClient', () => {
  it('should find release group by MB ID', async () => {
    const mockFetch = async (url: string) => {
      const fixture = loadFixture('wikidata_p436.json');
      return new Response(JSON.stringify(fixture), { status: 200 });
    };

    const client = new WikidataClient({
      userAgent: 'test',
      fetchImpl: mockFetch as any,
    });

    const result = await client.findByMbReleaseGroup('e3dd75d0-8e6b-3d8e-b2a0-8c2d5d5e5f5f');

    expect(result).not.toBeNull();
    expect(result?.qid).toBeDefined();
  });

  it('should return null on 404', async () => {
    const mockFetch = async (url: string) => {
      return new Response(JSON.stringify({ error: 'not found' }), { status: 404 });
    };

    const client = new WikidataClient({
      userAgent: 'test',
      fetchImpl: mockFetch as any,
    });

    const result = await client.findByMbReleaseGroup('invalid-id');

    expect(result).toBeNull();
  });

  it('should return null on error', async () => {
    const mockFetch = async (url: string) => {
      throw new Error('Network error');
    };

    const client = new WikidataClient({
      userAgent: 'test',
      fetchImpl: mockFetch as any,
    });

    const result = await client.findByMbReleaseGroup('test-id');

    expect(result).toBeNull();
  });

  it('should include Accept header', async () => {
    let capturedHeaders: Record<string, string> = {};

    const mockFetch = async (url: string, options: any) => {
      capturedHeaders = options.headers;
      return new Response(JSON.stringify({ results: { bindings: [] } }), { status: 200 });
    };

    const client = new WikidataClient({
      userAgent: 'test',
      fetchImpl: mockFetch as any,
    });

    await client.findByMbReleaseGroup('test-id');

    expect(capturedHeaders['Accept']).toBe('application/sparql-results+json');
  });
});
