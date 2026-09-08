/**
 * Genre canonicalisation per XO-310 and follow rules per XO-301
 *
 * Exports:
 * - GenreMap: configuration for genre normalization
 * - FollowRules: configuration for following artists and filtering releases
 * - RawTag: input tag from entity_tags
 * - EffectiveGenres: output with genres, styles, and explanation
 * - DEFAULT_GENRE_MAP: Discogs' 15 top-level genres + Metal with comprehensive aliases
 * - DEFAULT_FOLLOW_RULES: default rules for following artists
 * - normalizeGenreMap: fills defaults, validates, clamps
 * - normalizeFollowRules: fills defaults, validates, rejects unknown types
 * - effectiveGenres: weights and buckets raw tags into genres/styles
 */

export interface GenreMap {
  whitelist: string[];
  aliases: Record<string, string>;
  maxGenres: number;
}

export interface FollowRules {
  includePrimary: ('Album' | 'EP' | 'Single')[];
  excludeSecondary: ('Compilation' | 'Live' | 'Remix' | 'DJ-mix' | 'Mixtape/Street' | 'Demo' | 'Soundtrack')[];
  autoFollowMinAlbums: number;
}

export interface RawTag {
  tag: string;
  kind: 'genre' | 'style' | 'tag';
  source: string;
  weight?: number | null;
}

export interface EffectiveGenres {
  genres: string[];
  styles: string[];
  explain: Array<{
    tag: string;
    source: string;
    kind: string;
    mappedTo: string | null;
    weight: number;
  }>;
}

/**
 * Default genre map: Discogs' 15 top-level genres + Metal
 * Whitelist (canonical genres): Rock, Electronic, Pop, Jazz, Funk / Soul, Hip Hop, Classical,
 *   Folk, World, & Country, Reggae, Latin, Stage & Screen, Blues, Brass & Military,
 *   Children's, Non-Music, Metal
 *
 * Aliases (lower-case keys) cover:
 *   - Metal styles → Metal
 *   - Rock variants (alternative, indie, punk, post-rock) → Rock
 *   - Electronic sub-styles → Electronic
 *   - Folk/Country/World variants → Folk, World, & Country
 *   - Soul/Funk/R&B variants → Funk / Soul
 *   - Rap → Hip Hop
 *   - Soundtrack/Score → Stage & Screen
 *   - Orchestral/Opera/Baroque → Classical
 *   - Ska/Dub → Reggae
 *   - Salsa/Bossa Nova/Tango → Latin
 */
export const DEFAULT_GENRE_MAP: GenreMap = {
  whitelist: [
    'Rock',
    'Electronic',
    'Pop',
    'Jazz',
    'Funk / Soul',
    'Hip Hop',
    'Classical',
    'Folk, World, & Country',
    'Reggae',
    'Latin',
    'Stage & Screen',
    'Blues',
    'Brass & Military',
    "Children's",
    'Non-Music',
    'Metal',
  ],
  aliases: {
    // Metal styles
    'black metal': 'Metal',
    'death metal': 'Metal',
    'heavy metal': 'Metal',
    'doom metal': 'Metal',
    'thrash metal': 'Metal',
    'power metal': 'Metal',
    'symphonic metal': 'Metal',
    'progressive metal': 'Metal',
    'alternative metal': 'Metal',
    'metalcore': 'Metal',
    'deathcore': 'Metal',
    'grindcore': 'Metal',
    'sludge metal': 'Metal',
    'stoner metal': 'Metal',
    'folk metal': 'Metal',
    'melodic death metal': 'Metal',
    'neo-classical metal': 'Metal',

    // Rock variants
    'alternative rock': 'Rock',
    'indie rock': 'Rock',
    'punk rock': 'Rock',
    'post-rock': 'Rock',
    'post rock': 'Rock',
    'psychedelic rock': 'Rock',
    'progressive rock': 'Rock',
    'prog rock': 'Rock',
    'hard rock': 'Rock',
    'garage rock': 'Rock',
    'glam rock': 'Rock',
    'art rock': 'Rock',

    // Electronic sub-styles
    'techno': 'Electronic',
    'house': 'Electronic',
    'ambient': 'Electronic',
    'idm': 'Electronic',
    'intelligent dance music': 'Electronic',
    'drum and bass': 'Electronic',
    'drum & bass': 'Electronic',
    'downtempo': 'Electronic',
    'trance': 'Electronic',
    'electro': 'Electronic',
    'dubstep': 'Electronic',
    'liquid drum and bass': 'Electronic',
    'liquid funk': 'Electronic',
    'breakcore': 'Electronic',
    'glitch': 'Electronic',
    'industrial': 'Electronic',
    'synthwave': 'Electronic',
    'synthpop': 'Electronic',

    // Folk/Country/World variants
    'folk': 'Folk, World, & Country',
    'country': 'Folk, World, & Country',
    'world': 'Folk, World, & Country',
    'folk, world, & country': 'Folk, World, & Country',
    'folk world country': 'Folk, World, & Country',
    'world music': 'Folk, World, & Country',
    'acoustic': 'Folk, World, & Country',

    // Soul/Funk/R&B variants
    'soul': 'Funk / Soul',
    'funk': 'Funk / Soul',
    'r&b': 'Funk / Soul',
    'rnb': 'Funk / Soul',
    'rhythm and blues': 'Funk / Soul',
    'neo soul': 'Funk / Soul',

    // Rap variants
    'rap': 'Hip Hop',
    'hip hop': 'Hip Hop',
    'hip-hop': 'Hip Hop',
    'hip hop rap': 'Hip Hop',
    'gangsta rap': 'Hip Hop',
    'conscious hip hop': 'Hip Hop',

    // Soundtrack/Score
    'soundtrack': 'Stage & Screen',
    'score': 'Stage & Screen',
    'film score': 'Stage & Screen',
    'video game': 'Stage & Screen',
    'video game music': 'Stage & Screen',

    // Orchestral/Opera/Baroque
    'orchestral': 'Classical',
    'opera': 'Classical',
    'baroque': 'Classical',
    'classical music': 'Classical',

    // Ska/Dub
    'ska': 'Reggae',
    'dub': 'Reggae',
    'reggae dub': 'Reggae',

    // Salsa/Bossa Nova/Tango
    'salsa': 'Latin',
    'bossa nova': 'Latin',
    'tango': 'Latin',
    'cumbia': 'Latin',
    'merengue': 'Latin',
  },
  maxGenres: 3,
};

