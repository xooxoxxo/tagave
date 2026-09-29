import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { eq, and, sql, inArray, desc, type SQL } from 'drizzle-orm';
import {
  libraries, collectionSources, collectionItems, releases, releaseGroups, localAlbums,
} from '@liner/db';
import {
  DiscogsProvider, openSecret, isSealed, parseDiscogsRef, rankPhysicalSuggestions, discogsArtistName, matchTitle,
} from '@liner/core';
import { getDb } from '../db.js';
import { getBoss } from '../boss.js';
import { ApiError } from '../middleware/errorHandler.js';
import { markFacetsDirty } from '../lib/facetSummary.js';
import { parseMatchInput } from '../lib/matchInput.js';
import {
  addPhysicalItem, copyFormat, linkFields, linkForDiscogsRelease, type AddPhysicalResult, type PhysicalLink,
} from '../lib/physicalCollection.js';

type Db = ReturnType<typeof getDb>;
type ItemRow = typeof collectionItems.$inferSelect;

/**
 * The views of the Physical collection page (spec GAP-3):
 *   both          a record whose album is also on disk
 *   physical_only a record tagave knows, or the owner said is not in the
 *                 library, with no album on disk
 *   unmapped      a record tagave cannot place yet
 *   removed       gone from Discogs
 *   duplicates    extra copies of a Discogs release already in the collection
 * "On disk" is the album the owner linked (local_album_id) or any album of
 * the same release group.
 */
const HAS_LOCAL = sql`exists (
  select 1 from local_albums la
   where la.library_id = ${collectionItems.libraryId} and la.state != 'ignored'
     and (la.id = ${collectionItems.localAlbumId}
          or (${collectionItems.releaseGroupId} is not null and la.release_group_id = ${collectionItems.releaseGroupId})))`;
const ACTIVE = sql`${collectionItems.removedAt} is null`;
/*
 * A duplicate is an accidental twin: a newer active copy of a Discogs release
 * the collection already holds, unless the owner said they own both
 * (extra_copy, set by "Add another copy" or "I own both"). A copy on its way
 * out of Discogs (push_state 'removing') no longer counts.
 */
const LEAVING = sql`${collectionItems.pushState} = 'removing'`;
const IS_EXTRA_COPY = sql`(not ${collectionItems.extraCopy} and not ${LEAVING} and exists (
  select 1 from collection_items older
   where older.library_id = ${collectionItems.libraryId}
     and older.discogs_release_id = ${collectionItems.discogsReleaseId}
     and older.removed_at is null and older.push_state is distinct from 'removing'
     and (older.created_at, older.id) < (${collectionItems.createdAt}, ${collectionItems.id})))`;
const HAS_TWIN = sql`(not ${LEAVING} and exists (
  select 1 from collection_items twin
   where twin.library_id = ${collectionItems.libraryId}
     and twin.discogs_release_id = ${collectionItems.discogsReleaseId}
     and twin.removed_at is null and twin.push_state is distinct from 'removing'
     and twin.id != ${collectionItems.id}
     -- the newer of the two decides: an extra copy the owner meant is no twin
     and case when (twin.created_at, twin.id) > (${collectionItems.createdAt}, ${collectionItems.id})
              then not twin.extra_copy else not ${collectionItems.extraCopy} end))`;

export const VIEW_WHERE: Record<string, SQL> = {
  both: sql`${ACTIVE} and ${HAS_LOCAL}`,
  physical_only: sql`${ACTIVE} and ${collectionItems.mappingState} != 'unmapped' and not ${HAS_LOCAL}`,
  unmapped: sql`${ACTIVE} and ${collectionItems.mappingState} = 'unmapped' and not ${HAS_LOCAL}`,
  removed: sql`${collectionItems.removedAt} is not null`,
  duplicates: sql`${ACTIVE} and ${HAS_TWIN}`,
};

async function ownLibrary(db: Db, libraryId: string, userId: string) {
  const rows = await db.select().from(libraries).where(and(eq(libraries.id, libraryId), eq(libraries.ownerUserId, userId)));
  if (rows.length === 0) throw new ApiError(404, 'Not Found', 'Library not found');
  return rows[0]!;
}

async function ownItem(db: Db, itemId: string, userId: string): Promise<ItemRow> {
  const items = await db.select().from(collectionItems).where(eq(collectionItems.id, itemId));
  const item = items[0];
  if (!item) throw new ApiError(404, 'Not Found', 'This record is no longer in your collection');
  await ownLibrary(db, item.libraryId, userId);
  return item;
}

function needUser(request: FastifyRequest) {
  if (!request.user) throw new ApiError(401, 'Unauthorized', 'Authentication required');
  return request.user;
}

function basicInfoOf(item: { basicInfo: unknown }): { title?: string; artists?: string[]; year?: number; thumbUrl?: string; thumb?: string; coverUrl?: string; formats?: unknown } {
  const b = item.basicInfo;
  return b && typeof b === 'object' ? (b as Record<string, never>) : {};
}

