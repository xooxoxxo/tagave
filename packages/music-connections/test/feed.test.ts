import { describe, it, expect } from "vitest";
import { encodeCursor, decodeCursor, CursorError, buildFeedPage } from "../src/index.js";

const row = (n: number, op: "upsert" | "delete" = "upsert") => ({
  id: `id${n}`, key: `k${n}`, op, changed_at: `2026-10-15T10:00:0${n}.000Z`, data: op === "delete" ? null : { n },
});

describe("cursor", () => {
  it("round-trips", () => {
    const c = { t: "2026-10-15T10:00:00.000Z", id: "abc" };
    expect(decodeCursor(encodeCursor(c))).toEqual(c);
  });
  it("rejects tampered or garbage cursors with CursorError", () => {
    expect(() => decodeCursor("not-base64-!!")).toThrow(CursorError);
    expect(() => decodeCursor(Buffer.from('{"t":1}').toString("base64url"))).toThrow(CursorError);
  });
  it("rejects hostile t/id values and oversized cursors", () => {
    const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const t = "2026-10-15T10:00:00.000Z";
    for (const bad of ["1", "2026", "2026-10-15 10:00:00", "2026-10-15T10:00:00+02:00"]) {
      expect(() => decodeCursor(enc({ t: bad, id: "a" }))).toThrow(CursorError);
    }
    for (const id of ["", "a'; drop table x;--", "a".repeat(201)]) {
      expect(() => decodeCursor(enc({ t, id }))).toThrow(CursorError);
    }
    expect(() => decodeCursor("A".repeat(600))).toThrow(CursorError);
  });
  it("round-trips microsecond timestamps", () => {
    const c = { t: "2026-10-15T10:00:00.123456Z", id: "abc" };
    expect(decodeCursor(encodeCursor(c))).toEqual(c);
  });
});

describe("buildFeedPage", () => {
  it("pages with more=true when limit+1 rows came back", () => {
    const p = buildFeedPage([row(1), row(2), row(3)], 2);
    expect(p.items.map((i) => i.key)).toEqual(["k1", "k2"]);
    expect(p.more).toBe(true);
    expect(decodeCursor(p.next)).toEqual({ t: row(2).changed_at, id: "id2" });
  });
  it("emits tombstones with data null", () => {
    const p = buildFeedPage([row(1, "delete")], 10);
    expect(p.items[0]).toEqual({ key: "k1", op: "delete", updated_at: row(1).changed_at, data: null });
    expect(p.more).toBe(false);
  });
  it("keeps the previous cursor when the page is empty", () => {
    const prev = encodeCursor({ t: "2026-10-15T09:00:00.000Z", id: "z" });
    expect(buildFeedPage([], 10, prev)).toEqual({ items: [], next: prev, more: false });
  });
});
