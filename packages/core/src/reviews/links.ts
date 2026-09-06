/**
 * Review link-out resolver (spec REV-2, §10.4). Publications offer no API and
 * forbid scraping, so Liner only ever stores URLs: direct ones from Wikidata
 * identifiers (Metacritic P1712, AllMusic P1729, Rate Your Music P8392) and
 * MusicBrainz `review` / `allmusic` URL relationships, and site-search URLs
 * for everything else. Pure — nothing here touches the network.
 */

export interface LinkIdentity {
  metacriticId?: string | undefined;
  allmusicId?: string | undefined;
  rymId?: string | undefined;
  enwikiTitle?: string | undefined;
}

export interface LinkInputs {
  title: string;
  artist: string;
  identity?: LinkIdentity | null | undefined;
  mbUrlRelations?: Array<{ type: string; url: string }> | undefined;
}

export interface ResolvedLink {
  source: string;
  url: string;
  discoveredVia: 'wikidata' | 'mb_relationship' | 'template';
}

/** `{q}` is replaced with the URL-encoded "artist title" query. Owner-configurable later (REV-2). */
export const SEARCH_TEMPLATES: Record<string, string> = {
  metacritic: 'https://www.metacritic.com/search/{q}/?category=2',
  allmusic: 'https://www.allmusic.com/search/albums/{q}',
  rateyourmusic: 'https://rateyourmusic.com/search?searchterm={q}&searchtype=l',
  pitchfork: 'https://pitchfork.com/search/?query={q}',
  albumoftheyear: 'https://www.albumoftheyear.org/search/?q={q}',
  sputnikmusic: 'https://www.sputnikmusic.com/search_results.php?search_in=Albums&search_text={q}',
  residentadvisor: 'https://ra.co/search?searchQuery={q}',
  thequietus: 'https://thequietus.com/?s={q}',
  rollingstone: 'https://www.rollingstone.com/results/#?q={q}',
  bandcamp: 'https://bandcamp.com/search?q={q}&item_type=a',
};

const HOST_SOURCES: Array<[RegExp, string]> = [
  [/(^|\.)pitchfork\.com$/, 'pitchfork'],
  [/(^|\.)allmusic\.com$/, 'allmusic'],
  [/(^|\.)metacritic\.com$/, 'metacritic'],
  [/(^|\.)rateyourmusic\.com$/, 'rateyourmusic'],
  [/(^|\.)albumoftheyear\.org$/, 'albumoftheyear'],
  [/(^|\.)sputnikmusic\.com$/, 'sputnikmusic'],
  [/(^|\.)(ra\.co|residentadvisor\.net)$/, 'residentadvisor'],
  [/(^|\.)thequietus\.com$/, 'thequietus'],
  [/(^|\.)rollingstone\.com$/, 'rollingstone'],
  [/(^|\.)bandcamp\.com$/, 'bandcamp'],
  [/(^|\.)bbc\.(co\.uk|com)$/, 'bbc'],
  [/(^|\.)theguardian\.com$/, 'guardian'],
  [/(^|\.)nme\.com$/, 'nme'],
  [/(^|\.)popmatters\.com$/, 'popmatters'],
  [/(^|\.)consequence\.net$/, 'consequence'],
  [/(^|\.)stereogum\.com$/, 'stereogum'],
  [/(^|\.)wikipedia\.org$/, 'wikipedia'],
];

/** Source slug for a publication URL: known hosts by name, otherwise the registrable label. */
export function sourceFromUrl(url: string): string | null {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
  for (const [re, source] of HOST_SOURCES) if (re.test(host)) return source;
  const labels = host.replace(/^www\./, '').split('.');
  const label = labels.length >= 3 && /^(co|com|org|net|ac)$/.test(labels[labels.length - 2]!)
    ? labels[labels.length - 3]
    : labels[Math.max(0, labels.length - 2)];
  return label ? label.replace(/[^a-z0-9]+/g, '') || null : null;
}

export function resolveReviewLinks(input: LinkInputs): ResolvedLink[] {
  const out: ResolvedLink[] = [];
  const seenUrls = new Set<string>();
  const directSources = new Set<string>();
  const push = (link: ResolvedLink) => {
    if (seenUrls.has(link.url)) return;
    seenUrls.add(link.url);
    if (link.discoveredVia !== 'template') directSources.add(link.source);
    out.push(link);
  };

  const id = input.identity;
  if (id?.metacriticId) push({ source: 'metacritic', url: `https://www.metacritic.com/${id.metacriticId.replace(/^\/+/, '')}`, discoveredVia: 'wikidata' });
  if (id?.allmusicId) push({ source: 'allmusic', url: `https://www.allmusic.com/album/${id.allmusicId}`, discoveredVia: 'wikidata' });
  if (id?.rymId) push({ source: 'rateyourmusic', url: `https://rateyourmusic.com/release/${id.rymId.replace(/^\/+/, '')}`, discoveredVia: 'wikidata' });
  if (id?.enwikiTitle) push({ source: 'wikipedia', url: `https://en.wikipedia.org/wiki/${encodeURIComponent(id.enwikiTitle.replace(/ /g, '_'))}`, discoveredVia: 'wikidata' });

  for (const rel of input.mbUrlRelations ?? []) {
    if (rel.type !== 'review' && rel.type !== 'allmusic' && rel.type !== 'wikipedia') continue;
    const source = rel.type === 'allmusic' ? 'allmusic' : sourceFromUrl(rel.url);
    if (!source) continue;
    if (rel.type === 'wikipedia' && directSources.has('wikipedia')) continue;
    push({ source, url: rel.url, discoveredVia: 'mb_relationship' });
  }

  const q = encodeURIComponent(`${input.artist} ${input.title}`.trim());
  for (const [source, template] of Object.entries(SEARCH_TEMPLATES)) {
    if (directSources.has(source)) continue;
    push({ source, url: template.replace('{q}', q), discoveredVia: 'template' });
  }
  return out;
}