/**
 * Normalize a partial genre map to a valid GenreMap with defaults.
 * Fills in defaults, deduplicates whitelist, lower-cases alias keys, clamps maxGenres.
 */
export function normalizeGenreMap(input: Partial<GenreMap> | null | undefined): GenreMap {
  const map: GenreMap = {
    whitelist: input?.whitelist ?? DEFAULT_GENRE_MAP.whitelist,
    aliases: input?.aliases ?? DEFAULT_GENRE_MAP.aliases,
    maxGenres: input?.maxGenres ?? DEFAULT_GENRE_MAP.maxGenres,
  };

  // Deduplicate whitelist (preserve case)
  map.whitelist = Array.from(new Set(map.whitelist));

  // Lower-case alias keys, preserving values as-is
  const lowerAliases: Record<string, string> = {};
  for (const [key, value] of Object.entries(map.aliases)) {
    lowerAliases[key.toLowerCase()] = value;
  }
  map.aliases = lowerAliases;

  // Clamp maxGenres to 1..10
  map.maxGenres = Math.max(1, Math.min(10, Math.floor(map.maxGenres)));

  return map;
}

/**
 * Default follow rules per XO-301 GAP-2
 * For followed artists, include Album releases by default;
 * exclude compilations, live recordings, remixes, etc.
 */
export const DEFAULT_FOLLOW_RULES: FollowRules = {
  includePrimary: ['Album'],
  excludeSecondary: ['Compilation', 'Live', 'Remix', 'DJ-mix', 'Mixtape/Street', 'Demo', 'Soundtrack'],
  autoFollowMinAlbums: 2,
};

/**
 * Normalize a partial follow rules object to a valid FollowRules with defaults.
 * Fills in defaults, validates type names, clamps autoFollowMinAlbums to 1..10.
 * Throws an error if unknown type names are provided.
 */
export function normalizeFollowRules(input: Partial<FollowRules> | null | undefined): FollowRules {
  const validPrimaryTypes = new Set(['Album', 'EP', 'Single']);
  const validSecondaryTypes = new Set(['Compilation', 'Live', 'Remix', 'DJ-mix', 'Mixtape/Street', 'Demo', 'Soundtrack']);

  // Validate includePrimary
  if (input?.includePrimary) {
    for (const type of input.includePrimary) {
      if (!validPrimaryTypes.has(type)) {
        throw new Error(`Invalid primary release type: ${type}`);
      }
    }
  }

  // Validate excludeSecondary
  if (input?.excludeSecondary) {
    for (const type of input.excludeSecondary) {
      if (!validSecondaryTypes.has(type)) {
        throw new Error(`Invalid secondary release type: ${type}`);
      }
    }
  }

  const rules: FollowRules = {
    includePrimary: input?.includePrimary ?? DEFAULT_FOLLOW_RULES.includePrimary,
    excludeSecondary: input?.excludeSecondary ?? DEFAULT_FOLLOW_RULES.excludeSecondary,
    autoFollowMinAlbums: input?.autoFollowMinAlbums ?? DEFAULT_FOLLOW_RULES.autoFollowMinAlbums,
  };

  // Deduplicate and sort for consistency
  rules.includePrimary = Array.from(new Set(rules.includePrimary)).sort();
  rules.excludeSecondary = Array.from(new Set(rules.excludeSecondary)).sort();

  // Clamp autoFollowMinAlbums to 1..10
  rules.autoFollowMinAlbums = Math.max(1, Math.min(10, Math.floor(rules.autoFollowMinAlbums)));

  return rules;
}

/**
 * Calculate weight for a raw tag based on source and kind.
 * Weight formula:
 *   - Discogs genre: 3
 *   - Discogs style: 2
 *   - MusicBrainz genre: 1 + log10(1 + count)
 *   - MusicBrainz tag: 0.5 + 0.5 * log10(1 + count)
 */
