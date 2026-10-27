/**
 * Finding an album's and an artist's links (phase 1 sources, in order; the
 * first hit per platform wins):
 *
 *   album   1. MusicBrainz url relationships of the release group's
 *              releases (one browse call, up to 100 releases)
 *           2. Wikidata album ids, found by the release group's MBID (P436)
 *           3. Apple's keyless barcode lookup, from the releases' barcodes
 *              (Apple Music only; at most two barcodes per album)
 *   artist  1. MusicBrainz url relationships of the artist
 *           2. Wikidata artist ids (P434)
 *
 * What leaves the server: MBIDs and barcodes, with the install's
 * User-Agent (its contact). Nothing about the person, their library or what
 * they own. Every call goes through `pace` (the worker's shared provider
 * pacer: MusicBrainz 1 req/s with identification, Apple 15 a minute).
 * MusicBrainz failing fails the lookup (the job retries); Wikidata or Apple
 * failing leaves their links out and marks the result incomplete.
 */
import { z } from 'zod';
import type { ListenLinkSource, ListenPlatform } from '@tagave/shared';
import { WIKIDATA_ALBUM_PROPS, WIKIDATA_ARTIST_PROPS, appleAlbumUrl, linksFromRelations, type PlatformUrl } from './urls.js';

export type ListenProvider = 'musicbrainz' | 'wikidata' | 'itunes';

export interface ResolverDeps {
  userAgent: string;
  fetchImpl?: typeof fetch;
  /** run one HTTP call in the provider's rate limit */
  pace?: <T>(provider: ListenProvider, fn: () => Promise<T>) => Promise<T>;
}

export interface FoundLink extends PlatformUrl {
  source: ListenLinkSource;
}

/** What one lookup found; `incomplete` when an optional source (Wikidata, Apple) did not answer, so it is asked again soon. */
export interface ResolveResult {
  links: FoundLink[];
  incomplete: boolean;
}

const MB = 'https://musicbrainz.org/ws/2';
const WDQS = 'https://query.wikidata.org/sparql';
const ITUNES = 'https://itunes.apple.com/lookup';
const MBID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Apple's lookups per album: the first barcodes of the releases that look like the album */
const MAX_BARCODES = 2;

const Relation = z.object({ type: z.string().nullish(), 'target-type': z.string().nullish(), url: z.object({ resource: z.string() }).nullish() });
const ReleaseBrowse = z.object({
  releases: z.array(z.object({
    id: z.string(),
    title: z.string().nullish(),
    status: z.string().nullish(),
    date: z.string().nullish(),
    barcode: z.string().nullish(),
    relations: z.array(Relation).nullish(),
  })).default([]),
});
const ArtistLookup = z.object({ relations: z.array(Relation).nullish() });
const Sparql = z.object({ results: z.object({ bindings: z.array(z.record(z.string(), z.object({ value: z.string() }))) }) });
const ItunesLookup = z.object({ results: z.array(z.object({ wrapperType: z.string().nullish(), collectionViewUrl: z.string().nullish() })).default([]) });

const urlRels = (rels: z.infer<typeof Relation>[] | null | undefined) =>
  (rels ?? []).flatMap((r) => (r['target-type'] === 'url' && r.url?.resource ? [{ type: r.type ?? '', url: r.url.resource }] : []));

const norm = (s: string | null | undefined) => (s ?? '').normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();

export class ListenLinkResolver {
  private readonly fetchImpl: typeof fetch;
  private readonly pace: NonNullable<ResolverDeps['pace']>;

  constructor(private readonly deps: ResolverDeps) {
    this.fetchImpl = deps.fetchImpl ?? fetch;
    this.pace = deps.pace ?? ((_p, fn) => fn());
  }

