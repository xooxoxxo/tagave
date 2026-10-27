/**
 * Reordering a list by its handles: drag with a mouse, a finger or a pen
 * (pointer events, so it works on a phone), or press Arrow up / Arrow down
 * on a handle. The row follows the pointer; where it will land shows as a
 * line. `canMove(i)` says which rows move (the queue: only what is still to
 * come); a row lands only between movable rows.
 */
import { useCallback, useRef, useState, type KeyboardEvent, type PointerEvent, type RefObject } from 'react';

export interface DragState {
  from: number;
  /** where it would land */
  to: number;
  /** pixels the row has moved */
  dy: number;
}

export function useDragReorder(opts: { list: RefObject<HTMLElement | null>; canMove: (i: number) => boolean; onMove: (from: number, to: number) => void }) {
  const [drag, setDrag] = useState<DragState | null>(null);
  const start = useRef<{ y: number; mids: number[]; from: number } | null>(null);
  const latest = useRef<DragState | null>(null);
  const show = (d: DragState) => { latest.current = d; setDrag(d); };
  const { list, canMove, onMove } = opts;

  const rows = () => [...(list.current?.querySelectorAll<HTMLElement>('[data-drag-row]') ?? [])];

  const onPointerDown = useCallback((i: number) => (e: PointerEvent<HTMLElement>) => {
    if (!canMove(i) || (e.pointerType === 'mouse' && e.button !== 0)) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    const mids = rows().map((r) => { const b = r.getBoundingClientRect(); return b.top + b.height / 2; });
    start.current = { y: e.clientY, mids, from: i };
    show({ from: i, to: i, dy: 0 });
  }, [canMove]);

  const onPointerMove = useCallback((e: PointerEvent<HTMLElement>) => {
    const s = start.current;
    if (!s) return;
    const dy = e.clientY - s.y;
    const y = s.mids[s.from]! + dy;
    let to = s.from;
    for (let j = 0; j < s.mids.length; j++) {
      if (j === s.from || !canMove(j)) continue;
      if (j > s.from && y > s.mids[j]!) to = Math.max(to, j);
      if (j < s.from && y < s.mids[j]!) to = Math.min(to, j);
    }
    show({ from: s.from, to, dy });
  }, [canMove]);

  const finish = useCallback((commit: boolean) => () => {
    const s = start.current;
    start.current = null;
    const d = latest.current;
    latest.current = null;
    setDrag(null);
    if (commit && s && d && d.to !== d.from) onMove(d.from, d.to);
  }, [onMove]);

  const onKeyDown = useCallback((i: number) => (e: KeyboardEvent<HTMLElement>) => {
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    const to = e.key === 'ArrowUp' ? i - 1 : i + 1;
    if (to < 0 || !canMove(i) || !canMove(to)) return;
    e.preventDefault();
    onMove(i, to);
    // keep the keyboard on the moved row's handle
    requestAnimationFrame(() => rows()[to]?.querySelector<HTMLElement>('[data-drag-handle]')?.focus());
  }, [canMove, onMove]);

  /** Props for row `i`'s handle. */
  const handle = (i: number) => ({
    'data-drag-handle': '',
    onPointerDown: onPointerDown(i),
    onPointerMove,
    onPointerUp: finish(true),
    onPointerCancel: finish(false),
    onKeyDown: onKeyDown(i),
  });

  return { drag, handle };
}