function tagWeight(tag: RawTag): number {
  const count = tag.weight ?? 0;

  if (tag.source === 'discogs') {
    if (tag.kind === 'genre') return 3;
    if (tag.kind === 'style') return 2;
  }

  if (tag.source === 'musicbrainz') {
    if (tag.kind === 'genre') return 1 + Math.log10(1 + count);
    if (tag.kind === 'tag') return 0.5 + 0.5 * Math.log10(1 + count);
  }

  // Fallback for unknown source/kind combinations
  return 0;
}

/**
 * Transform raw tags into effective genres and styles using the provided map.
 * Genres are whitelisted entries, styles are non-whitelisted tags (top 5 by weight).
 * Effective genres are the top N by summed weight, with ties resolved by first appearance.
 */
export function effectiveGenres(raw: RawTag[], map: GenreMap): EffectiveGenres {
  // Normalize and deduplicate raw tags, computing weights
  const normalized = new Map<
    string,
    {
      original: string;
      normalized: string;
      weight: number;
      source: string;
      kind: string;
      firstIdx: number;
    }
  >();

  for (const [i, tag] of raw.entries()) {
    const normalized_tag = (tag.tag || '').trim().toLowerCase();

    if (!normalized_tag) continue; // Skip empty tags

    const weight = tagWeight(tag);
    const key = `${normalized_tag}|${tag.source}|${tag.kind}`;

    if (!normalized.has(key)) {
      normalized.set(key, {
        original: tag.tag,
        normalized: normalized_tag,
        weight,
        source: tag.source,
        kind: tag.kind,
        firstIdx: i,
      });
    }
  }

  // Bucket into genres and styles
  const genreBuckets = new Map<string, { weight: number; firstIdx: number }>();
  const styleTags: Array<{
    original: string;
    normalized: string;
    canonical: string;
    weight: number;
    source: string;
    kind: string;
    firstIdx: number;
  }> = [];

  for (const entry of normalized.values()) {
    const { normalized: normalizedTag, weight, source, kind, firstIdx, original } = entry;

    // Check if it maps to a whitelisted genre (case-insensitive)
    const aliased = map.aliases[normalizedTag];
    const matchedGenre =
      aliased ||
      map.whitelist.find((g) => g.toLowerCase() === normalizedTag);

    if (matchedGenre) {
      // It's a genre (either direct match or aliased)
      const canonical = matchedGenre;
      if (!genreBuckets.has(canonical)) {
        genreBuckets.set(canonical, { weight: 0, firstIdx });
      }
      const bucket = genreBuckets.get(canonical);
      if (bucket) {
        bucket.weight += weight;
        bucket.firstIdx = Math.min(bucket.firstIdx, firstIdx);
      }
    } else {
      // It's a style
      styleTags.push({
        original,
        normalized: normalizedTag,
        canonical: matchedGenre || normalizedTag,
        weight,
        source,
        kind,
        firstIdx,
      });
    }
  }

  // Deduplicate styles by canonical form, summing weights
  const styleMap = new Map<string, { weight: number; firstIdx: number; original: string }>();
  for (const style of styleTags) {
    const key = style.canonical;
    if (!styleMap.has(key)) {
      styleMap.set(key, { weight: 0, firstIdx: style.firstIdx, original: style.original });
    }
    const s = styleMap.get(key);
    if (s) {
      s.weight += style.weight;
      s.firstIdx = Math.min(s.firstIdx, style.firstIdx);
    }
  }

  // Sort genres by weight (descending), then by first appearance (ascending), take top maxGenres
  const sortedGenres = Array.from(genreBuckets.entries())
    .sort((a, b) => {
      const weightDiff = b[1].weight - a[1].weight;
      if (weightDiff !== 0) return weightDiff;
      return a[1].firstIdx - b[1].firstIdx;
    })
    .slice(0, map.maxGenres)
    .map(([genre]) => genre);

  // Sort styles by weight (descending), then by first appearance (ascending), take top 5
  const sortedStyles = Array.from(styleMap.entries())
    .sort((a, b) => {
      const weightDiff = b[1].weight - a[1].weight;
      if (weightDiff !== 0) return weightDiff;
      return a[1].firstIdx - b[1].firstIdx;
    })
    .slice(0, 5)
    .map(([, entry]) => entry.original);

  // Build the explain array
  const explain: Array<{
    tag: string;
    source: string;
    kind: string;
    mappedTo: string | null;
    weight: number;
  }> = [];

  for (const entry of normalized.values()) {
    const { original, normalized: normalizedTag, weight, source, kind } = entry;

    const aliased = map.aliases[normalizedTag];
    const matchedGenre =
      aliased ||
      map.whitelist.find((g) => g.toLowerCase() === normalizedTag);

    explain.push({
      tag: original,
      source,
      kind,
      mappedTo: matchedGenre || null,
      weight,
    });
  }

  return {
    genres: sortedGenres,
    styles: sortedStyles,
    explain,
  };
}
