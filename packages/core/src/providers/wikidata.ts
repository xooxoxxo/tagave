/**
 * Wikidata client for music metadata.
 * Implements spec §10.2.3.
 */
import { z } from 'zod';

const WIKIDATA_SPARQL_URL = 'https://query.wikidata.org/sparql';

/**
 * Parse Wikidata SPARQL bindings response.
 */
export function parseWikidataBindings(
  json: unknown
): Array<{ item?: string; master?: number; enwiki?: string }> {
  const schema = z.object({
    results: z.object({
      bindings: z.array(z.object({
        item: z.object({ value: z.string() }).optional(),
        master: z.object({ value: z.string() }).optional(),
        enwiki: z.object({ value: z.string() }).optional(),
      })).optional(),
    }).optional(),
  });

  const data = schema.parse(json);
  const bindings = data.results?.bindings || [];

  return bindings.map(b => {
    const result: { item?: string; master?: number; enwiki?: string } = {};

    if (b?.item?.value) {
      // Extract Q ID from http://www.wikidata.org/entity/Q918304
      const match = b.item.value.match(/Q\d+/);
      if (match) result.item = match[0];
    }

    if (b?.master?.value) {
      const masterId = parseInt(b.master.value, 10);
      if (!isNaN(masterId)) result.master = masterId;
    }

    if (b?.enwiki?.value) {
      // Extract title from https://en.wikipedia.org/wiki/Whenever_You_Need_Somebody
      const match = b.enwiki.value.match(/wiki\/(.+)$/);
      if (match) result.enwiki = decodeURIComponent(match[1]!);
    }

    return result;
  });
}

/**
 * Wikidata client for music metadata lookups.
 */
export class WikidataClient {
  private fetchImpl: typeof fetch;

  constructor(options: {
    userAgent: string;
    fetchImpl?: typeof fetch;
  }) {
    this.userAgent = options.userAgent;
    this.fetchImpl = options.fetchImpl || fetch;
  }

  private userAgent: string;

  /**
   * Find Wikidata item for a MusicBrainz release group.
   * Returns the Wikidata QID, optional Discogs master ID, and optional Wikipedia title.
   */
  async findByMbReleaseGroup(rgMbid: string): Promise<
    { qid: string; discogsMasterId?: number; enwikiTitle?: string } | null
  > {
    // SPARQL query to find Wikidata item by MB release group ID
    const sparqlQuery = `
      SELECT ?item ?master ?enwiki WHERE {
        ?item wdt:P436 "${rgMbid}" .
        OPTIONAL { ?item wdt:P1954 ?master }
        OPTIONAL { ?enwiki schema:about ?item ; schema:isPartOf <https://en.wikipedia.org/> }
      }
      LIMIT 5
    `;

    const url = new URL(WIKIDATA_SPARQL_URL);
    url.searchParams.set('format', 'json');
    url.searchParams.set('query', sparqlQuery);

    try {
      const response = await this.fetchImpl(url.toString(), {
        headers: {
          'User-Agent': this.userAgent,
          Accept: 'application/sparql-results+json',
        },
      });

      if (!response.ok) {
        return null;
      }

      const data = await response.json();
      const bindings = parseWikidataBindings(data);

      if (bindings.length === 0) {
        return null;
      }

      // Take the first result
      const result = bindings[0];
      if (!result?.item) return null;

      return {
        qid: result.item,
        ...(result.master ? { discogsMasterId: result.master } : {}),
        ...(result.enwiki ? { enwikiTitle: result.enwiki } : {}),
      };
    } catch {
      return null;
    }
  }
}
