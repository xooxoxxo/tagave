/**
 * Reviews and listening (spec §9.8 REV-1..3, §13 "Reviews" row).
 *
 * Everything hangs off a release group: external reviews and link-outs are
 * global cache (fetched by the reviews.fetch worker job the first time any
 * library opens the album, then weekly), while the owner's rating, review,
 * revisions, clippings and listens are per library + user.
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { and, desc, eq, sql } from 'drizzle-orm';
import PgBoss from 'pg-boss';
import {
  clippings, externalReviews, libraries, listens, releaseGroups, releases, reviewLinks,
  userReviewRevisions, userReviews,
} from '@liner/db';
import {
  createClippingSchema, createListenSchema, putOwnReviewSchema, reviewLinkLabel,
  type Clipping, type ExternalReview, type Listen, type OwnReview, type ReviewLink,
  type ReviewRevision, type ReviewsBundle,
} from '@liner/shared';
import { getDb } from '../db.js';
import { ApiError } from '../middleware/errorHandler.js';

/** External reviews are refreshed weekly (REV-1) … */
const REVIEWS_TTL_MS = 7 * 24 * 3600 * 1000;
/** … except the Discogs community rating, which the terms cap at 6 h (§10.2.5). */
const DISCOGS_FRESH_MS = 6 * 3600 * 1000;

let bossSingleton: PgBoss | null = null;
async function getBoss(): Promise<PgBoss> {
  if (!bossSingleton) {
    bossSingleton = new PgBoss(process.env.DATABASE_URL!);
    await bossSingleton.start();
    await bossSingleton.createQueue('reviews.fetch');
    await ensureExclusiveReviewsQueue();
  }
  return bossSingleton;
}

/**
 * pg-boss ≥10 honours singletonKey only under a non-standard queue policy,
 * and updateQueue() cannot change the policy of an existing queue. The album
 * page polls this endpoint while gathering, so one job per release group in
 * created/active state ('exclusive') is what keeps providers unbothered.
 */
export async function ensureExclusiveReviewsQueue(): Promise<void> {
  await getDb().execute(sql`update pgboss.queue set policy = 'exclusive' where name = 'reviews.fetch' and policy <> 'exclusive'`);
}

async function assertLibrary(userId: string, libraryId: string) {
  const rows = await getDb()
    .select({ id: libraries.id })
    .from(libraries)
    .where(and(eq(libraries.id, libraryId), eq(libraries.ownerUserId, userId)));
  if (rows.length === 0) throw new ApiError(404, 'Not Found', 'Library not found');
}

async function loadReleaseGroup(rgId: string) {
  const rows = await getDb().select().from(releaseGroups).where(eq(releaseGroups.id, rgId)).limit(1);
  if (!rows[0]) throw new ApiError(404, 'Not Found', 'Release group not found');
  return rows[0];
}

function requireUser(request: FastifyRequest): { id: string } {
  if (!request.user) throw new ApiError(401, 'Unauthorized', 'Authentication required');
  return request.user;
}

function parseBody<T>(schema: { safeParse: (v: unknown) => { success: true; data: T } | { success: false; error: { issues: Array<{ message: string; path: (string | number)[] }> } } }, body: unknown): T {
  const parsed = schema.safeParse(body ?? {});
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new ApiError(400, 'Bad Request', issue ? `${issue.path.join('.') || 'body'}: ${issue.message}` : 'Invalid body');
  }
  return parsed.data;
}

const num = (v: string | number | null | undefined): number | null => (v == null ? null : Number(v));
const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);

