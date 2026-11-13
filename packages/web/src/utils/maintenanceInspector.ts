/**
 * The Maintenance inspector's logic (the album page's sidebar on a desktop,
 * its sheet on a phone): which attention rows count as "to fix", the rows
 * that tick off when they are fixed or dismissed, and the progress meter.
 *
 * A row that leaves the album's attention list (fixed, dismissed, decided)
 * stays on screen ticked off, struck through, until the album is read again
 * once more: the owner sees it go instead of having it vanish under the
 * pointer. Pure functions; the page keeps the state.
 */
import type { AttentionItem, AttentionKind } from './albumAttention';

/** Rows that are for the record, not something to fix: they never count toward the meter. */
const RECORD_KINDS: ReadonlySet<AttentionKind> = new Set(['merged', 'tasks', 'hidden', 'task-done']);

/** Whether a row is something to fix (counts toward "1 of 3"). A request still running is not. */
export function countsToward(item: AttentionItem): boolean {
  return !RECORD_KINDS.has(item.kind) && item.tone !== 'live' && item.tone !== 'done';
}

export interface Tick {
  item: AttentionItem;
  /** where the row stood, so it ticks off in place */
  index: number;
  /** the album read (dataUpdatedAt) that no longer had it */
  version: number;
}

export interface TickState {
  /** the rows shown last time, in order */
  shown: readonly AttentionItem[];
  ticked: readonly Tick[];
  /** the album read the rows came from */
  version: number;
}

export const EMPTY_TICKS: TickState = { shown: [], ticked: [], version: 0 };

/**
 * The next tick state for a new list of rows. A row that was shown and is
 * gone ticks off; a ticked row leaves once a later read of the album comes
 * in; a ticked row that comes back is simply a row again.
 */
export function reconcileTicks(prev: TickState, items: readonly AttentionItem[], version: number): TickState {
  const ids = new Set(items.map((i) => i.id));
  const kept = prev.ticked.filter((t) => !ids.has(t.item.id) && t.version >= version);
  const keptIds = new Set(kept.map((t) => t.item.id));
  const fresh: Tick[] = [];
  prev.shown.forEach((item, index) => {
    if (ids.has(item.id) || keptIds.has(item.id)) return;
    // a request that was only running has nothing to tick off
    if (item.tone === 'live') return;
    fresh.push({ item, index, version });
  });
  return { shown: items, ticked: [...kept, ...fresh], version };
}

export interface InspectorRow {
  item: AttentionItem;
  ticked: boolean;
}

export interface FixMeter {
  /** ticked off on this visit */
  done: number;
  /** done plus what is left */
  total: number;
  /** still to fix */
  left: number;
}

/** The rows to show (ticked ones where they stood) and the meter. */
export function inspectorRows(items: readonly AttentionItem[], ticks: TickState): { rows: InspectorRow[]; meter: FixMeter } {
  const rows: InspectorRow[] = items.map((item) => ({ item, ticked: false }));
  const ids = new Set(items.map((i) => i.id));
  const ticked = ticks.ticked.filter((t) => !ids.has(t.item.id)).sort((a, b) => a.index - b.index);
  for (const t of ticked) rows.splice(Math.min(t.index, rows.length), 0, { item: t.item, ticked: true });
  const left = items.filter(countsToward).length;
  const done = ticked.filter((t) => countsToward(t.item)).length;
  return { rows, meter: { done, total: left + done, left } };
}

/** "1 of 3", or "Nothing to fix" when nothing is left. */
export function meterLabel(m: FixMeter): string {
  return m.left === 0 ? 'Nothing to fix' : `${m.done} of ${m.total}`;
}

/** The share of the meter filled, 0 to 1 (full when nothing is left). */
export function meterFill(m: FixMeter): number {
  if (m.left === 0) return 1;
  return m.total === 0 ? 0 : m.done / m.total;
}

/** The phone's one row: "To fix · 3", or "Maintenance" when nothing is left. */
export function summaryLabel(m: FixMeter): string {
  return m.left === 0 ? 'Maintenance' : `To fix · ${m.left}`;
}
