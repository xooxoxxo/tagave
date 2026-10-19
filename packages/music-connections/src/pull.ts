import { CAPABILITY_DATA, FeedPageSchema } from "./schemas.js";
import type { Capability } from "./capabilities.js";
import { MAX_FEED_LIMIT, MAX_FEED_PAGE_BYTES } from "./limits.js";

export class NeedsReapproval extends Error {}
/** A feed page exceeded the byte cap; the body was not fully read. */
export class FeedTooLarge extends Error {
  constructor(readonly limit: number) { super("feed page too large"); }
}
export type FeedItem = { key: string; op: "upsert" | "delete"; updated_at: string; data: unknown };
export type PullDeps = { fetch: typeof fetch; getToken(): Promise<string>; refreshToken(): Promise<string>; sleep(ms: number): Promise<void> };
export type PullResult = { cursor: string; applied: number; skipped: number; resnapshot: boolean; truncated: boolean };

/** Read a response body incrementally, aborting as soon as it exceeds `max` bytes. */
async function readCappedText(res: Response, max: number): Promise<string> {
  const declared = Number(res.headers.get("content-length") ?? 0);
  if (Number.isFinite(declared) && declared > max) { await res.body?.cancel().catch(() => {}); throw new FeedTooLarge(max); }
  if (!res.body) return "";
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let total = 0, text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) { await reader.cancel().catch(() => {}); throw new FeedTooLarge(max); }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

async function readJson(res: Response): Promise<unknown> {
  const text = await readCappedText(res, MAX_FEED_PAGE_BYTES);
  try { return JSON.parse(text); } catch { throw new Error("invalid feed page"); }
}

export async function pull(
  opts: { url: string; capability: Capability; cursor: string | null; limit?: number; maxPages?: number;
          apply(items: FeedItem[]): Promise<void>; onResnapshot?(): Promise<void>;
          /** Called after each page is applied, with the cursor to resume from. */
          onPage?(cursor: string): Promise<void> },
  deps: PullDeps,
): Promise<PullResult> {
  const envelope = FeedPageSchema(CAPABILITY_DATA[opts.capability]);
  const itemShape = envelope.shape.items.element;
  let cursor = opts.cursor;
  let token = await deps.getToken();
  let refreshed = false, resnapshot = false, applied = 0, skipped = 0, pages = 0, rateWaits = 0, truncated = false;

  for (;;) {
    if (++pages > (opts.maxPages ?? 1000)) { truncated = true; break; }
    const u = new URL(opts.url);
    u.searchParams.set("limit", String(opts.limit ?? MAX_FEED_LIMIT));
    if (cursor) u.searchParams.set("since", cursor);
    // Never follow a redirect: a 3xx could send the bearer token, or the request
    // itself, to another host. "error" makes a standard fetch reject; the status
    // check covers a custom fetch that hands back the 3xx instead.
    const res = await deps.fetch(u, { redirect: "error", headers: { authorization: `Bearer ${token}`, accept: "application/json" } });
    if (res.status >= 300 && res.status < 400) throw new Error(`remote redirected (${res.status}); redirects are not followed`);

    if (res.status === 401) {
      if (refreshed) throw new NeedsReapproval("token rejected after refresh");
      try { token = await deps.refreshToken(); } catch { throw new NeedsReapproval("refresh failed"); }
      refreshed = true; pages--; continue;
    }
    if (res.status === 410) {
      if (resnapshot) throw new Error("410 on snapshot");
      await opts.onResnapshot?.();
      resnapshot = true; cursor = null; pages--; continue;
    }
    if (res.status === 429 || res.status === 503) {
      if (++rateWaits > 5) throw new Error(`remote busy (${res.status})`);
      const ra = Number(res.headers.get("retry-after"));
      await deps.sleep(Number.isFinite(ra) && ra > 0 ? Math.min(ra, 600) * 1000 : 30_000);
      pages--; continue;
    }
    if (!res.ok) throw new Error(`feed HTTP ${res.status}`);

    const parsed = await readJson(res);
    if (typeof parsed !== "object" || parsed === null || !Array.isArray((parsed as { items?: unknown }).items)) {
      throw new Error("invalid feed page");
    }
    const body = parsed as { items: unknown[]; next?: string; more?: boolean };
    const good: FeedItem[] = [];
    for (const raw of body.items) {
      const p = itemShape.safeParse(raw);
      if (p.success) good.push(p.data as FeedItem); else skipped++;
    }
    if (good.length) await opts.apply(good);
    applied += good.length;
    if (typeof body.next !== "string") throw new Error("feed page without next cursor");
    if (body.more && (body.next === "" || body.next === cursor)) throw new Error("feed cursor did not advance");
    cursor = body.next;
    await opts.onPage?.(cursor);
    if (!body.more) break;
  }
  return { cursor: cursor ?? "", applied, skipped, resnapshot, truncated };
}
