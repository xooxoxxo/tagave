/**
 * Back keeps your place (rr77): per-entry scroll places, what a new entry
 * forgets, the restore loop, the URL state of the lists, and the delete rule.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { entryIndex, forgetFrom, placeKey, readPlace, resetPlaces, restoreScroll, savePlace, trackPlaces } from './listPlace';
import { afterDelete } from './backNav';
import { parseArtistsSearch } from '../pages/artistsView';

beforeEach(() => resetPlaces());

describe('places per history entry', () => {
  it('keys a scroller by the entry\'s position and path', () => {
    expect(placeKey(3, '/artists/', 'artists')).toBe('3|/artists|artists');
    expect(placeKey(0, '', 'main')).toBe('0|/|main');
  });

  it('remembers an offset; zero is no place', () => {
    savePlace('2|/albums|albums', 1480.4);
    expect(readPlace('2|/albums|albums')).toBe(1480);
    savePlace('2|/albums|albums', 0);
    expect(readPlace('2|/albums|albums')).toBeNull();
  });

  it('a new entry forgets the places at and after its position', () => {
    savePlace(placeKey(1, '/albums', 'albums'), 900);
    savePlace(placeKey(2, '/artists', 'artists'), 700);
    savePlace(placeKey(3, '/playlists', 'main'), 500);
    forgetFrom(2);
    expect(readPlace(placeKey(1, '/albums', 'albums'))).toBe(900);
    expect(readPlace(placeKey(2, '/artists', 'artists'))).toBeNull();
    expect(readPlace(placeKey(3, '/playlists', 'main'))).toBeNull();
  });

  it('reads the router\'s entry index, 0 when there is none', () => {
    expect(entryIndex({ __TSR_index: 4 })).toBe(4);
    expect(entryIndex({})).toBe(0);
    expect(entryIndex(undefined)).toBe(0);
  });

  it('a push forgets; Back, Forward and a replace keep', () => {
    let listener: ((e: { location: { state: object }; action: { type: string } }) => void) | null = null;
    const history = { location: { state: { __TSR_index: 1 } }, subscribe: (cb: typeof listener) => { listener = cb; return () => { listener = null; }; } };
    const off = trackPlaces(history as never);
    savePlace(placeKey(2, '/artists', 'artists'), 700);
    listener!({ location: { state: { __TSR_index: 2 } }, action: { type: 'BACK' } });
    listener!({ location: { state: { __TSR_index: 2 } }, action: { type: 'REPLACE' } });
    expect(readPlace(placeKey(2, '/artists', 'artists'))).toBe(700);
    listener!({ location: { state: { __TSR_index: 2 } }, action: { type: 'PUSH' } });
    expect(readPlace(placeKey(2, '/artists', 'artists'))).toBeNull();
    off();
    expect(listener).toBeNull();
    expect(trackPlaces(undefined)).toBeTypeOf('function');
  });
});

describe('the restore', () => {
  /** A scroller whose content grows by `grow` px a frame up to `max`. */
  const scroller = (height: number, grow: number, max: number) => {
    let content = height;
    let top = 0;
    const el = {
      clientHeight: 800,
      get scrollHeight() { return content; },
      get scrollTop() { return top; },
      set scrollTop(v: number) { top = Math.max(0, Math.min(v, content - 800)); },
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      tick() { content = Math.min(max, content + grow); },
    };
    return el;
  };

  it('keeps setting the offset while a virtualised list grows, then stops', () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { frames.push(cb); return frames.length; });
    vi.stubGlobal('cancelAnimationFrame', () => {});
    const el = scroller(1200, 600, 6000);
    const done = vi.fn();
    restoreScroll(el as unknown as HTMLElement, 3000, { onDone: done });
    for (let i = 0; i < 40 && !done.mock.calls.length; i++) { el.tick(); frames.shift()?.(0); }
    expect(el.scrollTop).toBe(3000);
    expect(done).toHaveBeenCalledOnce();
    expect(el.removeEventListener).toHaveBeenCalledWith('wheel', expect.any(Function));
    vi.unstubAllGlobals();
  });

  it('the person scrolling takes over', () => {
    vi.stubGlobal('requestAnimationFrame', () => 1);
    vi.stubGlobal('cancelAnimationFrame', () => {});
    const el = scroller(1200, 0, 1200);
    const done = vi.fn();
    const cancel = restoreScroll(el as unknown as HTMLElement, 3000, { onDone: done });
    const onWheel = el.addEventListener.mock.calls.find(([ev]) => ev === 'wheel')![1] as () => void;
    onWheel();
    expect(done).toHaveBeenCalledOnce();
    cancel();
    expect(done).toHaveBeenCalledOnce();
    vi.unstubAllGlobals();
  });
});

describe('the lists\' state lives in the URL', () => {
  it('Artists: the words, the sort (name is the default) and the letter', () => {
    expect(parseArtistsSearch({ q: ' fiona ', sort: 'albums', letter: 'S' })).toEqual({ q: 'fiona', sort: 'albums', letter: 'S' });
    expect(parseArtistsSearch({ sort: 'name', letter: 'ß', q: '' })).toEqual({});
    expect(parseArtistsSearch({ letter: '0-9' })).toEqual({ letter: '0-9' });
  });
});

describe('delete goes one step up', () => {
  it('steps back through the app\'s history, else opens the fallback', () => {
    expect(afterDelete(true, '/artists/a1')).toEqual({ kind: 'history' });
    expect(afterDelete(false, '/artists/a1')).toEqual({ kind: 'navigate', to: '/artists/a1' });
    expect(afterDelete(false, '/albums')).toEqual({ kind: 'navigate', to: '/albums' });
  });
});
