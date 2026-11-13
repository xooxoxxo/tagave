/**
 * The similar-artists module's switch and its data (Module Composition
 * Principle rule 2).
 *
 *   turn off          similarArtists.fetch skips, the artist page's Similar
 *                     artists section hides, every row stays
 *   delete its data   its two tables are emptied, nothing else (artists,
 *                     follows and albums stay as they are)
 *
 * The switch is the module ledger's row 'similar-artists' (installed_modules),
 * on from the start: it sends MusicBrainz artist ids only, to MetaBrainz,
 * as identification already does. Read per call.
 */
import type postgres from 'postgres';
import { moduleEnabled, setModuleEnabled } from './modules.js';

type Sql = postgres.Sql<any>;
type Tx = postgres.TransactionSql<any>;

export const SIMILAR_ARTISTS_MODULE_ID = 'similar-artists';

/** Every table the module owns; neither references the other. */
export const SIMILAR_ARTISTS_TABLES = ['similar_artists', 'similar_artist_checks'] as const;

export async function similarArtistsEnabled(sql: Sql | Tx): Promise<boolean> {
  return moduleEnabled(sql, SIMILAR_ARTISTS_MODULE_ID);
}

export async function setSimilarArtistsEnabled(sql: Sql | Tx, enabled: boolean): Promise<void> {
  await setModuleEnabled(sql, SIMILAR_ARTISTS_MODULE_ID, enabled);
}

/** Delete the module's data: exactly its rows, in one transaction. Idempotent. */
export async function removeSimilarArtistsData(sql: Sql): Promise<Record<(typeof SIMILAR_ARTISTS_TABLES)[number], number>> {
  return sql.begin(async (tx) => {
    const out = {} as Record<(typeof SIMILAR_ARTISTS_TABLES)[number], number>;
    for (const t of SIMILAR_ARTISTS_TABLES) out[t] = (await tx`delete from ${tx(t)}`).count;
    return out;
  });
}

export interface StoredSimilar {
  mbid: string | null;
  name: string;
  comment: string | null;
  score: number;
  sources: string[];
}

/** Replace an artist's list and record the fetch, in one transaction. */
export async function saveSimilarArtists(sql: Sql, artistId: string, list: readonly StoredSimilar[], sources: readonly string[]): Promise<void> {
  await sql.begin(async (tx) => {
    await tx`delete from similar_artists where artist_id = ${artistId}`;
    for (const [i, s] of list.entries()) {
      await tx`insert into similar_artists (artist_id, position, similar_mbid, name, comment, score, sources)
               values (${artistId}, ${i}, ${s.mbid}, ${s.name}, ${s.comment}, ${s.score}, ${s.sources as string[]}::text[])`;
    }
    await tx`insert into similar_artist_checks (artist_id, fetched_at, sources, found, error)
             values (${artistId}, now(), ${sources as string[]}::text[], ${list.length}, null)
             on conflict (artist_id) do update set fetched_at = now(), sources = excluded.sources, found = excluded.found, error = null`;
  });
}

/** Record a failed fetch; the list from before stays. */
export async function recordSimilarArtistsError(sql: Sql | Tx, artistId: string, error: string): Promise<void> {
  await sql`insert into similar_artist_checks (artist_id, fetched_at, sources, found, error)
            values (${artistId}, now(), '{}', 0, ${error.slice(0, 500)})
            on conflict (artist_id) do update set fetched_at = now(), error = excluded.error`;
}