/** The answer to an add: 202 with the item, or 409 "already owned" with the copies. */
function sendAddResult(reply: FastifyReply, result: AddPhysicalResult) {
  if (result.kind === 'already_owned') {
    const formats = [...new Set(result.existing.map((e) => e.format).filter(Boolean))];
    reply.status(409).send({
      title: 'Already in your collection',
      status: 409,
      code: 'already_owned',
      detail: `You already have this${formats.length ? ` on ${formats.join(' and ')}` : ''}.`,
      existing: result.existing,
    });
    return;
  }
  if (result.kind === 'linked_existing') {
    reply.status(200).send({ itemId: result.itemId, created: false, linkedExisting: true, previous: result.previous });
    return;
  }
  reply.status(result.kind === 'created' ? 202 : 200).send({ itemId: result.itemId, created: result.kind === 'created' });
}

function validateAddBody(body: { folderId?: number; rating?: number }) {
  if (body.folderId === 0) throw new ApiError(400, 'Bad Request', 'Folder 0 is read-only and cannot be used for collection items');
  if (body.rating !== undefined && (typeof body.rating !== 'number' || body.rating < 0 || body.rating > 5)) {
    throw new ApiError(400, 'Bad Request', 'Rating must be a number between 0 and 5');
  }
}

async function queuePush(libraryId: string, itemId: string) {
  const boss = await getBoss();
  await boss.send('collection.push', { libraryId, itemId }, { singletonKey: `collection-push:${itemId}` });
}

async function queueRemove(db: Db, item: ItemRow) {
  const boss = await getBoss();
  await boss.send('collection.remove', { libraryId: item.libraryId, itemId: item.id }, { singletonKey: `collection-remove:${item.id}` });
  await db.update(collectionItems).set({ pushState: 'removing', pushError: null }).where(eq(collectionItems.id, item.id));
}

/** mapping_source of a record the owner said is not in the library: it stays physical-only */
export const NOT_IN_LIBRARY = 'not_in_library';

export const REMOVE_FAILED_PREFIX = 'Removing from Discogs failed';

