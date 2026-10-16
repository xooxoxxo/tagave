import { describe, it, expect } from "vitest";
import { runConformance, buildFeedPage, decodeCursor, CursorError, capabilityJsonSchema } from "../src/index.js";

const album = { rg_mbid: null, artist: "A", title: "B" };
const rows = [1, 2, 3].map((n) => ({ id: `i${n}`, key: `k${n}`, op: "upsert" as const, changed_at: `2026-10-15T10:00:0${n}.000Z`,
  data: { album, rating: 8, rating_raw: "4", scale: "0-5", favorite: false, rated_at: "2026-10-01T00:00:00Z" } }));

function fakeServer({ enforceAuth }: { enforceAuth: boolean }): typeof fetch {
  return (async (input: string | URL, init?: RequestInit) => {
    const u = new URL(String(input));
    const j = (s: number, b: unknown) => new Response(JSON.stringify(b), { status: s, headers: { "content-type": "application/json" } });
    if (u.pathname === "/.well-known/music-connections")
      return j(200, { protocol: "music-connections/1", service: "fake", version: "1", auth: { authorize: "/a", token: "/t", register: "/r" },
        provides: { ratings: "/mc/v1/ratings" }, consumes: [] });
    if (u.pathname === "/mc/v1/schema/ratings.json") return j(200, capabilityJsonSchema("ratings"));
    if (u.pathname === "/mc/v1/ratings") {
      const auth = new Headers(init?.headers).get("authorization");
      if (enforceAuth && auth !== "Bearer good") return j(401, {});
      const since = u.searchParams.get("since");
      let start = 0;
      if (since) { try { const c = decodeCursor(since); start = rows.findIndex((r) => r.id === c.id) + 1; } catch (e) { if (e instanceof CursorError) return j(400, {}); throw e; } }
      const limit = Number(u.searchParams.get("limit") ?? 2);
      return j(200, buildFeedPage(rows.slice(start, start + limit + 1), limit));
    }
    return j(404, {});
  }) as typeof fetch;
}

describe("runConformance", () => {
  it("passes a correct server", async () => {
    const r = await runConformance({ baseUrl: "http://fake", token: "good", fetch: fakeServer({ enforceAuth: true }) });
    expect(r.failures).toEqual([]);
    expect(r.ok).toBe(true);
  });
  it("flags a feed that answers without a token", async () => {
    const r = await runConformance({ baseUrl: "http://fake", token: "good", fetch: fakeServer({ enforceAuth: false }) });
    expect(r.ok).toBe(false);
    expect(r.failures.join("\n")).toMatch(/401/);
  });
});

type Over = { page?: (u: URL) => Response | undefined; schema?: () => Response };
function badServer(over: Over): typeof fetch {
  const good = fakeServer({ enforceAuth: true });
  return (async (input: string | URL, init?: RequestInit) => {
    const u = new URL(String(input));
    if (u.pathname === "/mc/v1/schema/ratings.json" && over.schema) return over.schema();
    if (u.pathname === "/mc/v1/ratings" && over.page) {
      const r = over.page(u);
      if (r) return r;
    }
    return good(input, init);
  }) as typeof fetch;
}
const jr = (s: number, b: unknown) => new Response(JSON.stringify(b), { status: s, headers: { "content-type": "application/json" } });

describe("runConformance negatives", () => {
  it("fails a stuck next cursor", async () => {
    const stuck = (u: URL) => (u.searchParams.get("since")?.startsWith("%%%") ? undefined
      : jr(200, { items: [], next: "eyJ0IjoiMjAyNi0xMC0xNVQxMDowMDowMS4wMDBaIiwiaWQiOiJpMSJ9", more: true }));
    const r = await runConformance({ baseUrl: "http://fake", token: "good", fetch: badServer({ page: stuck }) });
    expect(r.ok).toBe(false);
    expect(r.failures.join("\n")).toMatch(/advance/);
  });
  it("fails a 200 for an invalid cursor", async () => {
    const r = await runConformance({ baseUrl: "http://fake", token: "good",
      fetch: badServer({ page: (u) => (u.searchParams.get("since")?.startsWith("%%%") ? jr(200, { items: [], next: "", more: false }) : undefined) }) });
    expect(r.failures.join("\n")).toMatch(/400/);
  });
  it.each([["html", () => new Response("<html></html>", { status: 200 })], ["null", () => jr(200, null)], ["array", () => jr(200, [])]])(
    "fails a %s schema endpoint", async (_n, schema) => {
      const r = await runConformance({ baseUrl: "http://fake", token: "good", fetch: badServer({ schema }) });
      expect(r.ok).toBe(false);
      expect(r.failures.join("\n")).toMatch(/schema/);
    });
});
