/**
 * Wikidata client for music metadata (spec §10.2.3, ENR-7, REV-2).
 * One SPARQL round trip per release group answers the whole identity
 * question: QID, Discogs master (P1954), English Wikipedia article, and the
 * review-site identifiers Liner links out to (Metacritic P1712, AllMusic
 * P1729, Rate Your Music P8392). Wikidata is CC0.
 */
import { z } from 'zod';

const WIKIDATA_SPARQL_URL = 'https://query.wikidata.org/sparql';

export interface WikidataBinding {
  item?: string;
  master?: number;
  enwiki?: string;
  metacritic?: string;
  allmusic?: string;
  rym?: string;
}

export interface ReleaseGroupIdentity {
  qid: string;
  discogsMasterId?: number;
  enwikiTitle?: string;
  metacriticId?: string;
  allmusicId?: string;
  rymId?: string;
}

const Literal = z.object({ value: z.string() }).optional();

/**
 * Parse Wikidata SPARQL bindings response.
 */
export function parseWikidataBindings(json: unknown): WikidataBinding[] {
  const schema = z.object({
    results: z.object({
      bindings: z.array(z.object({
        item: Literal,
        master: Literal,
        enwiki: Literal,
        metacritic: Literal,
        allmusic: Literal,
        rym: Literal,
      })).optional(),
    }).optional(),
  });

  const data = schema.parse(json);
  const bindings = data.results?.bindings || [];

  return bindings.map((b) => {
    const result: WikidataBinding = {};

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

    if (b?.metacritic?.value) result.metacritic = b.metacritic.value;
    if (b?.allmusic?.value) result.allmusic = b.allmusic.value;
    if (b?.rym?.value) result.rym = b.rym.value;

    return result;
  });
}

/**
 * Several items can claim the same P436 (an album and its reissues). The
 * album is the one with a Wikipedia article and, among those, the oldest
 * item (lowest Q number) — reissues are created later.
 */
export function pickIdentityBinding(bindings: WikidataBinding[]): WikidataBinding | null {
  const withItem = bindings.filter((b): b is WikidataBinding & { item: string } => !!b.item);
  if (withItem.length === 0) return null;
  const qnum = (b: { item: string }) => parseInt(b.item.slice(1), 10);
  const pool = withItem.some((b) => b.enwiki) ? withItem.filter((b) => b.enwiki) : withItem;
  pool.sort((a, b) => qnum(a) - qnum(b));
  return pool[0] ?? null;
}

/**
 * Wikidata client for music metadata lookups.
 */
export class WikidataClient {
  private fetchImpl: typeof fetch;
  private userAgent: string;

  constructor(options: {
    userAgent: string;
    fetchImpl?: typeof fetch;
  }) {
    this.userAgent = options.userAgent;
    this.fetchImpl = options.fetchImpl || fetch;
  }

  /**
   * Full identity for a MusicBrainz release group: QID, Discogs master,
   * enwiki title and review-site identifiers. null when Wikidata has no item.
   */
  async findReleaseGroupIdentity(rgMbid: string): Promise<ReleaseGroupIdentity | null> {
    const sparqlQuery = `
      SELECT ?item ?master ?enwiki ?metacritic ?allmusic ?rym WHERE {
        ?item wdt:P436 "${rgMbid.replace(/"/g, '')}" .
        OPTIONAL { ?item wdt:P1954 ?master }
        OPTIONAL { ?item wdt:P1712 ?metacritic }
        OPTIONAL { ?item wdt:P1729 ?allmusic }
        OPTIONAL { ?item wdt:P8392 ?rym }
        OPTIONAL { ?enwiki schema:about ?item ; schema:isPartOf <https://en.wikipedia.org/> }
      }
      LIMIT 10
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

      if (response.status === 429 || response.status === 503) {
        throw new Error(`Wikidata rate limited (${response.status})`);
      }
      if (!response.ok) {
        return null;
      }

      const bindings = parseWikidataBindings(await response.json());
      const best = pickIdentityBinding(bindings);
      if (!best?.item) return null;

      return {
        qid: best.item,
        ...(best.master ? { discogsMasterId: best.master } : {}),
        ...(best.enwiki ? { enwikiTitle: best.enwiki } : {}),
        ...(best.metacritic ? { metacriticId: best.metacritic } : {}),
        ...(best.allmusic ? { allmusicId: best.allmusic } : {}),
        ...(best.rym ? { rymId: best.rym } : {}),
      };
    } catch (err) {
      if (err instanceof Error && /rate limited/.test(err.message)) throw err;
      return null;
    }
  }

  /**
   * Find Wikidata item for a MusicBrainz release group.
   * Returns the Wikidata QID, optional Discogs master ID, and optional Wikipedia title.
   */
  async findByMbReleaseGroup(rgMbid: string): Promise<
    { qid: string; discogsMasterId?: number; enwikiTitle?: string } | null
  > {
    const identity = await this.findReleaseGroupIdentity(rgMbid);
    if (!identity) return null;
    return {
      qid: identity.qid,
      ...(identity.discogsMasterId ? { discogsMasterId: identity.discogsMasterId } : {}),
      ...(identity.enwikiTitle ? { enwikiTitle: identity.enwikiTitle } : {}),
    };
  }
}
