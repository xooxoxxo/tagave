/**
 * Back keeps your place (owner, 2026-11-04: "when we go inside an artist or
 * an album and come back, the scroll location ... is not preserved").
 *
 * Filters, sort, view and the letter live in each list's URL, so Back
 * brings them back by itself. The scroll offset cannot: it is kept here,
 * per history entry — the entry's position in the tab's history (the
 * router's `__TSR_index`, which a replace keeps) and its path — so browser
 * Back, the app's back key and a phone's swipe-back all land where the list
 * was left, and the same list opened afresh from the menu starts at the top.
 * A new entry (a push) forgets every place at or after its position: that
 * part of the history is gone.
 *
 * The places are mirrored to sessionStorage, so a reload of the tab keeps
 * them too. A virtualised list grows as it is scrolled (pages load as the
 * end comes into view), so a restore keeps setting the offset frame after
 * frame until it holds, the content ends short of it, or the person scrolls.
 */
import { useLayoutEffect, useRef } from 'react';

const STORAGE_KEY = 'tagave.places';
/** A restore that has not landed by then stops where it is. */
export const RESTORE_GIVE_UP_MS = 8000;
/** Frames the offset must hold before a restore counts as done. */
const SETTLE_FRAMES = 3;
/** Frames short of the offset, the content not growing, before a restore stops there. */
const FLAT_FRAMES = 240;
const STOP_EVENTS = ['wheel', 'touchstart', 'pointerdown', 'keydown'] as const;

type Places = Record<string, number>;

function load(): Places {
  try {
    const raw = globalThis.sessionStorage?.getItem(STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    if (!parsed || typeof parsed !== 'object') return {};
    return Object.fromEntries(Object.entries(parsed as Record<string, unknown>).filter(([, v]) => typeof v === 'number')) as Places;
  } catch {
    return {};
  }
}

let places: Places = load();
let saveTimer: ReturnType<typeof setTimeout> | null = null;

function persistSoon() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      globalThis.sessionStorage?.setItem(STORAGE_KEY, JSON.stringify(places));
    } catch {
      /* private window or blocked storage: places last for this page view */
    }
  }, 250);
}

/** The key of one scroller on one history entry. */
export function placeKey(index: number, pathname: string, id: string): string {
  const path = pathname.replace(/\/+$/, '') || '/';
  return `${index}|${path}|${id}`;
}

export function readPlace(key: string): number | null {
  const v = places[key];
  return typeof v === 'number' && v > 0 ? v : null;
}

export function savePlace(key: string, top: number): void {
  const v = Math.max(0, Math.round(top));
  if (places[key] === v) return;
  if (v === 0) delete places[key];
  else places[key] = v;
  persistSoon();
}

/** A new history entry at `index`: the entries it replaces (that index and later) lose their places. */
export function forgetFrom(index: number): void {
  let changed = false;
  for (const k of Object.keys(places)) {
    if (Number(k.slice(0, k.indexOf('|'))) >= index) { delete places[k]; changed = true; }
  }
  if (changed) persistSoon();
}

/** For tests: start empty. */
export function resetPlaces(): void {
  places = {};
}

interface HistoryLike {
  location: { state: object };
  subscribe: (cb: (e: { location: { state: object }; action: { type: string } }) => void) => () => void;
}

export const entryIndex = (state: object | undefined): number => {
  const i = (state as Record<string, unknown> | undefined)?.['__TSR_index'];
  return typeof i === 'number' ? i : 0;
};

let tracking: (() => void) | null = null;

function navigationType(): string | null {
  try {
    const nav = globalThis.performance?.getEntriesByType?.('navigation')[0] as { type?: string } | undefined;
    return nav?.type ?? null;
  } catch {
    return null;
  }
}