function toOwnReview(row: typeof userReviews.$inferSelect): OwnReview {
  return {
    id: row.id,
    releaseGroupId: row.releaseGroupId,
    rating: num(row.rating),
    bodyMd: row.bodyMd ?? null,
    favoriteTrackIds: row.favoriteTrackIds ?? [],
    tags: row.tags ?? [],
    currentRevision: row.currentRevision ?? 1,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toClipping(row: typeof clippings.$inferSelect): Clipping {
  return {
    id: row.id,
    releaseGroupId: row.releaseGroupId,
    url: row.url ?? null,
    sourceLabel: row.sourceLabel ?? null,
    scoreRaw: num(row.scoreRaw),
    note: row.note ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

function toExternal(row: typeof externalReviews.$inferSelect, stale: boolean): ExternalReview {
  return {
    id: row.id,
    source: row.source as ExternalReview['source'],
    sourceId: row.sourceId ?? null,
    url: row.url ?? null,
    author: row.author ?? null,
    title: row.title ?? null,
    bodyText: row.bodyText ?? null,
    excerpt: row.excerpt ?? null,
    ratingRaw: num(row.ratingRaw),
    ratingScale: row.ratingScale ?? null,
    ratingNormalized: row.ratingNormalized ?? null,
    license: row.license,
    language: row.language ?? null,
    publishedAt: iso(row.publishedAt),
    fetchedAt: iso(row.fetchedAt),
    stale,
  };
}

const SOURCE_ORDER: Record<string, number> = { wikipedia: 0, critiquebrainz: 1, musicbrainz: 2, discogs: 3 };
const VIA_ORDER: Record<string, number> = { wikidata: 0, mb_relationship: 1, template: 2 };

export async function createReviewRoutes(fastify: FastifyInstance) {
  /** The bundle the Reviews tab renders (spec §13): external + links + clippings + own + listens. */
  fastify.get('/libraries/:libraryId/release-groups/:rgId/reviews', async (request: FastifyRequest, reply: FastifyReply) => {
    const user = requireUser(request);
    const { libraryId, rgId } = request.params as { libraryId: string; rgId: string };
    await assertLibrary(user.id, libraryId);
    const rg = await loadReleaseGroup(rgId);
    const db = getDb();
    const now = Date.now();

    // Opening the page fetches nothing (owner's rule, 2026-09-08): the section
    // offers "Gather reviews" / "Refresh", which POST …/reviews/refresh; a caller
    // that wants the old first-view behaviour passes ?fetch=1. Staleness is
    // reported, not acted on. singletonKey keeps one job per release group.
    const fetchStale = !rg.reviewsFetchedAt || now - rg.reviewsFetchedAt.getTime() > REVIEWS_TTL_MS;
    if (fetchStale && (request.query as Record<string, unknown>)['fetch'] === '1') {
      const boss = await getBoss();
      await boss.send('reviews.fetch', { releaseGroupId: rgId }, { singletonKey: `reviews:${rgId}` });
    }
    const inFlightRows = (await db.execute(sql`
      select 1 as x from pgboss.job
      where name = 'reviews.fetch' and singleton_key = ${'reviews:' + rgId} and state in ('created', 'retry', 'active')
      limit 1`)) as unknown as unknown[];
    const gathering = inFlightRows.length > 0;

    const extRows = await db.select().from(externalReviews).where(eq(externalReviews.releaseGroupId, rgId));
    const external = extRows
      .map((row) => {
        const stale = row.source === 'discogs' && (!row.fetchedAt || now - row.fetchedAt.getTime() > DISCOGS_FRESH_MS);
        return toExternal(row, stale);
      })
      .sort((a, b) =>
        (SOURCE_ORDER[a.source] ?? 9) - (SOURCE_ORDER[b.source] ?? 9)
        || (b.publishedAt ?? '').localeCompare(a.publishedAt ?? ''));
    if (!fetchStale && external.some((e) => e.source === 'discogs' && e.stale)) {
      const boss = await getBoss();
      await boss.send('reviews.fetch', { releaseGroupId: rgId, only: 'discogs' }, { singletonKey: `reviews-discogs:${rgId}` });
    }

    const linkRows = await db.select().from(reviewLinks).where(eq(reviewLinks.releaseGroupId, rgId));
    const links: ReviewLink[] = linkRows
      .map((l) => ({
        source: l.source,
        label: reviewLinkLabel(l.source),
        url: l.url,
        discoveredVia: (l.discoveredVia ?? 'template') as ReviewLink['discoveredVia'],
      }))
      .sort((a, b) => (VIA_ORDER[a.discoveredVia] ?? 9) - (VIA_ORDER[b.discoveredVia] ?? 9) || a.label.localeCompare(b.label));

    const clipRows = await db
      .select()
      .from(clippings)
      .where(and(eq(clippings.libraryId, libraryId), eq(clippings.userId, user.id), eq(clippings.releaseGroupId, rgId)))
      .orderBy(desc(clippings.createdAt));

    const ownRows = await db
      .select()
      .from(userReviews)
      .where(and(eq(userReviews.libraryId, libraryId), eq(userReviews.userId, user.id), eq(userReviews.releaseGroupId, rgId)))
      .limit(1);

    const listenRows = await db
      .select({ listen: listens, releaseTitle: releases.title })
      .from(listens)
      .leftJoin(releases, eq(releases.id, listens.releaseId))
      .where(and(eq(listens.libraryId, libraryId), eq(listens.userId, user.id), eq(listens.releaseGroupId, rgId)))
      .orderBy(desc(listens.listenedAt));

    const bundle: ReviewsBundle = {
      releaseGroupId: rgId,
      fetchedAt: iso(rg.reviewsFetchedAt),
      gathering,
      external,
      links,
      clippings: clipRows.map(toClipping),
      own: ownRows[0] ? toOwnReview(ownRows[0]) : null,
      listens: listenRows.map(({ listen, releaseTitle }): Listen => ({
        id: listen.id,
        releaseGroupId: listen.releaseGroupId,
        releaseId: listen.releaseId ?? null,
        releaseTitle: releaseTitle ?? null,
        listenedAt: listen.listenedAt.toISOString(),
        format: listen.format ?? null,
        note: listen.note ?? null,
        createdAt: listen.createdAt.toISOString(),
      })),
    };
    reply.send(bundle);
  });

  /** On-demand refresh of the external half (REV-1 "and on demand"). */
  fastify.post('/libraries/:libraryId/release-groups/:rgId/reviews/refresh', async (request: FastifyRequest, reply: FastifyReply) => {
    const user = requireUser(request);
    const { libraryId, rgId } = request.params as { libraryId: string; rgId: string };
    await assertLibrary(user.id, libraryId);
    await loadReleaseGroup(rgId);
    const boss = await getBoss();
    await boss.send('reviews.fetch', { releaseGroupId: rgId, force: true }, { singletonKey: `reviews:${rgId}` });
    reply.status(202).send({ ok: true });
  });

  /** Own rating + Markdown review; every change of rating or body keeps a revision (REV-3). */
  fastify.put('/libraries/:libraryId/release-groups/:rgId/review', async (request: FastifyRequest, reply: FastifyReply) => {
    const user = requireUser(request);
    const { libraryId, rgId } = request.params as { libraryId: string; rgId: string };
    await assertLibrary(user.id, libraryId);
    await loadReleaseGroup(rgId);
    const body = parseBody(putOwnReviewSchema, request.body);
    const db = getDb();

    const existing = (await db
      .select()
      .from(userReviews)
      .where(and(eq(userReviews.libraryId, libraryId), eq(userReviews.userId, user.id), eq(userReviews.releaseGroupId, rgId)))
      .limit(1))[0];

    const rating = body.rating === undefined ? num(existing?.rating) : body.rating;
    const bodyMd = body.bodyMd === undefined ? existing?.bodyMd ?? null : (body.bodyMd || null);
    const ratingStr = rating == null ? null : rating.toFixed(1);

    if (!existing) {
      const inserted = (await db
        .insert(userReviews)
        .values({
          libraryId,
          userId: user.id,
          releaseGroupId: rgId,
          rating: ratingStr,
          bodyMd,
          favoriteTrackIds: body.favoriteTrackIds ?? [],
          tags: body.tags ?? [],
          currentRevision: 1,
        })
        .returning())[0]!;
      await db.insert(userReviewRevisions).values({ userReviewId: inserted.id, revision: 1, rating: ratingStr, bodyMd });
      reply.status(201).send(toOwnReview(inserted));
      return;
    }

    const changed = num(existing.rating) !== rating || (existing.bodyMd ?? null) !== bodyMd;
    const nextRevision = (existing.currentRevision ?? 1) + (changed ? 1 : 0);
    const updated = (await db
      .update(userReviews)
      .set({
        rating: ratingStr,
        bodyMd,
        ...(body.favoriteTrackIds ? { favoriteTrackIds: body.favoriteTrackIds } : {}),
        ...(body.tags ? { tags: body.tags } : {}),
        currentRevision: nextRevision,
        updatedAt: new Date(),
      })
      .where(eq(userReviews.id, existing.id))
      .returning())[0]!;
    if (changed) {
      await db.insert(userReviewRevisions).values({ userReviewId: existing.id, revision: nextRevision, rating: ratingStr, bodyMd });
    }
    reply.send(toOwnReview(updated));
  });

  fastify.delete('/libraries/:libraryId/release-groups/:rgId/review', async (request: FastifyRequest, reply: FastifyReply) => {
    const user = requireUser(request);
    const { libraryId, rgId } = request.params as { libraryId: string; rgId: string };
    await assertLibrary(user.id, libraryId);
    await getDb()
      .delete(userReviews)
      .where(and(eq(userReviews.libraryId, libraryId), eq(userReviews.userId, user.id), eq(userReviews.releaseGroupId, rgId)));
    reply.send({ ok: true });
  });

  fastify.get('/libraries/:libraryId/release-groups/:rgId/review/revisions', async (request: FastifyRequest, reply: FastifyReply) => {
    const user = requireUser(request);
    const { libraryId, rgId } = request.params as { libraryId: string; rgId: string };
    await assertLibrary(user.id, libraryId);
    const db = getDb();
    const own = (await db
      .select({ id: userReviews.id })
      .from(userReviews)
      .where(and(eq(userReviews.libraryId, libraryId), eq(userReviews.userId, user.id), eq(userReviews.releaseGroupId, rgId)))
      .limit(1))[0];
    if (!own) {
      reply.send({ items: [] });
      return;
    }
    const rows = await db
      .select()
      .from(userReviewRevisions)
      .where(eq(userReviewRevisions.userReviewId, own.id))
      .orderBy(desc(userReviewRevisions.revision));
    const items: ReviewRevision[] = rows.map((r) => ({
      revision: r.revision,
      rating: num(r.rating),
      bodyMd: r.bodyMd ?? null,
      editedAt: r.editedAt.toISOString(),
    }));
    reply.send({ items });
  });

  /** Listen entry: date, format, optional edition (REV-3; "listened today" needs no review). */
  fastify.post('/libraries/:libraryId/release-groups/:rgId/listens', async (request: FastifyRequest, reply: FastifyReply) => {
    const user = requireUser(request);
    const { libraryId, rgId } = request.params as { libraryId: string; rgId: string };
    await assertLibrary(user.id, libraryId);
    await loadReleaseGroup(rgId);
    const body = parseBody(createListenSchema, request.body);
    const db = getDb();

    let releaseTitle: string | null = null;
    if (body.releaseId) {
      const rel = (await db
        .select({ id: releases.id, title: releases.title })
        .from(releases)
        .where(and(eq(releases.id, body.releaseId), eq(releases.releaseGroupId, rgId)))
        .limit(1))[0];
      if (!rel) throw new ApiError(400, 'Bad Request', 'releaseId is not an edition of this release group');
      releaseTitle = rel.title;
    }

    const inserted = (await db
      .insert(listens)
      .values({
        libraryId,
        userId: user.id,
        releaseGroupId: rgId,
        releaseId: body.releaseId ?? null,
        listenedAt: body.listenedAt ? new Date(body.listenedAt) : new Date(),
        format: body.format ?? null,
        note: body.note || null,
      })
      .returning())[0]!;
    const out: Listen = {
      id: inserted.id,
      releaseGroupId: inserted.releaseGroupId,
      releaseId: inserted.releaseId ?? null,
      releaseTitle,
      listenedAt: inserted.listenedAt.toISOString(),
      format: inserted.format ?? null,
      note: inserted.note ?? null,
      createdAt: inserted.createdAt.toISOString(),
    };
    reply.status(201).send(out);
  });

  fastify.delete('/listens/:listenId', async (request: FastifyRequest, reply: FastifyReply) => {
    const user = requireUser(request);
    const { listenId } = request.params as { listenId: string };
    const db = getDb();
    const row = (await db.select({ id: listens.id, libraryId: listens.libraryId, userId: listens.userId }).from(listens).where(eq(listens.id, listenId)).limit(1))[0];
    if (!row || row.userId !== user.id) throw new ApiError(404, 'Not Found', 'Listen not found');
    await assertLibrary(user.id, row.libraryId);
    await db.delete(listens).where(eq(listens.id, listenId));
    reply.send({ ok: true });
  });

  /** Clipping: a pasted URL and/or quote with optional score (REV-2, private annotation). */
  fastify.post('/libraries/:libraryId/release-groups/:rgId/clippings', async (request: FastifyRequest, reply: FastifyReply) => {
    const user = requireUser(request);
    const { libraryId, rgId } = request.params as { libraryId: string; rgId: string };
    await assertLibrary(user.id, libraryId);
    await loadReleaseGroup(rgId);
    const body = parseBody(createClippingSchema, request.body);
    const inserted = (await getDb()
      .insert(clippings)
      .values({
        libraryId,
        userId: user.id,
        releaseGroupId: rgId,
        url: body.url ?? null,
        sourceLabel: body.sourceLabel || null,
        scoreRaw: body.scoreRaw == null ? null : String(body.scoreRaw),
        note: body.note || null,
      })
      .returning())[0]!;
    reply.status(201).send(toClipping(inserted));
  });

  fastify.delete('/clippings/:clippingId', async (request: FastifyRequest, reply: FastifyReply) => {
    const user = requireUser(request);
    const { clippingId } = request.params as { clippingId: string };
    const db = getDb();
    const row = (await db.select({ id: clippings.id, libraryId: clippings.libraryId, userId: clippings.userId }).from(clippings).where(eq(clippings.id, clippingId)).limit(1))[0];
    if (!row || row.userId !== user.id) throw new ApiError(404, 'Not Found', 'Clipping not found');
    await assertLibrary(user.id, row.libraryId);
    await db.delete(clippings).where(eq(clippings.id, clippingId));
    reply.send({ ok: true });
  });
}
