/**
 * The Physical collection's rows: the copies of one Discogs release are one
 * row ("2 copies"), not two identical lines (owner, 2026-10-28: two
 * Baroness rows, one with a Duplicate pill, "looks weird").
 */

export interface CopyLike {
  id: string;
  discogsReleaseId: number;
  /** set on an accidental extra copy: the copy it repeats */
  duplicateOf: string | null;
  pushState?: string | null;
}

export interface CopyGroup<T extends CopyLike> {
  /** the copy the row shows: the oldest that is not an accidental extra */
  lead: T;
  /** every copy of the release on this page, the lead first */
  copies: T[];
  /** accidental extra copies, newest last */
  extras: T[];
}

/**
 * One group per Discogs release, at its lead copy's place in the list. A record
 * waiting out its Undo (`hidden`) or on its way off Discogs is left out.
 */
export function groupCopies<T extends CopyLike>(items: readonly T[], hidden: ReadonlySet<string> = new Set()): CopyGroup<T>[] {
  const byRelease = new Map<number, T[]>();
  for (const item of items) {
    if (hidden.has(item.id) || item.pushState === 'removing') continue;
    const list = byRelease.get(item.discogsReleaseId);
    if (list) list.push(item);
    else byRelease.set(item.discogsReleaseId, [item]);
  }
  const groups = [...byRelease.values()].map((list) => {
    const lead = list.find((c) => !c.duplicateOf) ?? list[0]!;
    return { lead, copies: [lead, ...list.filter((c) => c !== lead)], extras: list.filter((c) => !!c.duplicateOf) };
  });
  // a row sits where its lead copy does, so removing the extra never moves it
  const at = new Map(items.map((item, i) => [item.id, i]));
  return groups.sort((a, b) => at.get(a.lead.id)! - at.get(b.lead.id)!);
}

/** "2×Vinyl, CD" → ["2×Vinyl", "CD"]: one marker per medium. */
export function mediaOf(format: string | null | undefined): string[] {
  return (format ?? '').split(',').map((s) => s.trim()).filter(Boolean);
}
