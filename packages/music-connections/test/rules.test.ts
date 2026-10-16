import { describe, expect, it } from "vitest";
import {
  CURSOR_ID_BIGINT, CURSOR_ID_UUID, MAX_CURSOR_LENGTH, MAX_FEED_LIMIT, MAX_TOKEN_LENGTH, LinkError, bearerToken, encodeCursor, feedLimit,
  isLookupLength, isPkceChallenge, isPkceVerifier, networkReason, parseSince, readCapped, userAgentFor,
} from "../src/index.js";

describe("parseSince", () => {
  const now = Date.parse("2026-10-16T00:00:00Z");
  const big = { id: CURSOR_ID_BIGINT, now };

  it("absent or empty is a full snapshot; a fresh cursor passes", () => {
    expect(parseSince(undefined, big)).toEqual({ ok: true, after: null });
    expect(parseSince("", big)).toEqual({ ok: true, after: null });
    const c = { t: "2026-10-15T10:00:00.123456Z", id: "42" };
    expect(parseSince(encodeCursor(c), big)).toEqual({ ok: true, after: c });
  });

  it("malformed, an impossible date, an id of the wrong shape or a non-string is 400", () => {
    expect(parseSince("%%%garbage", big)).toEqual({ ok: false, status: 400 });
    expect(parseSince(encodeCursor({ t: "2026-02-31T00:00:00Z", id: "1" }), big)).toEqual({ ok: false, status: 400 });
    expect(parseSince(encodeCursor({ t: "2026-10-15T00:00:00Z", id: "abc" }), big)).toEqual({ ok: false, status: 400 });
    expect(parseSince(["a"], big)).toEqual({ ok: false, status: 400 });
    expect(parseSince(null, big)).toEqual({ ok: false, status: 400 });
    expect(parseSince("a".repeat(MAX_CURSOR_LENGTH + 1), big)).toEqual({ ok: false, status: 400 });
  });

  it("older than the tombstones is 410", () => {
    expect(parseSince(encodeCursor({ t: "2026-07-01T00:00:00Z", id: "1" }), big)).toEqual({ ok: false, status: 410 });
    expect(parseSince(encodeCursor({ t: "2026-07-01T00:00:00Z", id: "1" }), { ...big, tombstoneDays: 200 }).ok).toBe(true);
  });

  it("a uuid log takes uuid ids only", () => {
    const uuid = { id: CURSOR_ID_UUID, now };
    expect(parseSince(encodeCursor({ t: "2026-10-15T00:00:00Z", id: "11111111-2222-4333-8444-555555555555" }), uuid).ok).toBe(true);
    expect(parseSince(encodeCursor({ t: "2026-10-15T00:00:00Z", id: "42" }), uuid)).toEqual({ ok: false, status: 400 });
  });
});

describe("feedLimit", () => {
  it("clamps to 1..MAX_FEED_LIMIT, absent or not a number is the maximum", () => {
    expect(feedLimit(undefined)).toBe(MAX_FEED_LIMIT);
    expect(feedLimit("abc")).toBe(MAX_FEED_LIMIT);
    expect(feedLimit("10")).toBe(10);
    expect(feedLimit("10.9")).toBe(10);
    expect(feedLimit("0")).toBe(1);
    expect(feedLimit("-5")).toBe(1);
    expect(feedLimit("100000")).toBe(MAX_FEED_LIMIT);
  });
});

describe("token-shaped input", () => {
  it("bearerToken takes exactly one token", () => {
    expect(bearerToken("Bearer abc")).toBe("abc");
    expect(bearerToken("bearer abc  ")).toBe("abc");
    expect(bearerToken("Bearer a b")).toBe("");
    expect(bearerToken("Basic abc")).toBe("");
    expect(bearerToken("Bearer ")).toBe("");
    expect(bearerToken(undefined)).toBe("");
  });

  it("PKCE S256 shapes", () => {
    expect(isPkceChallenge("a".repeat(43))).toBe(true);
    expect(isPkceChallenge("a".repeat(44))).toBe(false);
    expect(isPkceChallenge("short")).toBe(false);
    expect(isPkceVerifier("a~._-".repeat(9))).toBe(true);
    expect(isPkceVerifier("a".repeat(42))).toBe(false);
    expect(isPkceVerifier("a".repeat(129))).toBe(false);
    expect(isPkceVerifier("a".repeat(42) + "+")).toBe(false);
  });

  it("lookup length", () => {
    expect(isLookupLength("x".repeat(MAX_TOKEN_LENGTH))).toBe(true);
    expect(isLookupLength("x".repeat(MAX_TOKEN_LENGTH + 1))).toBe(false);
    expect(isLookupLength("")).toBe(false);
    expect(isLookupLength("x".repeat(101), 100)).toBe(false);
  });

  it("the user agent names the protocol", () => {
    expect(userAgentFor("tagave", "1.2.3")).toBe("tagave/1.2.3 (music-connections/1)");
  });
});

describe("readCapped", () => {
  const big = "x".repeat(70_000);

  it("refuses a body over the cap, by its length or by what arrives", async () => {
    await expect(readCapped(new Response(big, { headers: { "content-length": String(big.length) } }), 64 * 1024)).rejects.toThrow("response too large");
    const stream = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(big)); c.close(); } });
    await expect(readCapped(new Response(stream), 64 * 1024)).rejects.toThrow("response too large");
    expect(await readCapped(new Response("{}"), 64 * 1024)).toBe("{}");
    expect(await readCapped(new Response(null), 10)).toBe("");
  });

  it("a body that breaks off is a LinkError", async () => {
    const stream = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode("{\"pro")); c.error(new Error("reset")); } });
    await expect(readCapped(new Response(stream), 1024)).rejects.toBeInstanceOf(LinkError);
  });

  it("keeps multi-byte characters split across chunks", async () => {
    const bytes = new TextEncoder().encode("é");
    const stream = new ReadableStream({ start(c) { c.enqueue(bytes.slice(0, 1)); c.enqueue(bytes.slice(1)); c.close(); } });
    expect(await readCapped(new Response(stream), 10)).toBe("é");
  });
});

describe("networkReason", () => {
  it("fixed strings only", () => {
    expect(networkReason(new LinkError("redirect refused"), "x")).toBe("redirect refused");
    expect(networkReason(Object.assign(new Error("t"), { name: "TimeoutError" }), "x")).toBe("remote timed out");
    expect(networkReason(new TypeError("fetch failed: secret"), "x")).toBe("remote unreachable");
    expect(networkReason(new Error("token=abc"), "fallback")).toBe("fallback");
    expect(networkReason("nope", "fallback")).toBe("fallback");
  });
});
