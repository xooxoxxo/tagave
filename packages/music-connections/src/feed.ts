import { encodeCursor } from "./cursor.js";
export type ChangeRow<D> = { id: string; key: string; op: "upsert" | "delete"; changed_at: string; data: D | null };
export function buildFeedPage<D>(rows: ChangeRow<D>[], limit: number, prev = "") {
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return {
    items: page.map((r) => ({ key: r.key, op: r.op, updated_at: r.changed_at, data: r.op === "delete" ? null : r.data })),
    next: last ? encodeCursor({ t: last.changed_at, id: last.id }) : prev,
    more: rows.length > limit,
  };
}
