/**
 * The facets tagave knows (design §3). Cross-app facets take their data
 * shape from the music-connections package (CAPABILITY_DATA, with the album
 * identity left out: the entity id is the key); tagave-only facets are
 * defined here.
 */
import { z } from 'zod';
import { CAPABILITY_DATA, type Capability } from 'music-connections';
import { defineFacet, type FacetDescriptor } from './define.js';

/** A capability's item data without `album` (the entity is the key). */
const fromCapability = (cap: Capability): z.ZodType => (CAPABILITY_DATA[cap] as unknown as z.ZodObject<{ album: z.ZodType }>).omit({ album: true });

export const ALBUM_IDENTITY = defineFacet({ name: 'album.identity', version: '1.0', scope: 'global', cardinality: 'one', schema: fromCapability('identity') });
export const ALBUM_CRITIC_SCORES = defineFacet({ name: 'album.critic-scores', version: '1.0', scope: 'person', cardinality: 'many', schema: fromCapability('critic-scores') });
export const ALBUM_RATING = defineFacet({ name: 'album.rating', version: '1.0', scope: 'person', cardinality: 'one', schema: fromCapability('ratings') });
export const ALBUM_COLLECTION = defineFacet({ name: 'album.collection', version: '1.0', scope: 'library', cardinality: 'many', schema: fromCapability('collection') });
export const ALBUM_LISTENS = defineFacet({ name: 'album.listens', version: '1.0', scope: 'person', cardinality: 'many', schema: fromCapability('listens') });
export const ALBUM_WANTLIST_SUGGESTION = defineFacet({ name: 'album.wantlist-suggestion', version: '1.0', scope: 'person', cardinality: 'many', schema: fromCapability('wantlist-suggestions') });

/** Tagave-only: whether a track plays here (the player). */
export const TRACK_PLAYABLE = defineFacet({
  name: 'track.playable',
  version: '1.0',
  scope: 'library',
  cardinality: 'one',
  schema: z.object({ playable: z.boolean() }),
});

export const FACETS: readonly FacetDescriptor[] = [
  ALBUM_IDENTITY, ALBUM_CRITIC_SCORES, ALBUM_RATING, ALBUM_COLLECTION, ALBUM_LISTENS, ALBUM_WANTLIST_SUGGESTION, TRACK_PLAYABLE,
];

/** v1 ships no casts (§7). */
export const CASTS = [] as const;
