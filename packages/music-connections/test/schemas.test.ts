import { describe, it, expect } from "vitest";
import { CAPABILITIES, readScope, ManifestSchema, FeedPageSchema, CAPABILITY_DATA, capabilityJsonSchema } from "../src/index.js";

const album = { rg_mbid: "0c9b6a3e-2f4f-4f0e-9b8e-1d2c3b4a5f60", artist: "Opeth", title: "Blackwater Park" };

describe("schemas", () => {
  it("lists the six v1 capabilities", () => {
    expect(CAPABILITIES).toEqual(["critic-scores", "ratings", "collection", "listens", "identity", "wantlist-suggestions"]);
    expect(readScope("ratings")).toBe("ratings:read");
  });

  it("accepts a valid manifest and ignores unknown capabilities", () => {
    const m = ManifestSchema.parse({
      protocol: "music-connections/1", service: "x", version: "1",
      auth: { authorize: "/a", token: "/t", register: "/r" },
      provides: { "critic-scores": "/mc/v1/critic-scores", "future-thing": "/mc/v1/future" },
      consumes: ["ratings", "telepathy"],
    });
    expect(Object.keys(m.provides)).toEqual(["critic-scores"]);
    expect(m.consumes).toEqual(["ratings"]);
  });

  it("rejects a manifest with a non-http provides URL or wrong protocol", () => {
    const base = { service: "x", version: "1", auth: { authorize: "/a", token: "/t", register: "/r" }, consumes: [] };
    expect(() => ManifestSchema.parse({ ...base, protocol: "music-connections/1", provides: { "critic-scores": "javascript:alert(1)" } })).toThrow();
    expect(() => ManifestSchema.parse({ ...base, protocol: "music-connections/2", provides: {} })).toThrow();
  });

  it("rejects unsafe URLs and accepts paths and http(s) URLs", () => {
    const mk = (u: string) => ({ protocol: "music-connections/1", service: "x", version: "1",
      auth: { authorize: "/a", token: "/t", register: "/r" }, provides: { ratings: u }, consumes: [] });
    for (const bad of ["//evil.example/x", "/\\evil.example/x", "/\\\\evil.example", "http://", "javascript:alert(1)", "ftp://x/y"])
      expect(() => ManifestSchema.parse(mk(bad)), bad).toThrow();
    for (const ok of ["/mc/v1/ratings", "https://host/x"])
      expect(ManifestSchema.parse(mk(ok)).provides.ratings).toBe(ok);
  });

  it("ignores unknown capabilities with invalid values but rejects known ones", () => {
    const mk = (provides: Record<string, unknown>) => ({ protocol: "music-connections/1", service: "x", version: "1",
      auth: { authorize: "/a", token: "/t", register: "/r" }, provides, consumes: [] });
    const m = ManifestSchema.parse(mk({ "future-thing": 42, ratings: "/mc/v1/ratings" }));
    expect(m.provides).toEqual({ ratings: "/mc/v1/ratings" });
    expect(() => ManifestSchema.parse(mk({ ratings: 42 }))).toThrow();
  });

  it("validates critic-scores data and strips prose fields", () => {
    const data = { album, aggregate: { score: 8.6, tier: "A", review_count: 5 },
      reviews: [{ source: "angry-metal-guy", score: 8, score_raw: "4.0/5.0", url: "https://www.angrymetalguy.com/x-review/", published_at: "2026-01-01T00:00:00Z" }],
      critic_ratings: [{ outlet: "Metacritic", score: 8.8, score_raw: "88/100" }] };
    expect(CAPABILITY_DATA["critic-scores"].parse(data)).toBeTruthy();
    const withText = { ...data, reviews: [{ ...data.reviews[0], body: "long prose" }] };
    const out = CAPABILITY_DATA["critic-scores"].parse(withText) as { reviews: Record<string, unknown>[] };
    expect(out.reviews[0]).not.toHaveProperty("body");
    expect(out.reviews[0]!.source).toBe("angry-metal-guy");
  });

  it("validates a feed page envelope", () => {
    const page = FeedPageSchema(CAPABILITY_DATA.ratings).parse({
      items: [{ key: "k1", op: "upsert", updated_at: "2026-10-15T10:00:00Z",
        data: { album, rating: 9, rating_raw: "4.5", scale: "0-5", favorite: false, rated_at: "2026-10-01T00:00:00Z" } },
        { key: "k2", op: "delete", updated_at: "2026-10-15T10:00:01Z", data: null }],
      next: "c2", more: false });
    expect(page.items).toHaveLength(2);
  });

  it("exports JSON Schema for every capability", () => {
    for (const c of CAPABILITIES) expect(capabilityJsonSchema(c)).toHaveProperty("type", "object");
  });
});
