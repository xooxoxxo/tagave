import { MAX_CURSOR_ID_LENGTH, MAX_CURSOR_LENGTH, MAX_FEED_LIMIT, TOMBSTONE_DAYS } from "./limits.js";

export class CursorError extends Error {}
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/;
const ID = new RegExp(`^[A-Za-z0-9._:-]{1,${MAX_CURSOR_ID_LENGTH}}$`);

export type Cursor = { t: string; id: string };

export function encodeCursor(c: Cursor): string {
  return Buffer.from(JSON.stringify(c)).toString("base64url");
}
export function decodeCursor(s: string): Cursor {
  if (typeof s !== "string" || s.length > MAX_CURSOR_LENGTH) throw new CursorError("invalid cursor");
  try {
    const v = JSON.parse(Buffer.from(s, "base64url").toString("utf8"));
    if (
      typeof v?.t !== "string" || !ISO_UTC.test(v.t) || Number.isNaN(Date.parse(v.t)) ||
      typeof v?.id !== "string" || !ID.test(v.id)
    ) throw new Error();
    return { t: v.t, id: v.id };
  } catch {
    throw new CursorError("invalid cursor");
  }
}

/** A provider's change-log id shapes, for parseSince's `id` option. */
export const CURSOR_ID_BIGINT = /^\d{1,18}$/;
export const CURSOR_ID_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type SinceCheck = { ok: true; after: Cursor | null } | { ok: false; status: 400 | 410 };

/**
 * A feed request's `since`: absent or empty (a full snapshot), malformed
 * (400), or older than the tombstones (410). Beyond decodeCursor, the
 * timestamp must be a real calendar time (JS rolls 02-31 over to 03-03) and
 * the id must match the provider's log id shape (`id`), so nothing a client
 * made up reaches SQL.
 */
export function parseSince(
  since: unknown,
  opts: { id: RegExp; now?: number; tombstoneDays?: number },
): SinceCheck {
  if (since === undefined || since === "") return { ok: true, after: null };
  if (typeof since !== "string") return { ok: false, status: 400 };
  let c: Cursor;
  try {
    c = decodeCursor(since);
  } catch (e) {
    if (e instanceof CursorError) return { ok: false, status: 400 };
    throw e;
  }
  const ms = Date.parse(c.t);
  if (new Date(ms).toISOString().slice(0, 19) !== c.t.slice(0, 19) || !opts.id.test(c.id)) return { ok: false, status: 400 };
  if ((opts.now ?? Date.now()) - ms > (opts.tombstoneDays ?? TOMBSTONE_DAYS) * 86_400_000) return { ok: false, status: 410 };
  return { ok: true, after: c };
}

/** A feed request's `limit`: an integer clamped to 1..MAX_FEED_LIMIT; absent or not a number is MAX_FEED_LIMIT. */
export function feedLimit(raw: unknown): number {
  const n = Math.trunc(Number(raw ?? MAX_FEED_LIMIT));
  return Number.isFinite(n) ? Math.min(Math.max(n, 1), MAX_FEED_LIMIT) : MAX_FEED_LIMIT;
}