export async function createCollectionRoutes(fastify: FastifyInstance) {
  // GET /libraries/:lib/collection-sources — list sources with counts per view
  fastify.get('/libraries/:lib/collection-sources', async (request: FastifyRequest, reply: FastifyReply) => {
    const user = needUser(request);
    const { lib } = request.params as { lib: string };
    const db = getDb();
    await ownLibrary(db, lib, user.id);

    const sources = await db.select().from(collectionSources).where(eq(collectionSources.libraryId, lib));
    const counts = sources.length
      ? await db
          .select({
            sourceId: collectionItems.collectionSourceId,
            total: sql<number>`count(*)::int`,
            mapped: sql<number>`(count(*) filter (where ${collectionItems.mappingState} != 'unmapped' and ${ACTIVE}))::int`,
            unmapped: sql<number>`(count(*) filter (where ${VIEW_WHERE['unmapped']}))::int`,
            removed: sql<number>`(count(*) filter (where ${VIEW_WHERE['removed']}))::int`,
            physicalOnly: sql<number>`(count(*) filter (where ${VIEW_WHERE['physical_only']}))::int`,
            both: sql<number>`(count(*) filter (where ${VIEW_WHERE['both']}))::int`,
            duplicates: sql<number>`(count(*) filter (where ${ACTIVE} and ${IS_EXTRA_COPY}))::int`,
          })
          .from(collectionItems)
          .where(inArray(collectionItems.collectionSourceId, sources.map((s) => s.id)))
          .groupBy(collectionItems.collectionSourceId)
      : [];
    const countMap = new Map(counts.map((c) => [c.sourceId, c]));

    reply.status(200).send({
      sources: sources.map((s) => {
        const c = countMap.get(s.id);
        return {
          id: s.id,
          provider: s.provider,
          username: s.username,
          status: s.status,
          lastSyncAt: s.lastSyncAt?.toISOString() ?? null,
          counts: {
            total: c?.total ?? 0,
            mapped: c?.mapped ?? 0,
            unmapped: c?.unmapped ?? 0,
            removed: c?.removed ?? 0,
            physicalOnly: c?.physicalOnly ?? 0,
            both: c?.both ?? 0,
            duplicates: c?.duplicates ?? 0,
          },
        };
      }),
    });
  });

  // POST /libraries/:lib/collection-sources/sync — enqueue sync
  fastify.post('/libraries/:lib/collection-sources/sync', async (request: FastifyRequest, reply: FastifyReply) => {
    const user = needUser(request);
    const { lib } = request.params as { lib: string };
    await ownLibrary(getDb(), lib, user.id);
    const boss = await getBoss();
    await boss.send('collection.sync', { libraryId: lib }, { singletonKey: `collection-sync:${lib}` });
    reply.status(202).send({ ok: true });
  });

  // POST /collection-sources/:id/sync — same as above
  fastify.post('/collection-sources/:id/sync', async (request: FastifyRequest, reply: FastifyReply) => {
    const user = needUser(request);
    const { id } = request.params as { id: string };
    const db = getDb();
    const sources = await db.select().from(collectionSources).where(eq(collectionSources.id, id));
    if (sources.length === 0) throw new ApiError(404, 'Not Found', 'Collection source not found');
    const source = sources[0]!;
    await ownLibrary(db, source.libraryId, user.id);
    const boss = await getBoss();
    await boss.send('collection.sync', { libraryId: source.libraryId }, { singletonKey: `collection-sync:${source.libraryId}` });
    reply.status(202).send({ ok: true });
  });

  // GET /libraries/:lib/collection — list items with filters
  fastify.get('/libraries/:lib/collection', async (request: FastifyRequest, reply: FastifyReply) => {
    const user = needUser(request);
    const { lib } = request.params as { lib: string };
    const { view = 'all', folder, q, limit = '50', offset = '0' } = request.query as Record<string, string>;
    const db = getDb();
    await ownLibrary(db, lib, user.id);

    const conds: SQL[] = [eq(collectionItems.libraryId, lib)];
    const viewWhere = VIEW_WHERE[view];
    if (viewWhere) conds.push(viewWhere);
    if (folder) conds.push(eq(collectionItems.folderId, parseInt(folder, 10)));
    if (q) {
      conds.push(sql`
        (${collectionItems.basicInfo}->>'title' ilike ${'%' + q + '%'} or
         exists (select 1 from jsonb_array_elements_text(${collectionItems.basicInfo}->'artists') as artist where artist ilike ${'%' + q + '%'}))
      `);
    }

    const limitN = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 500);
    const offsetN = Math.max(parseInt(offset, 10) || 0, 0);
    const items = await db
      .select()
      .from(collectionItems)
      .where(and(...conds))
      .orderBy(...(view === 'duplicates'
        ? [collectionItems.discogsReleaseId, collectionItems.createdAt, collectionItems.id]
        : [desc(sql`coalesce(${collectionItems.dateAdded}, ${collectionItems.createdAt})`), collectionItems.id]))
      .limit(limitN)
      .offset(offsetN);

    // albums on disk: the linked one, or any of the same release group
    const rgIds = [...new Set(items.map((i) => i.releaseGroupId).filter((x): x is string => !!x))];
    const albumIds = [...new Set(items.map((i) => i.localAlbumId).filter((x): x is string => !!x))];
    const localAlbs = rgIds.length || albumIds.length
      ? await db.execute(sql`
          select la.id, la.title_guess as title, la.artist_guess as artist, la.state, la.formats,
                 la.release_group_id, la.year_guess as year, la.track_count,
                 exists (select 1 from images i where i.local_album_id = la.id and i.kind = 'front') as has_art
            from local_albums la
           where la.library_id = ${lib} and la.state != 'ignored'
             and (${rgIds.length ? sql`la.release_group_id in (${sql.join(rgIds.map((x) => sql`${x}`), sql`, `)})` : sql`false`}
                  or ${albumIds.length ? sql`la.id in (${sql.join(albumIds.map((x) => sql`${x}`), sql`, `)})` : sql`false`})
           order by la.created_at`) as unknown as Array<{
            id: string; title: string | null; artist: string | null; state: string; formats: string[] | null;
            release_group_id: string | null; year: number | null; track_count: number | null; has_art: boolean;
          }>
      : [];
    const albumView = (a: (typeof localAlbs)[number]) => ({
      id: a.id, title: a.title, artist: a.artist, state: a.state, formats: a.formats ?? [], year: a.year, trackCount: a.track_count,
      coverUrl: a.has_art ? `/api/v1/images/album/${a.id}` : null,
    });

    // copies of the same Discogs release (active only), oldest first
    const discogsIds = [...new Set(items.map((i) => i.discogsReleaseId).filter((x): x is number => x != null))];
    const copyRows = discogsIds.length
      ? await db.execute(sql`
          select id, discogs_release_id, created_at
            from collection_items
           where library_id = ${lib} and removed_at is null and push_state is distinct from 'removing'
             and discogs_release_id in (${sql.join(discogsIds.map((x) => sql`${x}`), sql`, `)})
           order by created_at, id`) as unknown as Array<{ id: string; discogs_release_id: number }>
      : [];
    const copies = new Map<number, string[]>();
    for (const r of copyRows) copies.set(r.discogs_release_id, [...(copies.get(r.discogs_release_id) ?? []), r.id]);

    reply.status(200).send({
      items: items.map((item) => {
        const info = basicInfoOf(item);
        const linked = localAlbs.filter((a) => a.id === item.localAlbumId);
        const sameGroup = localAlbs.filter((a) => a.id !== item.localAlbumId && item.releaseGroupId && a.release_group_id === item.releaseGroupId);
        const albumsOnDisk = [...linked, ...sameGroup].map(albumView);
        const twins = item.discogsReleaseId != null && !item.removedAt ? (copies.get(item.discogsReleaseId) ?? []) : [];
        const keep = twins[0];
        return {
          id: item.id,
          discogsReleaseId: item.discogsReleaseId,
          discogsMasterId: item.discogsMasterId,
          folderId: item.folderId,
          folderName: item.folderName,
          dateAdded: item.dateAdded?.toISOString(),
          createdAt: item.createdAt.toISOString(),
          rating: item.rating,
          mediaCondition: item.mediaCondition,
          sleeveCondition: item.sleeveCondition,
          notes: item.notes,
          formats: item.formats,
          format: copyFormat({ formats: item.formats, basic_info: info as Record<string, unknown> }),
          thumbUrl: info.thumbUrl ?? info.thumb ?? albumsOnDisk[0]?.coverUrl ?? null,
          mappingState: item.mappingState,
          mappingSource: item.mappingSource,
          releaseId: item.releaseId,
          releaseGroupId: item.releaseGroupId,
          basicInfo: item.basicInfo,
          localAlbums: albumsOnDisk,
          discogsUrl: `https://www.discogs.com/release/${item.discogsReleaseId}`,
          pushState: item.pushState,
          pushError: item.pushError,
          localAlbumId: item.localAlbumId,
          removedAt: item.removedAt?.toISOString() ?? null,
          copies: twins.length,
          extraCopy: item.extraCopy,
          // an accidental twin of the oldest copy; one the owner meant is not
          duplicateOf: twins.length > 1 && keep !== item.id && twins.includes(item.id) && !item.extraCopy ? keep : null,
        };
      }),
      nextCursor: items.length === limitN ? String(offsetN + limitN) : null,
    });
  });

  // GET /collection-items/:id/suggestions — which album in the library this record likely is
  fastify.get('/collection-items/:id/suggestions', async (request: FastifyRequest, reply: FastifyReply) => {
    const user = needUser(request);
    const { id } = request.params as { id: string };
    const db = getDb();
    const item = await ownItem(db, id, user.id);
    const info = basicInfoOf(item);
    const title = info.title ? matchTitle(info.title) : '';
    const artists = (info.artists ?? []).map(discogsArtistName).filter(Boolean);
    if (!title && artists.length === 0 && item.discogsReleaseId == null) {
      reply.send({ suggestions: [] });
      return;
    }
    // the album already matched to this very Discogs release is the answer
    const exact = item.discogsReleaseId != null ? await linkForDiscogsRelease(db, item.libraryId, item.discogsReleaseId) : null;
    const like = (s: string) => '%' + s.replace(/[\\%_]/g, (c) => '\\' + c) + '%';
    const narrow: SQL[] = [
      ...(exact?.localAlbumId ? [sql`la.id = ${exact.localAlbumId}`] : []),
      ...artists.map((a) => sql`la.artist_guess ilike ${like(a)}`),
      ...(title ? [sql`la.title_guess ilike ${like(title)}`, sql`r.title ilike ${like(title)}`, sql`rg.title ilike ${like(title)}`] : []),
      ...(title.length >= 4 ? [sql`similarity(coalesce(la.title_guess, ''), ${title}) > 0.35`] : []),
    ];
    if (narrow.length === 0) {
      reply.send({ suggestions: [] });
      return;
    }
    const rows = await db.execute(sql`
      select la.id, coalesce(r.title, rg.title, la.title_guess) as title, la.artist_guess as artist,
             coalesce(la.year_guess, extract(year from r.date)::int) as year,
             coalesce(la.track_count, r.track_count) as track_count,
             la.release_group_id, la.release_id,
             exists (select 1 from images i where i.local_album_id = la.id and i.kind = 'front') as has_art
        from local_albums la
        left join releases r on r.id = la.release_id
        left join release_groups rg on rg.id = la.release_group_id
       where la.library_id = ${item.libraryId} and la.state != 'ignored'
         and (${sql.join(narrow, sql` or `)})
       limit 200`) as unknown as Array<{
        id: string; title: string | null; artist: string | null; year: number | null; track_count: number | null;
        release_group_id: string | null; release_id: string | null; has_art: boolean;
      }>;
    const candidates = rows.map((r) => ({
      id: r.id, title: r.title, artist: r.artist, year: r.year, trackCount: r.track_count,
      releaseGroupId: r.release_group_id, releaseId: r.release_id,
      coverUrl: r.has_art ? `/api/v1/images/album/${r.id}` : null,
    }));
    const ranked = rankPhysicalSuggestions({ title: info.title ?? null, artists, year: info.year ?? null }, candidates)
      .map((s) => ({ ...s.album, score: s.score, sameDiscogsRelease: false }));
    const exactAlbum = exact?.localAlbumId ? candidates.find((c) => c.id === exact.localAlbumId) : undefined;
    const suggestions = exactAlbum
      ? [{ ...exactAlbum, score: 1, sameDiscogsRelease: true }, ...ranked.filter((s) => s.id !== exactAlbum.id)].slice(0, 3)
      : ranked;
    reply.send({ suggestions });
  });

  // POST /collection-items/:id/link — the owner says which album this record is,
  // or that it is not in the library (it stays physical-only)
  fastify.post('/collection-items/:id/link', async (request: FastifyRequest, reply: FastifyReply) => {
    const user = needUser(request);
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as { localAlbumId?: string; notInLibrary?: boolean };
    const db = getDb();
    const item = await ownItem(db, id, user.id);

    if (body.notInLibrary) {
      await db.update(collectionItems)
        .set({ localAlbumId: null, mappingState: 'manual', mappingSource: NOT_IN_LIBRARY, mappedAt: new Date() })
        .where(eq(collectionItems.id, id));
      await markFacetsDirty(db, item.libraryId);
      reply.send({ ok: true, mappingState: 'manual', mappingSource: NOT_IN_LIBRARY });
      return;
    }
    if (!body.localAlbumId) throw new ApiError(400, 'Bad Request', 'Pick an album, or say the record is not in your library');
    const albums = await db.select().from(localAlbums)
      .where(and(eq(localAlbums.id, body.localAlbumId), eq(localAlbums.libraryId, item.libraryId)));
    const album = albums[0];
    if (!album) throw new ApiError(404, 'Not Found', 'That album is not in this library');
    await db.update(collectionItems)
      .set(linkFields({
        releaseId: album.releaseId ?? item.releaseId, releaseGroupId: album.releaseGroupId ?? item.releaseGroupId,
        localAlbumId: album.id, mappingSource: 'owner',
      }))
      .where(eq(collectionItems.id, id));
    await markFacetsDirty(db, item.libraryId);
    reply.send({ ok: true, mappingState: 'manual', localAlbumId: album.id });
  });

  // POST /collection-items/:id/map — link by a pasted MusicBrainz or Discogs URL / ID
  // (or a known release id), resolved against releases tagave already has
  fastify.post('/collection-items/:id/map', async (request: FastifyRequest, reply: FastifyReply) => {
    const user = needUser(request);
    const { id } = request.params as { id: string };
    const { releaseId, input } = (request.body ?? {}) as { releaseId?: string; input?: string };
    const db = getDb();
    const item = await ownItem(db, id, user.id);

    let link: { releaseId: string | null; releaseGroupId: string } | null = null;
    if (releaseId) {
      const rel = (await db.select().from(releases).where(eq(releases.id, releaseId)))[0];
      if (!rel) throw new ApiError(404, 'Not Found', 'Release not found');
      link = { releaseId: rel.id, releaseGroupId: rel.releaseGroupId };
    } else {
      const parsed = parseMatchInput(input);
      if (!parsed.ok) throw new ApiError(400, 'Bad Request', parsed.message);
      const t = parsed.target;
      if (t.source === 'discogs' && t.kind === 'release') {
        const rel = (await db.select().from(releases).where(eq(releases.discogsReleaseId, t.id)))[0];
        if (rel) link = { releaseId: rel.id, releaseGroupId: rel.releaseGroupId };
      } else if (t.source === 'discogs') {
        const rg = (await db.select().from(releaseGroups).where(eq(releaseGroups.discogsmasterId, t.id)))[0];
        if (rg) link = { releaseId: null, releaseGroupId: rg.id };
      } else {
        if (t.entity !== 'release-group') {
          const rel = (await db.select().from(releases).where(eq(releases.mbid, t.mbid)))[0];
          if (rel) link = { releaseId: rel.id, releaseGroupId: rel.releaseGroupId };
        }
        if (!link && t.entity !== 'release') {
          const rg = (await db.select().from(releaseGroups).where(eq(releaseGroups.mbid, t.mbid)))[0];
          if (rg) link = { releaseId: null, releaseGroupId: rg.id };
        }
      }
      if (!link) {
        throw new ApiError(404, 'Not Found', 'tagave does not know that release yet. Pick the album from your library instead, or mark the record as not in your library.');
      }
    }
    const album = (await db.execute(sql`
      select id from local_albums
       where library_id = ${item.libraryId} and state != 'ignored' and release_group_id = ${link.releaseGroupId}
       order by (release_id = ${link.releaseId}) desc nulls last, created_at limit 1`) as unknown as Array<{ id: string }>)[0];
    await db.update(collectionItems)
      .set(linkFields({ releaseId: link.releaseId, releaseGroupId: link.releaseGroupId, localAlbumId: album?.id ?? null, mappingSource: 'owner' }))
      .where(eq(collectionItems.id, id));
    await markFacetsDirty(db, item.libraryId);
    reply.status(200).send({ ok: true, localAlbumId: album?.id ?? null });
  });

  // DELETE /collection-items/:id/map — unmap
  fastify.delete('/collection-items/:id/map', async (request: FastifyRequest, reply: FastifyReply) => {
    const user = needUser(request);
    const { id } = request.params as { id: string };
    const db = getDb();
    const item = await ownItem(db, id, user.id);
    await db.update(collectionItems)
      .set({ releaseId: null, releaseGroupId: null, localAlbumId: null, mappingState: 'unmapped', mappingSource: null, mappedAt: null })
      .where(eq(collectionItems.id, id));
    await markFacetsDirty(db, item.libraryId);
    reply.status(200).send({ ok: true });
  });

  // POST /collection-items/:id/restore-link — Undo of an add that linked a copy
  // already in the collection: put back how it was placed before
  fastify.post('/collection-items/:id/restore-link', async (request: FastifyRequest, reply: FastifyReply) => {
    const user = needUser(request);
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as {
      releaseId?: string | null; releaseGroupId?: string | null; localAlbumId?: string | null;
      mappingState?: string | null; mappingSource?: string | null; mappedAt?: string | null;
    };
    const db = getDb();
    const item = await ownItem(db, id, user.id);
    const mappingState = body.mappingState && ['unmapped', 'auto', 'manual'].includes(body.mappingState) ? body.mappingState : 'unmapped';
    let localAlbumId: string | null = null;
    if (body.localAlbumId) {
      const own = await db.select({ id: localAlbums.id }).from(localAlbums)
        .where(and(eq(localAlbums.id, body.localAlbumId), eq(localAlbums.libraryId, item.libraryId)));
      localAlbumId = own[0]?.id ?? null;
    }
    const mappedAt = body.mappedAt ? new Date(body.mappedAt) : null;
    await db.update(collectionItems)
      .set(mappingState === 'unmapped'
        ? { releaseId: null, releaseGroupId: null, localAlbumId: null, mappingState, mappingSource: null, mappedAt: null }
        : {
            releaseId: body.releaseId ?? null, releaseGroupId: body.releaseGroupId ?? null, localAlbumId, mappingState,
            mappingSource: body.mappingSource ?? null, mappedAt: mappedAt && !Number.isNaN(mappedAt.getTime()) ? mappedAt : null,
          })
      .where(eq(collectionItems.id, id));
    await markFacetsDirty(db, item.libraryId);
    reply.send({ ok: true });
  });

  // POST /collection-items/:id/keep-both — "I own both": the copies of this
  // Discogs release are all real, so none of them is a duplicate
  fastify.post('/collection-items/:id/keep-both', async (request: FastifyRequest, reply: FastifyReply) => {
    const user = needUser(request);
    const { id } = request.params as { id: string };
    const db = getDb();
    const item = await ownItem(db, id, user.id);
    if (item.discogsReleaseId == null) throw new ApiError(400, 'Bad Request', 'This record has no Discogs release to compare');
    const updated = await db.update(collectionItems)
      .set({ extraCopy: true })
      .where(and(
        eq(collectionItems.libraryId, item.libraryId),
        eq(collectionItems.discogsReleaseId, item.discogsReleaseId),
        sql`${collectionItems.removedAt} is null`,
      ))
      .returning({ id: collectionItems.id });
    reply.send({ ok: true, copies: updated.length });
  });

  // GET /libraries/:lib/collection-sources/options — options for adding to collection (spec COL-3)
  fastify.get('/libraries/:lib/collection-sources/options', async (request: FastifyRequest, reply: FastifyReply) => {
    const user = needUser(request);
    const { lib } = request.params as { lib: string };
    const db = getDb();
    const appSecret = process.env.APP_SECRET;
    const library = await ownLibrary(db, lib, user.id);

    const libSettings = typeof library.settings === 'string' ? JSON.parse(library.settings) : (library.settings ?? {});
    const token = (libSettings as Record<string, any>).discogsToken;
    if (!token) throw new ApiError(400, 'Bad Request', 'Discogs token not configured');

    const unsealed = isSealed(token) && appSecret ? openSecret(token, appSecret) : token;
    const provider = new DiscogsProvider({ token: unsealed, userAgent: 'Liner/1.0' });

    const identity = await provider.getIdentity({} as any);
    const folders = await provider.listCollectionFolders(identity.username, {} as any);
    const fields = await provider.getCollectionFields(identity.username, {} as any);

    const mediaConditionField = fields.find(f => f.name.toLowerCase().includes('media condition'));
    const conditionGrades = mediaConditionField?.options ?? [
      'Mint (M)', 'Near Mint (NM or M-)', 'Very Good Plus (VG+)', 'Very Good (VG)',
      'Good Plus (G+)', 'Good (G)', 'Fair (F)', 'Poor (P)',
    ];

    reply.status(200).send({
      username: identity.username,
      folders: folders.filter(f => f.id !== 0).map(f => ({ id: f.id, name: f.name })),
      fields: fields.map(f => ({ id: f.id, name: f.name, type: f.type, ...(f.options ? { options: f.options } : {}) })),
      conditionGrades,
    });
  });

  // POST /libraries/:lib/albums/:id/collection — "I own this on vinyl/CD" from an album (spec COL-3).
  // The item is linked to the album at once, so the album, the grid's owned
  // facet and the artist page show it as physical before Discogs answers.
  fastify.post('/libraries/:lib/albums/:id/collection', async (request: FastifyRequest, reply: FastifyReply) => {
    const user = needUser(request);
    const { lib, id: albumId } = request.params as { lib: string; id: string };
    const body = (request.body ?? {}) as {
      discogsReleaseId?: number; input?: string; anotherCopy?: boolean; folderId?: number;
      mediaCondition?: string; sleeveCondition?: string; notes?: string; rating?: number;
    };
    const db = getDb();
    await ownLibrary(db, lib, user.id);
    validateAddBody(body);

    const album = (await db.select().from(localAlbums).where(and(eq(localAlbums.id, albumId), eq(localAlbums.libraryId, lib))))[0];
    if (!album) throw new ApiError(404, 'Not Found', 'Album not found');

    let discogsReleaseId = body.discogsReleaseId;
    if (!discogsReleaseId && body.input) {
      const parsed = parseDiscogsRef(body.input);
      if (!parsed || parsed.kind !== 'release') throw new ApiError(400, 'Bad Request', 'Invalid Discogs release URL or ID');
      discogsReleaseId = parsed.id;
    }
    if (!discogsReleaseId && album.releaseId) {
      discogsReleaseId = (await db.select({ d: releases.discogsReleaseId }).from(releases).where(eq(releases.id, album.releaseId)))[0]?.d ?? undefined;
    }
    if (!discogsReleaseId && album.releaseGroupId) {
      discogsReleaseId = (await db.select({ d: releases.discogsReleaseId }).from(releases)
        .where(and(eq(releases.releaseGroupId, album.releaseGroupId), sql`${releases.discogsReleaseId} is not null`))
        .orderBy(releases.date)
        .limit(1))[0]?.d ?? undefined;
    }
    if (!discogsReleaseId) {
      throw new ApiError(400, 'Bad Request', 'tagave does not know this album on Discogs yet. Open Editions and pick one with a Discogs id, or paste a Discogs release URL.');
    }

    // the release the Discogs id names, when tagave has it; else the album's own
    const known = await linkForDiscogsRelease(db, lib, discogsReleaseId);
    const sameGroup = known && known.releaseGroupId === album.releaseGroupId;
    const link: PhysicalLink = {
      releaseId: (sameGroup ? known.releaseId : album.releaseId) ?? null,
      releaseGroupId: album.releaseGroupId ?? known?.releaseGroupId ?? null,
      localAlbumId: album.id,
      mappingSource: 'owner',
    };
    const rel = album.releaseId ? (await db.select({ title: releases.title, date: releases.date }).from(releases).where(eq(releases.id, album.releaseId)))[0] : undefined;
    const title = rel?.title ?? album.titleGuess;
    const year = album.yearGuess ?? (rel?.date ? parseInt(String(rel.date).slice(0, 4), 10) : undefined);
    const result = await addPhysicalItem(db, {
      libraryId: lib, discogsReleaseId, link, anotherCopy: !!body.anotherCopy,
      basicInfo: {
        ...(title ? { title } : {}),
        ...(album.artistGuess ? { artists: [album.artistGuess] } : {}),
        ...(year ? { year } : {}),
      },
      ...(body.folderId !== undefined ? { folderId: body.folderId } : {}),
      ...(body.mediaCondition ? { mediaCondition: body.mediaCondition } : {}),
      ...(body.sleeveCondition ? { sleeveCondition: body.sleeveCondition } : {}),
      ...(body.notes ? { notes: body.notes } : {}),
      ...(body.rating ? { rating: body.rating } : {}),
    });
    if (result.kind === 'created') await queuePush(lib, result.itemId);
    if (result.kind === 'created' || result.kind === 'linked_existing') await markFacetsDirty(db, lib);
    sendAddResult(reply, result);
  });

  // POST /libraries/:lib/collection/items — add by Discogs release URL/ID (spec COL-3).
  // Linked at once when tagave already knows that Discogs release.
  fastify.post('/libraries/:lib/collection/items', async (request: FastifyRequest, reply: FastifyReply) => {
    const user = needUser(request);
    const { lib } = request.params as { lib: string };
    const body = (request.body ?? {}) as {
      input: string; anotherCopy?: boolean; folderId?: number;
      mediaCondition?: string; sleeveCondition?: string; notes?: string; rating?: number;
    };
    if (!body.input) throw new ApiError(400, 'Bad Request', 'input (Discogs release URL/ID) required');
    const db = getDb();
    await ownLibrary(db, lib, user.id);
    const parsed = parseDiscogsRef(body.input);
    if (!parsed || parsed.kind !== 'release') throw new ApiError(400, 'Bad Request', 'Invalid Discogs release URL or ID');
    validateAddBody(body);

    const link = await linkForDiscogsRelease(db, lib, parsed.id);
    const result = await addPhysicalItem(db, {
      libraryId: lib, discogsReleaseId: parsed.id, link, anotherCopy: !!body.anotherCopy,
      ...(body.folderId !== undefined ? { folderId: body.folderId } : {}),
      ...(body.mediaCondition ? { mediaCondition: body.mediaCondition } : {}),
      ...(body.sleeveCondition ? { sleeveCondition: body.sleeveCondition } : {}),
      ...(body.notes ? { notes: body.notes } : {}),
      ...(body.rating ? { rating: body.rating } : {}),
    });
    if (result.kind === 'created') await queuePush(lib, result.itemId);
    if (result.kind === 'created' || result.kind === 'linked_existing') await markFacetsDirty(db, lib);
    sendAddResult(reply, result);
  });

  // DELETE /collection-items/:id — remove a record, from Discogs too (spec COL-3).
  // Once Discogs has an instance (provider_item_id) the worker removes it
  // there; an item that never reached Discogs is deleted outright.
  fastify.delete('/collection-items/:id', async (request: FastifyRequest, reply: FastifyReply) => {
    const user = needUser(request);
    const { id } = request.params as { id: string };
    const db = getDb();
    const item = await ownItem(db, id, user.id);
    if (item.providerItemId) {
      await queueRemove(db, item);
    } else {
      await db.delete(collectionItems).where(eq(collectionItems.id, id));
    }
    await markFacetsDirty(db, item.libraryId);
    reply.status(202).send({ ok: true });
  });

  // POST /collection-items/:id/retry-push — retry a failed add, or a failed removal (spec COL-3)
  fastify.post('/collection-items/:id/retry-push', async (request: FastifyRequest, reply: FastifyReply) => {
    const user = needUser(request);
    const { id } = request.params as { id: string };
    const db = getDb();
    const item = await ownItem(db, id, user.id);
    if (item.providerItemId && item.pushError?.startsWith(REMOVE_FAILED_PREFIX)) {
      await queueRemove(db, item);
    } else {
      await db.update(collectionItems).set({ pushState: 'pending', pushError: null }).where(eq(collectionItems.id, id));
      await queuePush(item.libraryId, item.id);
    }
    reply.status(202).send({ ok: true });
  });

  // GET /libraries/:lib/collection/reconciliation — physical↔digital reconciliation (spec XO-303, GAP-3)
  fastify.get('/libraries/:lib/collection/reconciliation', async (request: FastifyRequest, reply: FastifyReply) => {
    const user = needUser(request);
    const { lib } = request.params as { lib: string };
    const db = getDb();
    await ownLibrary(db, lib, user.id);

    const [c] = await db
      .select({
        physicalOnly: sql<number>`(count(*) filter (where ${VIEW_WHERE['physical_only']}))::int`,
        both: sql<number>`(count(*) filter (where ${VIEW_WHERE['both']}))::int`,
        unmapped: sql<number>`(count(*) filter (where ${VIEW_WHERE['unmapped']}))::int`,
      })
      .from(collectionItems)
      .where(eq(collectionItems.libraryId, lib));

    const digitalOnlyCount = await db.execute(sql`
      select count(distinct la.id)::int as cnt
      from local_albums la
      where la.library_id = ${lib}
        and la.state != 'ignored'
        and la.release_group_id is not null
        and not exists (
          select 1 from collection_items ci
          where ci.library_id = ${lib}
            and (ci.release_group_id = la.release_group_id or ci.local_album_id = la.id)
            and ci.removed_at is null and ci.push_state is distinct from 'removing'
        )
    `);

    const byArtistRows = await db.execute(sql`
      with artist_stats as (
        select
          coalesce(la.artist_guess, (ci.basic_info->>'artists')::text) as artist,
          count(*) filter (where not exists (
            select 1 from local_albums la2
            where la2.library_id = ${lib}
              and la2.release_group_id = ci.release_group_id
              and la2.state != 'ignored'
          ))::int as physical_only,
          count(*) filter (where exists (
            select 1 from local_albums la2
            where la2.library_id = ${lib}
              and la2.release_group_id = ci.release_group_id
              and la2.state != 'ignored'
          ))::int as both
        from collection_items ci
        left join local_albums la on la.id = ci.local_album_id
        where ci.library_id = ${lib}
          and ci.release_group_id is not null
          and ci.removed_at is null and ci.push_state is distinct from 'removing'
        group by artist
      )
      select artist, physical_only, both
      from artist_stats
      where physical_only > 0
      order by physical_only desc
      limit 50
    `);

    const byArtist = (byArtistRows as unknown as Array<{ artist: string; physical_only: number; both: number }>)
      .map(row => ({ artist: row.artist || 'Unknown', physicalOnly: row.physical_only, both: row.both }));

    reply.status(200).send({
      physicalOnly: c?.physicalOnly ?? 0,
      both: c?.both ?? 0,
      digitalOnly: ((digitalOnlyCount as unknown as Array<{ cnt: number }>)[0]?.cnt ?? 0),
      unmapped: c?.unmapped ?? 0,
      byArtist,
    });
  });

  // POST /libraries/:lib/collection-sources/remap — re-run mapping (spec XO-303)
  fastify.post('/libraries/:lib/collection-sources/remap', async (request: FastifyRequest, reply: FastifyReply) => {
    const user = needUser(request);
    const { lib } = request.params as { lib: string };
    await ownLibrary(getDb(), lib, user.id);
    const boss = await getBoss();
    await boss.send('collection.sync', { libraryId: lib, remapOnly: true }, { singletonKey: `collection-remap:${lib}` });
    reply.status(202).send({ ok: true });
  });
}
