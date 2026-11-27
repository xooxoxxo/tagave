/**
 * The engine with fake <audio> elements: the Media Session it sets up, the
 * next track started from `ended` (and loaded into the element that just
 * played when the browser will not start the waiting one without a tap, as
 * iOS does with the screen locked), and the place written at once when the
 * page is hidden.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { QueueTrack } from '@tagave/shared';

class FakeAudio extends EventTarget {
  src = '';
  preload = '';
  volume = 1;
  paused = true;
  ended = false;
  seeking = false;
  currentTime = 0;
  duration = Number.NaN;
  readyState = 0;
  get currentSrc() { return this.src; }
  playResult: () => Promise<void> = async () => { this.paused = false; };
  play() { return this.playResult(); }
  pause() {
    if (this.paused) return;
    this.paused = true;
    this.dispatchEvent(new Event('pause'));
  }
  load() { /* nothing to fetch */ }
  canPlayType() { return 'probably'; }
  getAttribute(name: string) { return name === 'src' && this.src ? this.src : null; }
  removeAttribute(name: string) { if (name === 'src') this.src = ''; }
}

type Handler = ((details: { seekTime?: number; seekOffset?: number }) => void) | null;

function fakeSession() {
  const handlers = new Map<string, Handler>();
  return {
    handlers,
    metadata: null as unknown,
    playbackState: 'none',
    setActionHandler: (action: string, handler: Handler) => { handlers.set(action, handler); },
    setPositionState: vi.fn(),
  };
}

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const ANDROID = 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36';

function track(id: string, coverUrl: string | null = `/api/v1/images/album/al-${id}`): QueueTrack {
  return {
    localTrackId: id, discNo: 1, trackNo: 1, title: `Song ${id}`, artist: 'Artist', album: 'Album', albumArtist: 'Artist', durationMs: 100_000,
    container: 'flac', codec: 'flac', lossless: true, mime: 'audio/flac', available: true, reason: null,
    albumId: `al-${id}`, coverUrl, artists: [], year: null,
  };
}

let session: ReturnType<typeof fakeSession>;
const fetchMock = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({ revision: 1, updatedAt: 'now' }), { status: 200, headers: { 'content-type': 'application/json' } }));
let visibility: DocumentVisibilityState = 'visible';

async function boot(userAgent = ANDROID) {
  vi.resetModules();
  session = fakeSession();
  vi.stubGlobal('Audio', FakeAudio);
  vi.stubGlobal('navigator', { userAgent, platform: 'Linux', maxTouchPoints: 5, mediaSession: session });
  vi.stubGlobal('MediaMetadata', class { constructor(init: unknown) { Object.assign(this, init); } });
  vi.stubGlobal('location', { href: 'https://tagave.test/albums/x', origin: 'https://tagave.test' });
  vi.stubGlobal('document', { get visibilityState() { return visibility; } });
  vi.stubGlobal('fetch', fetchMock);
  const engine = await import('./engine');
  return engine;
}

/** Plays track 0 of `ids` to near its end, so the next one is preloaded. */
async function playToNearEnd(engine: Awaited<ReturnType<typeof boot>>, ids: string[]) {
  engine.usePlayerStore.setState({ queue: { context: null, tracks: ids.map((id, i) => ({ ...track(id), origin: 'context' as const, uid: `u${i}` })), scanRequested: false }, index: -1, queueId: 'q1' });
  engine.playAt(0);
  const [a, b] = engine.mediaElements() as unknown as [FakeAudio, FakeAudio];
  a.dispatchEvent(new Event('playing'));
  a.duration = 100;
  a.currentTime = 90;
  a.dispatchEvent(new Event('timeupdate'));
  return { a, b };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => { visibility = 'visible'; fetchMock.mockClear(); });
afterEach(() => { vi.unstubAllGlobals(); });

