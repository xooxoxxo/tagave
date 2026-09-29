/**
 * Adding a physical copy (spec COL-3), made safe to click twice.
 *
 * Every add takes a transaction-scoped advisory lock on (library, Discogs
 * release) and looks for an active copy of the same release first (one on
 * its way out of Discogs, push_state 'removing', no longer counts):
 *   - one created in the last DUPLICATE_WINDOW_MS is the same click arriving
 *     twice (a double submit, a retry): answer with that item, add nothing;
 *   - an older copy tagave never placed (unmapped, or no album on disk) is
 *     the one the owner is telling us about: an add from an album links that
 *     copy to the album and adds nothing ("linked_existing");
 *   - an older copy already linked means the owner already has it: answer
 *     "already owned" so the page can ask "Add another copy?";
 *   - `anotherCopy` is the owner's yes, still guarded by a few seconds so the
 *     yes itself cannot land twice; the new item is marked extra_copy so
 *     duplicate detection leaves it alone.
 * Nothing reaches Discogs from here: a created item is queued for
 * collection.push, once, after the insert commits.
 */
import { sql } from 'drizzle-orm';
import { collectionItems, collectionSources } from '@liner/db';
import { physicalFormatLabel } from '@liner/core';
import type { getDb } from '../db.js';

type Db = ReturnType<typeof getDb>;

export const DUPLICATE_WINDOW_MS = 2 * 60_000;
export const ANOTHER_COPY_WINDOW_MS = 5_000;

export interface PhysicalLink {
  releaseId?: string | null;
  releaseGroupId?: string | null;
  localAlbumId?: string | null;
  /** 'owner' when the owner added it from an album; 'release_id' when the Discogs id matched a known release */
  mappingSource: string;
}

export interface AddPhysicalInput {
  libraryId: string;
  discogsReleaseId: number;
  link?: PhysicalLink | null;
  anotherCopy?: boolean;
  folderId?: number;
  mediaCondition?: string;
  sleeveCondition?: string;
  notes?: string;
  rating?: number;
  /** what the row shows until Discogs answers (the push replaces it) */
  basicInfo?: { title?: string; artists?: string[]; year?: number } | null;
}

export interface ExistingCopy {
  id: string;
  format: string | null;
  createdAt: string;
}

/** How a copy was placed before an add linked it: what Undo puts back. */
export interface PreviousLink {
  releaseId: string | null;
  releaseGroupId: string | null;
  localAlbumId: string | null;
  mappingState: string | null;
  mappingSource: string | null;
  mappedAt: string | null;
}

export type AddPhysicalResult =
  | { kind: 'created'; itemId: string }
  | { kind: 'same_request'; itemId: string }
  | { kind: 'linked_existing'; itemId: string; previous: PreviousLink }
  | { kind: 'already_owned'; existing: ExistingCopy[] };

interface ActiveRow {
  id: string;
  created_at: Date | string;
  formats: unknown;
  basic_info: Record<string, unknown> | null;
  mapping_state: string | null;
  mapping_source: string | null;
  mapped_at: Date | string | null;
  release_id: string | null;
  release_group_id: string | null;
  local_album_id: string | null;
}

/** A copy tagave never placed on an album: an add from an album should claim it. */
function isUnplaced(r: ActiveRow): boolean {
  return r.mapping_state === 'unmapped' || r.local_album_id == null;
}

export async function ensureCollectionSource(db: Db, libraryId: string): Promise<string> {
  const rows = await db.execute(sql`select id from collection_sources where library_id = ${libraryId} order by created_at limit 1`) as unknown as Array<{ id: string }>;
  if (rows[0]) return rows[0].id;
  const [created] = await db.insert(collectionSources).values({ libraryId, provider: 'discogs' }).returning({ id: collectionSources.id });
  return created!.id;
}

export function copyFormat(row: { formats: unknown; basic_info: Record<string, unknown> | null }): string | null {
  return physicalFormatLabel(row.formats) ?? physicalFormatLabel(row.basic_info?.['formats']);
}