// A page opened by an address or a link (not a reload, not Back into this
// tab's history) is a new entry: places kept from an earlier visit at its
// position are not its own. Once, as the app loads, before any restore.
if (navigationType() === 'navigate') forgetFrom(entryIndex((globalThis.history?.state as object | null) ?? undefined));

/** Watch the router's history once: a push forgets the places it overwrites. */
export function trackPlaces(history: HistoryLike | undefined): () => void {
  if (!history?.subscribe) return () => {};
  tracking?.();
  const off = history.subscribe(({ location, action }) => {
    if (action.type === 'PUSH') forgetFrom(entryIndex(location.state));
  });
  tracking = off;
  return () => { off(); if (tracking === off) tracking = null; };
}

/**
 * Set `el.scrollTop` to `target` every frame until it holds, the content
 * ends short of it and stops growing, the person takes over, or the give-up
 * time passes. Returns a cancel.
 */
export function restoreScroll(el: HTMLElement, target: number, opts: { giveUpMs?: number; onDone?: () => void } = {}): () => void {
  const started = Date.now();
  const giveUp = opts.giveUpMs ?? RESTORE_GIVE_UP_MS;
  let held = 0;
  let lastHeight = -1;
  let flat = 0;
  let frame = 0;
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    cancelAnimationFrame(frame);
    for (const ev of STOP_EVENTS) el.removeEventListener(ev, finish);
    opts.onDone?.();
  };
  for (const ev of STOP_EVENTS) el.addEventListener(ev, finish, { passive: true });
  const step = () => {
    if (done) return;
    el.scrollTop = target;
    const at = el.scrollTop;
    if (Math.abs(at - target) <= 1) held += 1; else held = 0;
    // short of it: wait while the content still grows (a page loading), else stop there
    const height = el.scrollHeight;
    flat = height === lastHeight ? flat + 1 : 0;
    lastHeight = height;
    if (held >= SETTLE_FRAMES || Date.now() - started > giveUp || (held === 0 && flat > FLAT_FRAMES)) { finish(); return; }
    frame = requestAnimationFrame(step);
  };
  step();
  return finish;
}

/**
 * Remember and restore one scroller's offset for the history entry it is on.
 * `el` is the scroller (null until it mounts); `entry` names the entry
 * (`placeKey` without the id: index and path), so a navigation that keeps
 * the scroller (the app frame's main) switches to the new entry's place.
 */
export function useScrollPlace(el: HTMLElement | null, id: string, entry: { index: number; pathname: string }, opts: { resetOnEnter?: boolean } = {}): void {
  const key = placeKey(entry.index, entry.pathname, id);
  const restoring = useRef(false);
  const reset = !!opts.resetOnEnter;
  // A layout effect: the switch happens before the browser reports a scroll
  // of the new page, so it is never written under the old entry's key.
  useLayoutEffect(() => {
    if (!el) return;
    const target = readPlace(key);
    let cancel: (() => void) | null = null;
    if (target != null) {
      restoring.current = true;
      cancel = restoreScroll(el, target, { onDone: () => { restoring.current = false; savePlace(key, el.scrollTop); } });
    } else if (reset) {
      el.scrollTop = 0;
    }
    let frame = 0;
    const onScroll = () => {
      if (restoring.current || frame) return;
      frame = requestAnimationFrame(() => { frame = 0; if (!restoring.current) savePlace(key, el.scrollTop); });
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      el.removeEventListener('scroll', onScroll);
      if (frame) cancelAnimationFrame(frame);
      cancel?.();
      restoring.current = false;
    };
  }, [el, key, reset]);
}

/** The current history entry, for useScrollPlace. */
export function useEntry(history: { location: { state: object } }, pathname: string): { index: number; pathname: string } {
  const index = entryIndex(history.location.state);
  // keep the object stable for one entry, so effects keyed on it do not rerun
  const ref = useRef({ index, pathname });
  if (ref.current.index !== index || ref.current.pathname !== pathname) ref.current = { index, pathname };
  return ref.current;
}
