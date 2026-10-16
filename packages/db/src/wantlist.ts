/**
 * The wantlist's commands (built-in collection module). Another module adds
 * an entry through wantlist.add, never by writing wantlist_items itself; the
 * entry records where it came from (origin, text) and is the person's from
 * then on. The columns release_group_mbid, title, artist and origin (0050)
 * belong to the wantlist: an entry for an album tagave has no release group
 * of still carries its names.
 *
 * Entries added here live in tagave alone, under a collection source of its
 * own (provider 'tagave'): collection.sync reads only provider 'discogs' and
 * collection.push writes only collection_items, so they are never pushed to
 * or deleted from Discogs.
 */
import type postgres from 'postgres';

type Sql = postgres.Sql<any> | postgres.TransactionSql<any>;

/** tagave's own collection source of a library, made the first time. */
export async function tagaveCollectionSource(sql: Sql, libraryId: string): Promise<string> {
  const [s] = await sql<Array<{ id: string }>>`select id::text as id from collection_sources where library_id = ${libraryId} and provider = 'tagave' order by created_at limit 1`;
  if (s) return s.id;
  const [n] = await sql<Array<{ id: string }>>`insert into collection_sources (library_id, provider, status) values (${libraryId}, 'tagave', 'local') returning id::text as id`;
  return n!.id;
}

export interface WantlistEntry {
  libraryId: string;
  releaseGroupId: string | null;
  releaseGroupMbid: string | null;
  discogsReleaseId: number | null;
  title: string;
  artist: string;
  /** e.g. mc:<link id> */
  origin: string;
}

/** wantlist.add: a tagave-only entry. Returns its id. */
export async function wantlistAdd(sql: Sql, e: WantlistEntry): Promise<string> {
  const source = await tagaveCollectionSource(sql, e.libraryId);
  const [w] = await sql<Array<{ id: string }>>`
    insert into wantlist_items (library_id, collection_source_id, release_group_id, discogs_release_id, release_group_mbid, title, artist, origin, date_added)
    values (${e.libraryId}, ${source}, ${e.releaseGroupId}, ${e.discogsReleaseId}, ${e.releaseGroupMbid}, ${e.title.slice(0, 300)}, ${e.artist.slice(0, 300)}, ${e.origin}, now())
    returning id::text as id`;
  return w!.id;
}