export async function addPhysicalItem(db: Db, input: AddPhysicalInput): Promise<AddPhysicalResult> {
  const sourceId = await ensureCollectionSource(db, input.libraryId);
  const folderId = input.folderId ?? 1;
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`collection-add:${input.libraryId}:${input.discogsReleaseId}`}, 0))`);
    const active = await tx.execute(sql`
      select id, created_at, formats, basic_info, mapping_state, mapping_source, mapped_at,
             release_id, release_group_id, local_album_id
        from collection_items
       where library_id = ${input.libraryId}
         and discogs_release_id = ${input.discogsReleaseId}
         and removed_at is null
         and push_state is distinct from 'removing'
       order by created_at desc`) as unknown as ActiveRow[];

    const newest = active[0];
    const age = newest ? Date.now() - new Date(newest.created_at).getTime() : Infinity;
    if (newest && age < (input.anotherCopy ? ANOTHER_COPY_WINDOW_MS : DUPLICATE_WINDOW_MS)) {
      // the same click twice; an unlinked twin gets the link this click carried
      if (input.link && newest.mapping_state === 'unmapped') {
        await tx.update(collectionItems).set(linkFields(input.link)).where(sql`${collectionItems.id} = ${newest.id}`);
      }
      return { kind: 'same_request', itemId: newest.id };
    }
    // the owner already has this record, and tagave never knew which album it
    // is: this add says so. Link that copy; nothing new reaches Discogs.
    const unplaced = input.link && !input.anotherCopy ? active.filter(isUnplaced).at(-1) : undefined;
    if (unplaced && input.link) {
      await tx.update(collectionItems).set(linkFields(input.link)).where(sql`${collectionItems.id} = ${unplaced.id}`);
      return {
        kind: 'linked_existing',
        itemId: unplaced.id,
        previous: {
          releaseId: unplaced.release_id,
          releaseGroupId: unplaced.release_group_id,
          localAlbumId: unplaced.local_album_id,
          mappingState: unplaced.mapping_state,
          mappingSource: unplaced.mapping_source,
          mappedAt: unplaced.mapped_at ? new Date(unplaced.mapped_at).toISOString() : null,
        },
      };
    }
    if (newest && !input.anotherCopy) {
      return {
        kind: 'already_owned',
        existing: active.map((r) => ({ id: r.id, format: copyFormat(r), createdAt: new Date(r.created_at).toISOString() })),
      };
    }

    const [row] = await tx.insert(collectionItems).values({
      libraryId: input.libraryId,
      collectionSourceId: sourceId,
      discogsReleaseId: input.discogsReleaseId,
      folderId,
      folderName: 'Uncategorized',
      ...(input.mediaCondition ? { mediaCondition: input.mediaCondition } : {}),
      ...(input.sleeveCondition ? { sleeveCondition: input.sleeveCondition } : {}),
      ...(input.notes ? { notes: input.notes } : {}),
      ...(input.rating ? { rating: input.rating } : {}),
      ...(input.basicInfo ? { basicInfo: input.basicInfo } : {}),
      ...(input.link ? linkFields(input.link) : { mappingState: 'unmapped' }),
      // the owner said "Add another copy": two copies they really own
      ...(newest && input.anotherCopy ? { extraCopy: true } : {}),
      pushState: 'pending',
    }).returning({ id: collectionItems.id });
    return { kind: 'created', itemId: row!.id };
  });
}

export function linkFields(link: PhysicalLink) {
  return {
    releaseId: link.releaseId ?? null,
    releaseGroupId: link.releaseGroupId ?? null,
    localAlbumId: link.localAlbumId ?? null,
    // the owner said which album it is ('manual', the schema's word for an
    // owner decision); anything else is tagave's own match
    mappingState: link.mappingSource === 'owner' ? 'manual' : 'auto',
    mappingSource: link.mappingSource,
    mappedAt: new Date(),
  };
}

/**
 * Where a Discogs release already sits in the library: the release that
 * carries that Discogs id, its release group, and the album on disk matched
 * to either. Empty when tagave has never seen the release.
 */
export async function linkForDiscogsRelease(db: Db, libraryId: string, discogsReleaseId: number): Promise<PhysicalLink | null> {
  const rows = await db.execute(sql`
    select r.id as release_id, r.release_group_id,
           (select la.id from local_albums la
             where la.library_id = ${libraryId} and la.state != 'ignored'
               and (la.release_id = r.id or la.release_group_id = r.release_group_id)
             order by (la.release_id = r.id) desc, la.created_at
             limit 1) as local_album_id
      from releases r
     where r.discogs_release_id = ${discogsReleaseId}
     limit 1`) as unknown as Array<{ release_id: string; release_group_id: string | null; local_album_id: string | null }>;
  const r = rows[0];
  if (!r) return null;
  return { releaseId: r.release_id, releaseGroupId: r.release_group_id, localAlbumId: r.local_album_id, mappingSource: 'release_id' };
}
