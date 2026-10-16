/**
 * facets.get for the api (Facets and Connectors design §4, §9): tagave's
 * registry with the providers' readers. A reader reads only its own
 * module's tables; another module reads them only through here.
 *
 *   album.critic-scores@1    reviews: CritiqueBrainz ratings (external_reviews)
 *                            mc: what each linked app sent (mc_critic_scores), the caller's own links
 *   album.wantlist-suggestion@1  mc: mc_wantlist_suggestions, the caller's own
 */
import type postgres from 'postgres';
import { createFacets, registry, type FacetContext, type FacetReader, type FacetValue } from '@tagave/core/facets';
import { mcEnabled } from '@tagave/db';
import type { CriticScore } from '@tagave/shared';

type Sql = postgres.Sql;

const jsonOf = <T>(v: unknown): T => (typeof v === 'string' ? JSON.parse(v) : v) as T;
const iso = (d: Date | string | null): string | null => (d === null ? null : d instanceof Date ? d.toISOString() : new Date(d).toISOString());

function readers(sql: Sql): Record<string, Partial<Record<string, FacetReader>>> {
  return {
    reviews: {
      // CritiqueBrainz's rating of the album (its text stays in the panel's own section)
      'album.critic-scores@1': async (entities) => {
        const ids = entities.map((e) => e.id);
        const rows = await sql<Array<{ rg: string; rating_normalized: number | null; url: string | null; published_at: Date | null; fetched_at: Date | null }>>`
          select release_group_id::text as rg, rating_normalized, url, published_at, fetched_at from external_reviews
           where release_group_id = any(${ids}::uuid[]) and source = 'critiquebrainz' and rating_normalized is not null
           order by published_at desc nulls last, id`;
        const out = new Map<string, FacetValue[]>();
        for (const r of rows) {
          const score = Math.round(r.rating_normalized!) / 10;
          const list = out.get(r.rg) ?? [];
          list.push({
            source: { module: 'reviews', ref: null, label: 'CritiqueBrainz' },
            data: {
              aggregate: { score, tier: null, review_count: 1 },
              reviews: r.url ? [{ source: 'CritiqueBrainz', score, score_raw: `${r.rating_normalized}/100`, url: r.url, published_at: iso(r.published_at) }] : [],
              critic_ratings: [],
            },
            updatedAt: iso(r.fetched_at),
          });
          out.set(r.rg, list);
        }
        return out;
      },
    },
    mc: {
      'album.critic-scores@1': async (entities, scope) => {
        const out = new Map<string, FacetValue[]>();
        if (scope.scope !== 'person') return out;
        const rows = await sql<Array<{ rg: string; link_id: string; service: string | null; data: unknown; updated_at: Date }>>`
          select s.release_group_id::text as rg, s.link_id::text as link_id, l.manifest->>'service' as service, s.data, s.updated_at
            from mc_critic_scores s join mc_links l on l.id = s.link_id
           where s.user_id = ${scope.userId} and s.release_group_id = any(${entities.map((e) => e.id)}::uuid[]) and l.state <> 'revoked'
           order by l.created_at, s.key`;
        for (const r of rows) {
          const list = out.get(r.rg) ?? [];
          list.push({ source: { module: 'mc', ref: r.link_id, label: r.service || 'a linked app' }, data: jsonOf(r.data), updatedAt: iso(r.updated_at) });
          out.set(r.rg, list);
        }
        return out;
      },
    },
  };
}

/** The caller's view: the module switches, their library and person. */
export async function facetContext(sql: Sql, who: { userId: string | null; libraryId: string | null }): Promise<FacetContext> {
  return {
    settings: { mcEnabled: await mcEnabled(sql) },
    playerUrl: process.env['TAGAVE_PLAYER_URL'] || null,
    libraryId: who.libraryId,
    userId: who.userId,
  };
}

export function apiFacets(sql: Sql) {
  return createFacets(registry, readers(sql));
}

type CriticData = {
  aggregate?: { score: number | null; tier: string | null; review_count: number };
  reviews?: Array<{ source: string; score: number | null; score_raw: string | null; url: string; published_at: string | null }>;
  critic_ratings?: Array<{ outlet: string; score: number | null; score_raw: string }>;
};

/** Only http(s) URLs reach the page (a stored one was checked on landing; this is the last guard). */
const httpOnly = (u: string | null | undefined): string | null => {
  if (!u) return null;
  try {
    const p = new URL(u).protocol;
    return p === 'http:' || p === 'https:' ? u : null;
  } catch {
    return null;
  }
};

/**
 * A facet value as the review panel shows it: each review labelled with
 * where it came from ("Pitchfork (via review-gatherer)").
 */
export function criticScoreView(v: FacetValue): CriticScore {
  const d = (v.data ?? {}) as CriticData;
  const via = (name: string) => (v.source.module === 'mc' ? `${name} (via ${v.source.label})` : name);
  return {
    source: { module: v.source.module, ref: v.source.ref, label: v.source.label },
    aggregate: d.aggregate ? { score: d.aggregate.score, tier: d.aggregate.tier, reviewCount: d.aggregate.review_count } : null,
    reviews: (d.reviews ?? []).map((r) => ({ label: via(r.source), score: r.score, scoreRaw: r.score_raw, url: httpOnly(r.url), publishedAt: r.published_at })),
    criticRatings: (d.critic_ratings ?? []).map((r) => ({ label: via(r.outlet), score: r.score, scoreRaw: r.score_raw })),
    updatedAt: v.updatedAt,
  };
}

/** The album's critic scores for the review panel. */
export async function criticScoresFor(sql: Sql, who: { userId: string; libraryId: string }, releaseGroupId: string): Promise<{ available: boolean; values: CriticScore[] }> {
  const ctx = await facetContext(sql, who);
  const r = await apiFacets(sql).get(ctx, { kind: 'album', id: releaseGroupId }, 'album.critic-scores@1');
  return { available: r.available, values: r.values.map(criticScoreView) };
}
