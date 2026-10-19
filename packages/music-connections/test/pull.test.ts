import { describe, it, expect, vi } from "vitest";
import { pull, NeedsReapproval, FeedTooLarge } from "../src/index.js";

const album = { rg_mbid: null, artist: "A", title: "B" };
const item = (k: string) => ({ key: k, op: "upsert", updated_at: "2026-10-15T10:00:00Z",
  data: { album, rating: 8, rating_raw: "4", scale: "0-5", favorite: false, rated_at: "2026-10-01T00:00:00Z" } });
const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

function deps(responses: Response[]) {
  const calls: string[] = [];
  return {
    calls,
    d: {
      fetch: vi.fn(async (u: string | URL) => { calls.push(String(u)); return responses.shift()!; }) as unknown as typeof fetch,
      getToken: async () => "tok",
      refreshToken: vi.fn(async () => "tok2"),
      sleep: vi.fn(async () => {}),
    },
  };
}

describe("pull", () => {
  it("follows pages until more=false and returns the last cursor", async () => {
    const { d, calls } = deps([json(200, { items: [item("a")], next: "c1", more: true }), json(200, { items: [item("b")], next: "c2", more: false })]);
    const got: string[] = [];
    const r = await pull({ url: "http://x/mc/v1/ratings", capability: "ratings", cursor: null, apply: async (it) => { got.push(...it.map((i) => i.key)); } }, d);
    expect(got).toEqual(["a", "b"]);
    expect(r).toMatchObject({ cursor: "c2", applied: 2, skipped: 0, resnapshot: false });
    expect(calls[1]).toContain("since=c1");
  });

  it("applies items with unknown extra fields and drops those fields", async () => {
    const extra = { ...item("a"), data: { ...item("a").data, future_field: "x" } };
    const { d } = deps([json(200, { items: [extra], next: "c1", more: false })]);
    const seen: unknown[] = [];
    const r = await pull({ url: "http://x/mc/v1/ratings", capability: "ratings", cursor: null, apply: async (it) => { seen.push(...it); } }, d);
    expect(r).toMatchObject({ applied: 1, skipped: 0 });
    expect(seen[0]).not.toHaveProperty("data.future_field");
    expect((seen[0] as { data: { rating: number } }).data.rating).toBe(8);
  });

  it("skips invalid items without failing the page", async () => {
    const bad = { key: "x", op: "upsert", updated_at: "2026-10-15T10:00:00Z", data: { nope: true } };
    const { d } = deps([json(200, { items: [item("a"), bad], next: "c1", more: false })]);
    const r = await pull({ url: "http://x/mc/v1/ratings", capability: "ratings", cursor: "c0", apply: async () => {} }, d);
    expect(r).toMatchObject({ applied: 1, skipped: 1, cursor: "c1" });
  });

  it("asks fetch never to follow redirects", async () => {
    const { d } = deps([json(200, { items: [], next: "c1", more: false })]);
    await pull({ url: "http://x/mc/v1/ratings", capability: "ratings", cursor: null, apply: async () => {} }, d);
    const init = (d.fetch as unknown as { mock: { calls: [unknown, RequestInit][] } }).mock.calls[0]?.[1];
    expect(init?.redirect).toBe("error");
  });

  it("refuses a 3xx a custom fetch hands back, without applying anything", async () => {
    const { d } = deps([new Response(null, { status: 302, headers: { location: "http://169.254.169.254/" } })]);
    const apply = vi.fn(async () => {});
    await expect(pull({ url: "http://x/mc/v1/ratings", capability: "ratings", cursor: null, apply }, d)).rejects.toThrow(/redirect/);
    expect(apply).not.toHaveBeenCalled();
  });

  it("refreshes once on 401, then gives NeedsReapproval if still 401", async () => {
    const { d } = deps([json(401, {}), json(401, {})]);
    await expect(pull({ url: "http://x/mc/v1/ratings", capability: "ratings", cursor: null, apply: async () => {} }, d)).rejects.toBeInstanceOf(NeedsReapproval);
    expect(d.refreshToken).toHaveBeenCalledTimes(1);
  });

  it("on 410 calls onResnapshot and restarts without a cursor", async () => {
    const { d, calls } = deps([json(410, {}), json(200, { items: [], next: "c9", more: false })]);
    const onResnapshot = vi.fn(async () => {});
    const r = await pull({ url: "http://x/mc/v1/ratings", capability: "ratings", cursor: "old", apply: async () => {}, onResnapshot }, d);
    expect(onResnapshot).toHaveBeenCalled();
    expect(calls[1]).not.toContain("since=");
    expect(r.resnapshot).toBe(true);
  });

  it("honours Retry-After on 429 then succeeds", async () => {
    const { d } = deps([json(429, {}, { "retry-after": "7" }), json(200, { items: [], next: "c1", more: false })]);
    await pull({ url: "http://x/mc/v1/ratings", capability: "ratings", cursor: null, apply: async () => {} }, d);
    expect(d.sleep).toHaveBeenCalledWith(7000);
  });

  it("refuses responses over 5 MB", async () => {
    const huge = new Response("x".repeat(5_000_001), { status: 200, headers: { "content-type": "application/json" } });
    const { d } = deps([huge]);
    await expect(pull({ url: "http://x/mc/v1/ratings", capability: "ratings", cursor: null, apply: async () => {} }, d)).rejects.toThrow(/too large/);
  });

  it("throws when more=true but the cursor does not advance", async () => {
    const page = () => json(200, { items: [item("a")], next: "c1", more: true });
    const { d, calls } = deps([page(), page(), page()]);
    await expect(pull({ url: "http://x/mc/v1/ratings", capability: "ratings", cursor: "c1", apply: async () => {} }, d)).rejects.toThrow("feed cursor did not advance");
    expect(calls.length).toBeLessThanOrEqual(2);
  });

  it("reports truncated when maxPages is reached with more pending", async () => {
    const { d } = deps([1, 2, 3].map((n) => json(200, { items: [], next: `c${n}`, more: true })));
    const r = await pull({ url: "http://x/mc/v1/ratings", capability: "ratings", cursor: null, maxPages: 2, apply: async () => {} }, d);
    expect(r).toMatchObject({ truncated: true, cursor: "c2" });
  });

  it("truncated is false on normal completion", async () => {
    const { d } = deps([json(200, { items: [], next: "c1", more: false })]);
    const r = await pull({ url: "http://x/mc/v1/ratings", capability: "ratings", cursor: null, apply: async () => {} }, d);
    expect(r.truncated).toBe(false);
  });

  it("rejects a non-object or items-less body cleanly", async () => {
    for (const body of [null, { items: "x", next: "c", more: false }]) {
      const { d } = deps([json(200, body)]);
      await expect(pull({ url: "http://x/mc/v1/ratings", capability: "ratings", cursor: null, apply: async () => {} }, d)).rejects.toThrow("invalid feed page");
    }
  });

  it("aborts a 6 MB streamed body past the cap without reading it all", async () => {
    const CHUNK = 64 * 1024;
    let produced = 0, cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(ctrl) {
        if (produced >= 6 * 1024 * 1024) { ctrl.close(); return; }
        produced += CHUNK;
        ctrl.enqueue(new Uint8Array(CHUNK).fill(0x20));
      },
      cancel() { cancelled = true; },
    }, { highWaterMark: 0 });
    const { d } = deps([new Response(stream, { status: 200, headers: { "content-type": "application/json" } })]);
    await expect(pull({ url: "http://x/mc/v1/ratings", capability: "ratings", cursor: null, apply: async () => {} }, d)).rejects.toBeInstanceOf(FeedTooLarge);
    expect(cancelled).toBe(true);
    expect(produced).toBeLessThan(5_000_000 + 4 * CHUNK);
  });

  it("rejects a declared content-length over the cap before reading", async () => {
    const res = json(200, { items: [], next: "c1", more: false }, { "content-length": "6000000" });
    const { d } = deps([res]);
    await expect(pull({ url: "http://x/mc/v1/ratings", capability: "ratings", cursor: null, apply: async () => {} }, d)).rejects.toThrow(/too large/);
  });

  it("calls onPage with each page's cursor after applying it", async () => {
    const { d } = deps([json(200, { items: [item("a")], next: "c1", more: true }), json(200, { items: [], next: "c2", more: false })]);
    const log: string[] = [];
    await pull({ url: "http://x/mc/v1/ratings", capability: "ratings", cursor: null,
      apply: async (it) => { log.push(`apply:${it.length}`); }, onPage: async (c) => { log.push(`page:${c}`); } }, d);
    expect(log).toEqual(["apply:1", "page:c1", "page:c2"]);
  });
});