describe('Media Session', () => {
  it('handles play, pause, previous, next, stop and seeks on Android and desktops', async () => {
    const engine = await boot(ANDROID);
    engine.play();
    for (const action of ['play', 'pause', 'previoustrack', 'nexttrack', 'stop', 'seekto', 'seekbackward', 'seekforward']) {
      expect(session.handlers.get(action), action).toBeTypeOf('function');
    }
  });

  it('on iPhone leaves the ±10 s seeks out, so the lock screen and a car show previous/next track', async () => {
    const engine = await boot(IPHONE);
    engine.play();
    expect(session.handlers.get('nexttrack')).toBeTypeOf('function');
    expect(session.handlers.get('previoustrack')).toBeTypeOf('function');
    expect(session.handlers.get('seekto')).toBeTypeOf('function');
    expect(session.handlers.get('seekbackward')).toBeNull();
    expect(session.handlers.get('seekforward')).toBeNull();
  });

  it('shows the cover at its real size, or the app icon for a track without one', async () => {
    const { artworkFor } = await boot();
    expect(artworkFor('/api/v1/images/album/a1', 'https://tagave.test/x')).toEqual([{ src: 'https://tagave.test/api/v1/images/album/a1', sizes: '300x300' }]);
    expect(artworkFor(null, 'https://tagave.test/x')).toEqual([
      { src: 'https://tagave.test/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: 'https://tagave.test/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
    ]);
  });

  it('sets the track\'s metadata with artwork and the position as it plays', async () => {
    const engine = await boot();
    await playToNearEnd(engine, ['a', 'b']);
    expect(session.metadata).toMatchObject({ title: 'Song a', artist: 'Artist', album: 'Album', artwork: [{ src: 'https://tagave.test/api/v1/images/album/al-a', sizes: '300x300' }] });
    expect(session.setPositionState).toHaveBeenCalledWith({ duration: 100, playbackRate: 1, position: 90 });
    expect(session.playbackState).toBe('playing');
  });
});

describe('the next track, with the page hidden', () => {
  it('starts from `ended` in the preloaded element', async () => {
    const engine = await boot();
    visibility = 'hidden';
    const { a, b } = await playToNearEnd(engine, ['a', 'b']);
    expect(b.src).toContain('/stream/b');
    a.ended = true;
    a.dispatchEvent(new Event('ended'));
    await flush();
    expect(engine.usePlayerStore.getState().index).toBe(1);
    expect(b.paused).toBe(false);
    expect(a.src).toBe('');
    expect(session.metadata).toMatchObject({ title: 'Song b' });
  });

  it('loads into the element that just played when the waiting one may not start without a tap', async () => {
    const engine = await boot(IPHONE);
    visibility = 'hidden';
    const { a, b } = await playToNearEnd(engine, ['a', 'b', 'c']);
    b.playResult = () => Promise.reject(Object.assign(new Error('needs a tap'), { name: 'NotAllowedError' }));
    a.ended = true;
    a.dispatchEvent(new Event('ended'));
    await flush();
    const s = engine.usePlayerStore.getState();
    expect(s.index).toBe(1);
    expect(s.status).not.toBe('paused');
    expect(a.src).toContain('/stream/b');
    expect(a.paused).toBe(false);
    expect(b.src).toBe('');
    // and the one after that still follows
    a.dispatchEvent(new Event('playing'));
    a.ended = false;
    a.currentTime = 95;
    a.dispatchEvent(new Event('timeupdate'));
    expect(b.src).toContain('/stream/c');
  });

  it('a refused start with no fallback (the very first Play) still waits for a tap', async () => {
    const engine = await boot();
    engine.usePlayerStore.setState({ queue: { context: null, tracks: [{ ...track('a'), origin: 'context', uid: 'u0' }], scanRequested: false }, index: -1, queueId: 'q1' });
    engine.play(); // creates the elements
    const [a] = engine.mediaElements() as unknown as [FakeAudio];
    a.playResult = () => Promise.reject(Object.assign(new Error('needs a tap'), { name: 'NotAllowedError' }));
    engine.playAt(0);
    await flush();
    expect(engine.usePlayerStore.getState().status).toBe('paused');
  });

  it('writes the place at once when paused with the page hidden (a lock screen or a car)', async () => {
    const engine = await boot();
    const { a } = await playToNearEnd(engine, ['a', 'b']);
    await flush();
    fetchMock.mockClear();
    visibility = 'hidden';
    a.paused = false;
    a.pause();
    const puts = fetchMock.mock.calls.filter((c) => String(c[0]).endsWith('/me/player/queue'));
    expect(puts).toHaveLength(1);
  });

  it('persistOnHide writes the place of a device that plays', async () => {
    const engine = await boot();
    await playToNearEnd(engine, ['a', 'b']);
    await flush();
    fetchMock.mockClear();
    engine.persistOnHide();
    expect(fetchMock.mock.calls.filter((c) => String(c[0]).endsWith('/me/player/queue'))).toHaveLength(1);
  });
});

describe('songs whose files are offline', () => {
  const ok = fetchMock.getMockImplementation()!;
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': status === 200 ? 'application/json' : 'application/problem+json' } });
  /** the streams of `offline` answer 409 files_offline; the album's queue is `view`; the rest as usual */
  const serve = (offline: string[], view?: unknown) => fetchMock.mockImplementation(async (url, init) => {
    const u = String(url);
    if (offline.some((id) => u.includes(`/stream/${id}?`))) return json({ type: 'files_offline', title: 'Files offline', status: 409 }, 409);
    if (view && u.includes('/player/albums/') && u.endsWith('/queue')) return json(view);
    return ok(url, init);
  });
  afterEach(() => { fetchMock.mockImplementation(ok); });

  /** the active element gives up on its stream, and the probe answers */
  const fail = async (a: FakeAudio) => { a.dispatchEvent(new Event('error')); for (let i = 0; i < 4; i++) await flush(); };
  /** the element now loading song `id` starts to sound */
  const sounds = (engine: Awaited<ReturnType<typeof boot>>, id: string) => {
    const el = (engine.mediaElements() as unknown as FakeAudio[]).find((x) => x.src.includes(`/stream/${id}?`));
    expect(el, `an element loads ${id}`).toBeDefined();
    el!.dispatchEvent(new Event('playing'));
  };

  it('skips each one, then says so once, with the count, when a song plays', async () => {
    const engine = await boot();
    serve(['a', 'b']);
    engine.usePlayerStore.setState({ queue: { context: null, tracks: ['a', 'b', 'c'].map((id, i) => ({ ...track(id), origin: 'context' as const, uid: `u${i}` })), scanRequested: false }, index: -1, queueId: 'q1' });
    engine.playAt(0);
    const [a] = engine.mediaElements() as unknown as [FakeAudio];
    await fail(a);
    await fail(a);
    const s = engine.usePlayerStore.getState();
    expect(s.index).toBe(2);
    expect(s.queue!.tracks.slice(0, 2).map((t) => [t.available, t.reason])).toEqual([[false, 'offline'], [false, 'offline']]);
    // the run of skips has not ended yet: no word
    expect(s.offlineSkips).toBeNull();
    a.dispatchEvent(new Event('playing'));
    expect(engine.usePlayerStore.getState().offlineSkips).toMatchObject({ count: 2 });
    const first = engine.usePlayerStore.getState().offlineSkips!.id;
    // more sound is not a second word
    a.dispatchEvent(new Event('playing'));
    expect(engine.usePlayerStore.getState().offlineSkips!.id).toBe(first);
  });

  it('adds the songs the album\'s queue left out to the same count, once', async () => {
    const engine = await boot();
    const t = (id: string, n: number) => ({ ...track(id), trackNo: n });
    serve(['a'], { albumId: 'al', album: 'Album', albumArtist: 'Artist', coverUrl: null, tracks: [t('a', 1), t('b', 2)], scanRequested: false, skippedOffline: 2 });
    const play = engine.playAlbum({ albumId: 'al', title: 'Album', artist: 'Artist', coverUrl: null });
    await play;
    const [a] = engine.mediaElements() as unknown as [FakeAudio];
    await fail(a);
    a.dispatchEvent(new Event('playing'));
    expect(engine.usePlayerStore.getState().offlineSkips).toMatchObject({ count: 3 });
  });

  it('nothing left to play: the bar says why, and there is no skip toast', async () => {
    const engine = await boot();
    serve(['a', 'b']);
    engine.usePlayerStore.setState({ queue: { context: null, tracks: ['a', 'b'].map((id, i) => ({ ...track(id), origin: 'context' as const, uid: `u${i}` })), scanRequested: false }, index: -1, queueId: 'q1' });
    engine.playAt(0);
    const [a] = engine.mediaElements() as unknown as [FakeAudio];
    await fail(a);
    await fail(a);
    expect(engine.usePlayerStore.getState()).toMatchObject({ status: 'error', message: 'Can\'t play: the files are offline.', offlineSkips: null });
    // and the count is gone: a later song that plays says nothing of it
    engine.usePlayerStore.setState({ queue: { context: null, tracks: [{ ...track('c'), origin: 'context' as const, uid: 'u9' }], scanRequested: false }, index: -1 });
    engine.playAt(0);
    sounds(engine, 'c');
    expect(engine.usePlayerStore.getState().offlineSkips).toBeNull();
  });

  for (const [name, leave] of [
    ['stop', (e: Awaited<ReturnType<typeof boot>>) => e.stop()],
    ['clearing the queue', (e: Awaited<ReturnType<typeof boot>>) => e.clearQueue()],
  ] as const) {
    it(`a skip run cut short by ${name} never toasts later`, async () => {
      const engine = await boot();
      serve(['a']);
      engine.usePlayerStore.setState({ queue: { context: null, tracks: ['a', 'b'].map((id, i) => ({ ...track(id), origin: 'context' as const, uid: `u${i}` })), scanRequested: false }, index: -1, queueId: 'q1' });
      engine.playAt(0);
      const [a] = engine.mediaElements() as unknown as [FakeAudio];
      await fail(a);
      leave(engine);
      engine.usePlayerStore.setState({ queue: { context: null, tracks: [{ ...track('c'), origin: 'context' as const, uid: 'u9' }], scanRequested: false }, index: -1, queueId: 'q2' });
      engine.playAt(0);
      sounds(engine, 'c');
      expect(engine.usePlayerStore.getState().offlineSkips).toBeNull();
    });
  }

  it('an album whose queue fails to load drops the count from before', async () => {
    const engine = await boot();
    serve(['a']);
    engine.usePlayerStore.setState({ queue: { context: null, tracks: ['a', 'b'].map((id, i) => ({ ...track(id), origin: 'context' as const, uid: `u${i}` })), scanRequested: false }, index: -1, queueId: 'q1' });
    engine.playAt(0);
    const [a] = engine.mediaElements() as unknown as [FakeAudio];
    await fail(a);
    fetchMock.mockImplementation(async (url, init) => (String(url).includes('/player/albums/') ? json({ title: 'Boom', status: 500 }, 500) : ok(url, init)));
    await engine.playAlbum({ albumId: 'al', title: 'Album', artist: 'Artist', coverUrl: null });
    expect(engine.usePlayerStore.getState()).toMatchObject({ status: 'error', offlineSkips: null });
  });

  it('the bar clears the run once it has toasted it', async () => {
    const engine = await boot();
    engine.usePlayerStore.setState({ offlineSkips: { id: 7, count: 2 } });
    engine.clearOfflineSkips();
    expect(engine.usePlayerStore.getState().offlineSkips).toBeNull();
  });
});

describe('another device plays (play in one place)', () => {
  const queue = (ids: string[]) => ({ context: null, tracks: ids.map((id, i) => ({ ...track(id), origin: 'context' as const, uid: `u${i}` })), scanRequested: false });

  it('sends the keys to the device that plays and shows its state, its own audio silent', async () => {
    const engine = await boot();
    engine.usePlayerStore.setState({ queue: queue(['a', 'b', 'c']), index: 0, queueId: 'q1', status: 'paused', volume: 0.4 });
    const sent: Array<[string, unknown]> = [];
    engine.setRemoteControl({ send: (action, opts) => sent.push([action, opts]) }, 'phone-tab-1');
    expect(engine.usePlayerStore.getState().remoteDeviceId).toBe('phone-tab-1');
    engine.play();
    engine.pause();
    engine.next();
    engine.previous();
    engine.seek(42);
    engine.setVolume(0.8);
    engine.playAt(2);
    expect(sent).toEqual([['play', undefined], ['pause', undefined], ['next', undefined], ['previous', undefined], ['seek', { value: 42 }], ['volume', { value: 0.8 }], ['index', { index: 2 }]]);
    expect(engine.mediaElements().every((a) => (a as unknown as FakeAudio).paused)).toBe(true);
    expect(engine.playsHere()).toBe(false);
  });

  it('mirrors the other device: its entry, play state, place and volume; a key pressed here holds for a moment', async () => {
    const engine = await boot();
    engine.usePlayerStore.setState({ queue: queue(['a', 'b', 'c']), index: 0, queueId: 'q1', status: 'paused' });
    engine.setRemoteControl({ send: () => undefined }, 'phone-tab-1');
    expect(engine.mirrorRemote({ index: 1, trackId: 'b', position: 12, playing: true, volume: 0.5, durationMs: 100_000 })).toBe(true);
    expect(engine.usePlayerStore.getState()).toMatchObject({ index: 1, status: 'playing', position: 12, volume: 0.5, duration: 100 });
    // a track this queue does not have: the caller follows the queue
    expect(engine.mirrorRemote({ index: 1, trackId: 'zz', position: 1, playing: true, volume: 0.5, durationMs: null })).toBe(false);
    engine.pause();
    engine.mirrorRemote({ index: 1, trackId: 'b', position: 13, playing: true, volume: 0.5, durationMs: 100_000 });
    expect(engine.usePlayerStore.getState().status).toBe('paused');
  });

  it('on its own again it gets its own volume back; resting where the other one went away, Play plays here from there', async () => {
    const engine = await boot();
    engine.usePlayerStore.setState({ queue: queue(['a', 'b']), index: 0, queueId: 'q1', status: 'paused', volume: 0.3 });
    engine.setRemoteControl({ send: () => undefined }, 'phone-tab-1');
    engine.mirrorRemote({ index: 0, trackId: 'a', position: 5, playing: true, volume: 0.9, durationMs: 100_000 });
    engine.restAt({ index: 1, trackId: 'b', position: 33, playing: false, volume: 0.9, durationMs: 100_000 });
    expect(engine.isRemote()).toBe(false);
    expect(engine.usePlayerStore.getState()).toMatchObject({ remoteDeviceId: null, volume: 0.3, index: 1, position: 33, status: 'paused' });
    engine.play();
    const [a] = engine.mediaElements() as unknown as [FakeAudio];
    expect(a.paused).toBe(false);
    expect(engine.playsHere()).toBe(true);
  });

  it('"This device" plays here and claims the queue; the other device is left', async () => {
    const engine = await boot();
    engine.usePlayerStore.setState({ queue: queue(['a', 'b']), index: 0, queueId: 'q1', status: 'paused' });
    const sent: string[] = [];
    engine.setRemoteControl({ send: (action) => sent.push(action) }, 'phone-tab-1');
    engine.playHere();
    expect(engine.isRemote()).toBe(false);
    expect(sent).toEqual([]);
    await flush();
    const claim = fetchMock.mock.calls.map(([, init]) => (init?.body ? JSON.parse(String(init.body)) : null)).find((b) => b?.mode === 'play');
    expect(claim).toMatchObject({ index: 0, deviceId: engine.deviceId() });
  });

  it('handed playback in the background, it loads paused and waits for a tap', async () => {
    const engine = await boot();
    fetchMock.mockImplementationOnce(async () => new Response(JSON.stringify({
      items: [{ ...track('a'), origin: 'context' }, { ...track('b'), origin: 'context' }], context: null, index: 1, positionMs: 20_000, deviceId: 'mac-tab-1', revision: 7, updatedAt: 'now',
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    await engine.takeOver(1, 20, { autoplay: false });
    expect(engine.usePlayerStore.getState()).toMatchObject({ index: 1, status: 'paused', needsTap: true });
    const [a] = engine.mediaElements() as unknown as [FakeAudio];
    expect(a.paused).toBe(true);
    engine.play();
    expect(a.paused).toBe(false);
  });

  it('a refused autoplay shows "Tap to play here"', async () => {
    const engine = await boot();
    engine.usePlayerStore.setState({ queue: queue(['a', 'b']), index: -1, queueId: 'q1' });
    const els = engine.ensurePlayerElements() as unknown as FakeAudio[];
    for (const el of els) el.playResult = async () => { throw Object.assign(new Error('no gesture'), { name: 'NotAllowedError' }); };
    engine.playAt(0);
    await flush();
    expect(engine.usePlayerStore.getState()).toMatchObject({ status: 'paused', needsTap: true });
  });

  it('hands off: writes its place first, then goes quiet', async () => {
    const engine = await boot();
    const { a } = await playToNearEnd(engine, ['a', 'b']);
    fetchMock.mockClear();
    const at = await engine.handOff();
    expect(at).toEqual({ index: 0, position: 90 });
    expect(fetchMock.mock.calls.some(([url, init]) => String(url).includes('/me/player/queue') && init?.method === 'PUT')).toBe(true);
    expect(a.paused).toBe(true);
    expect(engine.playsHere()).toBe(false);
  });
});
