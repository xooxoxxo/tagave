/**
 * Press and hold with a finger: how a phone selects an item in a grid (as a
 * photo library does), since a touch screen has no hover to show a
 * checkbox and no Cmd-click. A hold of LONG_PRESS_MS that does not move
 * fires `onLong`; the click that follows the lift is swallowed, so the item
 * does not also open. A mouse or a pen is left alone.
 */
import { useEffect, useState } from 'react';

export const LONG_PRESS_MS = 450;
/** A finger that moves this far is scrolling, not holding. */
export const LONG_PRESS_SLOP_PX = 10;

type PointerLike = { pointerType: string; clientX: number; clientY: number };

export interface LongPressHandlers {
  onPointerDown: (e: PointerLike) => void;
  onPointerMove: (e: PointerLike) => void;
  onPointerUp: () => void;
  onPointerCancel: () => void;
  onContextMenu: (e: { preventDefault: () => void }) => void;
}

export interface LongPress {
  /** The handlers for one item; `onLong` runs when it is held. */
  bind: (onLong: () => void) => LongPressHandlers;
  /** The click after a hold: true once, so the caller skips opening the item. */
  consumeClick: () => boolean;
  /** Whether the last press was a finger (a tap toggles while albums are selected). */
  wasTouch: () => boolean;
  /** Drop a hold in progress. */
  cancel: () => void;
}

/** The long press itself, free of React (one press at a time across the items bound). */
export function createLongPress(vibrate: (ms: number) => void = (ms) => { globalThis.navigator?.vibrate?.(ms); }): LongPress {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let start: { x: number; y: number } | null = null;
  let fired = false;
  let touch = false;
  const cancel = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    start = null;
  };
  return {
    bind: (onLong) => ({
      onPointerDown: (e) => {
        touch = e.pointerType === 'touch';
        fired = false;
        cancel();
        if (!touch) return;
        start = { x: e.clientX, y: e.clientY };
        timer = setTimeout(() => {
          timer = null;
          fired = true;
          vibrate(10);
          onLong();
        }, LONG_PRESS_MS);
      },
      onPointerMove: (e) => {
        if (start && Math.hypot(e.clientX - start.x, e.clientY - start.y) > LONG_PRESS_SLOP_PX) cancel();
      },
      onPointerUp: cancel,
      onPointerCancel: cancel,
      // the browser's own long-press menu (copy, open in new tab) would cover the selection
      onContextMenu: (e) => { if (touch) e.preventDefault(); },
    }),
    consumeClick: () => {
      if (!fired) return false;
      fired = false;
      return true;
    },
    wasTouch: () => touch,
    cancel,
  };
}

export function useLongPress(): LongPress {
  const [press] = useState(createLongPress);
  useEffect(() => press.cancel, [press]);
  return press;
}
