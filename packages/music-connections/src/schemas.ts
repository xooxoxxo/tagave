import { z } from "zod/v4";
import { isCapability, type Capability } from "./capabilities.js";
import { MAX_CURSOR_LENGTH, MAX_FEED_LIMIT, MAX_URL_LENGTH } from "./limits.js";

export const isHttpUrlOrPath = (u: string): boolean => {
  if (/^\/(?!\/)/.test(u)) {
    if (u.includes("\\")) return false;
    try {
      return new URL(u, "http://base.invalid").host === "base.invalid";
    } catch {
      return false;
    }
  }
  try {
    const url = new URL(u);
    return (url.protocol === "http:" || url.protocol === "https:") && url.host !== "";
  } catch {
    return false;
  }
};
const httpUrl = z.string().max(MAX_URL_LENGTH).refine(isHttpUrlOrPath, "http(s) URL with host, or absolute path only");
const iso = z.string().datetime({ offset: true });
const score10 = z.number().min(0).max(10);
const shortText = (n: number) => z.string().max(n);

export const AlbumRefSchema = z.object({
  rg_mbid: z.string().uuid().nullable(),
  release_mbid: z.string().uuid().optional(),
  discogs_master_id: z.number().int().optional(),
  discogs_release_id: z.number().int().optional(),
  artist: shortText(300),
  title: shortText(300),
});

const critic = z.object({
  album: AlbumRefSchema,
  aggregate: z.object({ score: score10.nullable(), tier: shortText(8).nullable(), review_count: z.number().int().min(0) }),
  reviews: z.array(z.object({ source: shortText(64), score: score10.nullable(), score_raw: shortText(60).nullable(),
    url: httpUrl, published_at: iso.nullable() })).max(200),
  critic_ratings: z.array(z.object({ outlet: shortText(120), score: score10.nullable(), score_raw: shortText(60) })).max(50),
});

const ratings = z.object({ album: AlbumRefSchema, rating: score10, rating_raw: shortText(16), scale: shortText(16),
  favorite: z.boolean(), rated_at: iso });

const collection = z.object({ album: AlbumRefSchema,
  formats: z.array(z.object({ kind: z.enum(["vinyl", "cd", "cassette", "digital", "other"]), detail: shortText(120).optional() })).min(1).max(50),
  acquired_at: iso.optional() });

const listens = z.object({ album: AlbumRefSchema, date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  count: z.number().int().min(1), formats: z.array(shortText(32)).max(10) });

const identity = z.object({ album: AlbumRefSchema, local_key: shortText(128),
  provenance: z.enum(["manual", "embedded", "auto"]), confidence: z.number().min(0).max(1) });

const wantlist = z.object({ album: AlbumRefSchema, reason: shortText(300), score: score10.nullable(), suggested_at: iso });

export const CAPABILITY_DATA: Record<Capability, z.ZodTypeAny> = {
  "critic-scores": critic, ratings, collection, listens, identity, "wantlist-suggestions": wantlist,
};

export const ManifestSchema = z.object({
  protocol: z.literal("music-connections/1"),
  service: shortText(64),
  version: shortText(32),
  auth: z.object({ authorize: httpUrl, token: httpUrl, register: httpUrl }),
  // Unknown capabilities are dropped before their values are validated.
  provides: z.record(z.string(), z.unknown()).transform((p, ctx) => {
    const out: Partial<Record<Capability, string>> = {};
    for (const [k, v] of Object.entries(p)) {
      if (!isCapability(k)) continue;
      const r = httpUrl.safeParse(v);
      if (!r.success) {
        ctx.addIssue({ code: "custom", message: `invalid URL for ${k}`, path: [k] });
        return z.NEVER;
      }
      out[k] = r.data;
    }
    return out;
  }),
  consumes: z.array(z.string()).max(50).transform((cs) => cs.filter(isCapability)),
});
export type Manifest = z.infer<typeof ManifestSchema>;

export const FeedPageSchema = <T extends z.ZodTypeAny>(data: T) => z.object({
  items: z.array(z.discriminatedUnion("op", [
    z.object({ key: shortText(256), op: z.literal("upsert"), updated_at: iso, data }),
    z.object({ key: shortText(256), op: z.literal("delete"), updated_at: iso, data: z.null() }),
  ])).max(MAX_FEED_LIMIT),
  next: z.string().max(MAX_CURSOR_LENGTH),
  more: z.boolean(),
});