  private async getJson(provider: ListenProvider, url: string, accept = 'application/json'): Promise<unknown> {
    return this.pace(provider, async () => {
      // no cookies, no credentials, nothing but the install's User-Agent
      const res = await this.fetchImpl(url, { headers: { 'User-Agent': this.deps.userAgent, Accept: accept }, credentials: 'omit', redirect: 'follow' });
      if (res.status === 503 || res.status === 429) throw new Error(`${provider} rate limited (${res.status})`);
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`${provider} HTTP ${res.status}`);
      return res.json();
    });
  }

  /**
   * An album's links on the wanted platforms. The release whose title is the
   * album's comes first (a deluxe or anniversary edition is another
   * album on most platforms), then the oldest official one.
   */
  async album(rg: { mbid: string; title: string }, platforms: readonly ListenPlatform[]): Promise<ResolveResult> {
    if (!MBID_RE.test(rg.mbid) || platforms.length === 0) return { links: [], incomplete: false };
    let incomplete = false;
    const want = new Set(platforms);
    const found = new Map<ListenPlatform, FoundLink>();
    const add = (links: PlatformUrl[], source: ListenLinkSource) => {
      for (const l of links) if (want.has(l.platform) && !found.has(l.platform)) found.set(l.platform, { ...l, source });
    };

    // 1. MusicBrainz: the release group's releases with their url relationships
    const raw = await this.getJson('musicbrainz', `${MB}/release?release-group=${rg.mbid}&inc=url-rels&fmt=json&limit=100`);
    const releases = raw ? ReleaseBrowse.parse(raw).releases : [];
    const title = norm(rg.title);
    const ranked = [...releases].sort((a, b) =>
      Number(norm(b.title) === title) - Number(norm(a.title) === title)
      || Number(b.status === 'Official') - Number(a.status === 'Official')
      || (a.date || '9999').localeCompare(b.date || '9999'));
    for (const r of ranked) add(linksFromRelations(urlRels(r.relations), 'album'), 'mb-release');

    // 2. Wikidata, for what MusicBrainz did not have
    if ([...want].some((p) => !found.has(p) && WIKIDATA_ALBUM_PROPS.some((w) => w.platform === p))) {
      try {
        const byMbid = await this.wikidata('P436', [rg.mbid], WIKIDATA_ALBUM_PROPS);
        add(byMbid.get(rg.mbid) ?? [], 'wikidata');
      } catch {
        incomplete = true;
      }
    }

    // 3. Apple's barcode lookup
    if (want.has('apple') && !found.has('apple')) {
      const barcodes = [...new Set(ranked.map((r) => (r.barcode ?? '').trim()).filter((b) => /^\d{8,14}$/.test(b)))].slice(0, MAX_BARCODES);
      try {
        for (const upc of barcodes) {
          const url = await this.itunesUpc(upc);
          if (url) {
            add([{ platform: 'apple', url }], 'itunes-upc');
            break;
          }
        }
      } catch {
        incomplete = true;
      }
    }
    return { links: [...found.values()], incomplete };
  }

  /** An artist's pages on the wanted platforms. */
  async artist(mbid: string, platforms: readonly ListenPlatform[]): Promise<ResolveResult> {
    if (!MBID_RE.test(mbid) || platforms.length === 0) return { links: [], incomplete: false };
    let incomplete = false;
    const want = new Set(platforms);
    const found = new Map<ListenPlatform, FoundLink>();
    const add = (links: PlatformUrl[], source: ListenLinkSource) => {
      for (const l of links) if (want.has(l.platform) && !found.has(l.platform)) found.set(l.platform, { ...l, source });
    };
    const raw = await this.getJson('musicbrainz', `${MB}/artist/${mbid}?inc=url-rels&fmt=json`);
    if (raw) add(linksFromRelations(urlRels(ArtistLookup.parse(raw).relations), 'artist'), 'mb-artist');
    if ([...want].some((p) => !found.has(p) && WIKIDATA_ARTIST_PROPS.some((w) => w.platform === p))) {
      try {
        const byMbid = await this.wikidata('P434', [mbid], WIKIDATA_ARTIST_PROPS);
        add(byMbid.get(mbid) ?? [], 'wikidata');
      } catch {
        incomplete = true;
      }
    }
    return { links: [...found.values()], incomplete };
  }

  /** One SPARQL call: the platform ids of the items carrying these MBIDs. */
  async wikidata(mbidProp: 'P436' | 'P434', mbids: readonly string[], props: typeof WIKIDATA_ALBUM_PROPS): Promise<Map<string, PlatformUrl[]>> {
    const ids = mbids.filter((m) => MBID_RE.test(m));
    const out = new Map<string, PlatformUrl[]>();
    if (ids.length === 0) return out;
    const vars = props.map((p) => `?${p.prop}`).join(' ');
    const optionals = props.map((p) => `OPTIONAL { ?item wdt:${p.prop} ?${p.prop} }`).join('\n  ');
    const query = `SELECT ?mbid ${vars} WHERE {\n  VALUES ?mbid { ${ids.map((m) => `"${m}"`).join(' ')} }\n  ?item wdt:${mbidProp} ?mbid .\n  ${optionals}\n}`;
    const raw = await this.getJson('wikidata', `${WDQS}?format=json&query=${encodeURIComponent(query)}`, 'application/sparql-results+json');
    if (!raw) return out;
    for (const b of Sparql.parse(raw).results.bindings) {
      const mbid = b['mbid']?.value;
      if (!mbid) continue;
      const list = out.get(mbid) ?? [];
      for (const p of props) {
        const v = b[p.prop]?.value;
        const url = v ? p.url(v) : null;
        if (url && !list.some((l) => l.platform === p.platform)) list.push({ platform: p.platform, url });
      }
      out.set(mbid, list);
    }
    return out;
  }

  /** Apple's album page for a barcode, or null. */
  async itunesUpc(upc: string): Promise<string | null> {
    if (!/^\d{8,14}$/.test(upc)) return null;
    const raw = await this.getJson('itunes', `${ITUNES}?upc=${upc}&entity=album`);
    if (!raw) return null;
    const hit = ItunesLookup.parse(raw).results.find((r) => r.wrapperType === 'collection' && r.collectionViewUrl);
    return hit?.collectionViewUrl ? appleAlbumUrl(hit.collectionViewUrl) : null;
  }
}
