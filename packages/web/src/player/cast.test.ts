/**
 * Casting with fakes of each platform: WebKit's AirPlay events and picker,
 * the Remote Playback API on Chrome for Android, and the Google Cast SDK on
 * a desktop Chrome. The engine runs on fake <audio> elements; the server's
 * cast links come from a fake fetch.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { QueueTrack } from '@tagave/shared';

const ANDROID = 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36';
const MAC_CHROME = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
const MAC_SAFARI = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15';
const FIREFOX = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:140.0) Gecko/20100101 Firefox/140.0';
const IOS_CHROME = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/140.0 Mobile/15E148 Safari/604.1';
const ORIGIN = 'https://tagave.test';

class FakeRemote extends EventTarget {
  state: 'disconnected' | 'connecting' | 'connected' = 'disconnected';
  watchers: Array<(a: boolean) => void> = [];
  prompt = vi.fn(async () => undefined);
  async watchAvailability(cb: (a: boolean) => void) { this.watchers.push(cb); cb(true); return this.watchers.length; }
  async cancelWatchAvailability() { /* nothing */ }
  go(state: FakeRemote['state'], event: string) { this.state = state; this.dispatchEvent(new Event(event)); }
}

class FakeAudio extends EventTarget {
  static made: FakeAudio[] = [];
  src = '';
  preload = '';
  volume = 1;
  paused = true;
  ended = false;
  seeking = false;
  currentTime = 0;
  duration = Number.NaN;
  readyState = 0;
  attrs = new Map<string, string>();
  remote = new FakeRemote();
  webkitCurrentPlaybackTargetIsWireless = false;
  webkitShowPlaybackTargetPicker = vi.fn();
  constructor() { super(); FakeAudio.made.push(this); }
  get currentSrc() { return this.src; }
  play() { this.paused = false; return Promise.resolve(); }
  pause() { if (this.paused) return; this.paused = true; this.dispatchEvent(new Event('pause')); }
  load() { /* nothing to fetch */ }
  canPlayType() { return 'probably'; }
  setAttribute(name: string, value: string) { this.attrs.set(name, value); }
  getAttribute(name: string) { return name === 'src' ? (this.src || null) : this.attrs.get(name) ?? null; }
  removeAttribute(name: string) { if (name === 'src') this.src = ''; }
}

function track(id: string, mime = 'audio/flac'): QueueTrack {
  return {
    localTrackId: id, discNo: 1, trackNo: 2, title: `Song ${id}`, artist: 'Artist', album: 'Album', albumArtist: 'Artist', durationMs: 100_000,
    container: 'flac', codec: 'flac', lossless: true, mime, available: true, reason: null,
    albumId: `al-${id}`, coverUrl: `/api/v1/images/album/al-${id}`, artists: [], year: null,
  };
}

let castOrigin = ORIGIN;
let reach = 'ok';
const minted: Array<{ localTrackId: string; format: string }> = [];
const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
  const u = String(url);
  if (u.endsWith('/player/cast-url')) {
    const body = JSON.parse(String(init?.body)) as { localTrackId: string; format: string };
    minted.push(body);
    return new Response(JSON.stringify({
      url: `${castOrigin}/api/v1/player/cast/tok-${body.localTrackId}?format=${body.format}`,
      coverUrl: `${castOrigin}/api/v1/player/cast-cover/cov-${body.localTrackId}`,
      expiresAt: new Date(Date.now() + 6 * 3600_000).toISOString(),
      reach,
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  return new Response(JSON.stringify({ revision: 1, updatedAt: 'now' }), { status: 200, headers: { 'content-type': 'application/json' } });
});

async function boot(userAgent: string) {
  vi.resetModules();
  FakeAudio.made = [];
  vi.stubGlobal('Audio', FakeAudio);
  vi.stubGlobal('navigator', { userAgent, platform: 'MacIntel', maxTouchPoints: 0 });
  vi.stubGlobal('location', { href: `${ORIGIN}/albums/x`, origin: ORIGIN });
  vi.stubGlobal('document', { visibilityState: 'visible' });
  vi.stubGlobal('fetch', fetchMock);
  const engine = await import('./engine');
  const cast = await import('./cast');
  const links = await import('./castLinks');
  engine.usePlayerStore.setState({
    queue: { context: null, tracks: ['t1', 't2', 't3'].map((id, i) => ({ ...track(id), origin: 'context' as const, uid: `u${i}` })), scanRequested: false },
    index: -1, queueId: '00000000-0000-4000-8000-000000000001',
  });
  return { engine, cast, links };
}

const flush = async () => { for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0)); };
const elementEnv = (extra: Record<string, unknown> = {}) => ({ navigator: globalThis.navigator, isSecureContext: true, HTMLMediaElement: { prototype: { remote: null } }, ...extra });

beforeEach(() => { fetchMock.mockClear(); minted.length = 0; castOrigin = ORIGIN; reach = 'ok'; });
afterEach(() => { vi.unstubAllGlobals(); });

describe('which way a browser casts', () => {
  it('AirPlay where WebKit has playback targets, the SDK on desktop Chrome, Remote Playback on Android, nothing on Firefox', async () => {
    const { castKindFor, isDesktopChromium } = await import('./cast');
    const media = { prototype: { remote: null } };
    expect(castKindFor({ navigator: { userAgent: MAC_SAFARI, platform: 'MacIntel', maxTouchPoints: 0 }, WebKitPlaybackTargetAvailabilityEvent: class {} })).toBe('airplay');
    // Chrome on iPhone is WebKit: AirPlay too
    expect(castKindFor({ navigator: { userAgent: IOS_CHROME, platform: 'iPhone', maxTouchPoints: 5 }, WebKitPlaybackTargetAvailabilityEvent: class {} })).toBe('airplay');
    expect(castKindFor({ navigator: { userAgent: MAC_CHROME, platform: 'MacIntel', maxTouchPoints: 0 }, isSecureContext: true, HTMLMediaElement: media })).toBe('cast');
    expect(castKindFor({ navigator: { userAgent: ANDROID, platform: 'Linux', maxTouchPoints: 5 }, isSecureContext: true, HTMLMediaElement: media })).toBe('remote');
    expect(castKindFor({ navigator: { userAgent: FIREFOX, platform: 'MacIntel', maxTouchPoints: 0 }, isSecureContext: true, HTMLMediaElement: { prototype: {} } })).toBeNull();
    // plain http: the SDK and Remote Playback are not offered on an insecure page
    expect(castKindFor({ navigator: { userAgent: MAC_CHROME, platform: 'MacIntel', maxTouchPoints: 0 }, isSecureContext: false, HTMLMediaElement: media })).toBeNull();
    expect(isDesktopChromium({ userAgent: ANDROID, platform: 'Linux', maxTouchPoints: 5 })).toBe(false);
  });

  it('says where it casts, and why it cannot', async () => {
    const { castLine, castProblem } = await import('./cast');
    expect(castLine({ state: 'off', device: null, kind: 'cast' })).toBeNull();
    expect(castLine({ state: 'on', device: 'Kitchen', kind: 'cast' })).toBe('Casting to Kitchen');
    expect(castLine({ state: 'on', device: null, kind: 'airplay' })).toBe('AirPlay');
    expect(castLine({ state: 'connecting', device: null, kind: 'remote' })).toBe('Casting');
    expect(castProblem({ reach: 'loopback', kind: 'airplay', state: 'off' })).toBe('unreachable');
    expect(castProblem({ reach: 'unset', kind: 'cast', state: 'off' })).toBe('unreachable');
    expect(castProblem({ reach: 'http', kind: 'cast', state: 'off' })).toBe('needs-https');
    expect(castProblem({ reach: 'http', kind: 'airplay', state: 'off' })).toBeNull();
    expect(castProblem({ reach: 'ok', kind: 'remote', state: 'off' })).toBeNull();
    expect(castProblem({ reach: 'loopback', kind: 'cast', state: 'on' })).toBeNull();
  });
});

describe('cast links', () => {
  it('stay relative on the page origin, absolute elsewhere, with a transcode’s second', async () => {
    const { castSrc } = await import('./castLinks');
    const view = { url: `${ORIGIN}/api/v1/player/cast/tok?format=opus&maxBitRate=160`, coverUrl: null, expiresAt: '', reach: 'ok' as const };
    expect(castSrc(view, 'opus', 42.7, ORIGIN)).toBe('/api/v1/player/cast/tok?format=opus&maxBitRate=160&offset=42');
    expect(castSrc(view, 'opus', 0, 'http://192.0.2.1:3000')).toBe(`${ORIGIN}/api/v1/player/cast/tok?format=opus&maxBitRate=160`);
    expect(castSrc({ ...view, url: null }, 'opus')).toBeNull();
  });

  it('are kept, and a refused one is not asked for again at once', async () => {
    const { links } = await boot(MAC_CHROME);
    await links.fetchCastLink('t1', 'original', 192);
    await links.fetchCastLink('t1', 'original', 192);
    expect(minted).toHaveLength(1);
    expect(links.useCastStore.getState()).toMatchObject({ reach: 'ok', host: 'tagave.test' });
    fetchMock.mockImplementationOnce(async () => new Response('{}', { status: 429 }));
    await expect(links.fetchCastLink('t2', 'original', 192)).rejects.toBeTruthy();
    await expect(links.fetchCastLink('t2', 'original', 192)).rejects.toBeTruthy();
    expect(fetchMock.mock.calls.filter(([u]) => String(u).endsWith('/cast-url'))).toHaveLength(2);
  });
});

describe('AirPlay (Safari)', () => {
  it('shows a key once a target is there, moves the track to a cast link before the picker, and plays on one element', async () => {
    const { engine, cast } = await boot(MAC_SAFARI);
    cast.startCastWatch(elementEnv({ WebKitPlaybackTargetAvailabilityEvent: class {} }));
    expect(cast.useCastStore.getState()).toMatchObject({ kind: 'airplay', available: false });
    const [a, b] = FakeAudio.made as [FakeAudio, FakeAudio];
    expect(a.attrs.get('x-webkit-airplay')).toBe('allow');
    engine.playAt(0);
    expect(a.src).toBe('/api/v1/player/stream/t1?format=original');
    a.dispatchEvent(new Event('playing'));
    a.dispatchEvent(Object.assign(new Event('webkitplaybacktargetavailabilitychanged'), { availability: 'available' }));
    expect(cast.useCastStore.getState().available).toBe(true);
    await flush();
    // the link was made as soon as a target showed up, so the click finds it ready
    expect(minted).toEqual([{ localTrackId: 't1', format: 'original' }]);
    engine.usePlayerStore.setState({ position: 30 });
    cast.chooseCastDevice();
    expect(a.src).toBe('/api/v1/player/cast/tok-t1?format=original');
    expect(a.webkitShowPlaybackTargetPicker).toHaveBeenCalledOnce();
    a.webkitCurrentPlaybackTargetIsWireless = true;
    a.dispatchEvent(new Event('webkitcurrentplaybacktargetiswirelesschanged'));
    expect(cast.useCastStore.getState().state).toBe('on');
    expect(cast.castLine(cast.useCastStore.getState())).toBe('AirPlay');
    // near the end: no second element is loaded, the next link is made instead
    a.duration = 100;
    a.currentTime = 90;
    a.dispatchEvent(new Event('timeupdate'));
    await flush();
    expect(b.src).toBe('');
    expect(minted.map((m) => m.localTrackId)).toContain('t2');
    a.dispatchEvent(new Event('ended'));
    expect(engine.usePlayerStore.getState().index).toBe(1);
    expect(a.src).toBe('/api/v1/player/cast/tok-t2?format=original');
    // AirPlay off: the next track loads from the session URL again
    a.webkitCurrentPlaybackTargetIsWireless = false;
    a.dispatchEvent(new Event('webkitcurrentplaybacktargetiswirelesschanged'));
    expect(cast.useCastStore.getState().state).toBe('off');
    engine.next();
    expect(a.src).toBe('/api/v1/player/stream/t3?format=original');
    cast.stopCastWatch();
  });

  it('uses an absolute link when PUBLIC_URL is another origin than the page', async () => {
    castOrigin = 'https://music.example.test';
    const { engine, cast } = await boot(MAC_SAFARI);
    cast.startCastWatch(elementEnv({ WebKitPlaybackTargetAvailabilityEvent: class {} }));
    const [a] = FakeAudio.made as [FakeAudio];
    engine.playAt(0);
    a.dispatchEvent(Object.assign(new Event('webkitplaybacktargetavailabilitychanged'), { availability: 'available' }));
    await flush();
    cast.chooseCastDevice();
    expect(a.src).toBe('https://music.example.test/api/v1/player/cast/tok-t1?format=original');
    cast.stopCastWatch();
  });
});

describe('Remote Playback (Chrome on Android)', () => {
  it('watches availability, prompts on the playing element and follows connecting / connect / disconnect', async () => {
    const { engine, cast } = await boot(ANDROID);
    cast.startCastWatch(elementEnv());
    const [a] = FakeAudio.made as [FakeAudio];
    await flush();
    expect(cast.useCastStore.getState()).toMatchObject({ kind: 'remote', available: true, state: 'off' });
    engine.playAt(0);
    a.dispatchEvent(new Event('playing'));
    await flush();
    cast.chooseCastDevice();
    expect(a.remote.prompt).toHaveBeenCalledOnce();
    expect(a.src).toBe('/api/v1/player/cast/tok-t1?format=original');
    a.remote.go('connecting', 'connecting');
    expect(cast.useCastStore.getState().state).toBe('connecting');
    a.remote.go('connected', 'connect');
    expect(cast.useCastStore.getState().state).toBe('on');
    expect(cast.isCasting()).toBe(true);
    a.remote.go('disconnected', 'disconnect');
    expect(cast.useCastStore.getState().state).toBe('off');
    cast.stopCastWatch();
  });

  it('hides the key quietly when availability cannot be watched', async () => {
    const { cast } = await boot(ANDROID);
    FakeRemote.prototype.watchAvailability = async () => { throw new DOMException('no', 'NotSupportedError'); };
    try {
      cast.startCastWatch(elementEnv());
      await flush();
      expect(cast.useCastStore.getState()).toMatchObject({ kind: 'remote', available: false });
    } finally {
      FakeRemote.prototype.watchAvailability = async function (this: FakeRemote, cb: (a: boolean) => void) { this.watchers.push(cb); cb(true); return this.watchers.length; };
      cast.stopCastWatch();
    }
  });
});

// ---- a fake Google Cast SDK ----

function fakeSdk() {
  const listeners = new Map<string, Array<(e: unknown) => void>>();
  const emit = (type: string, e: unknown) => listeners.get(type)?.forEach((l) => l(e));
  let castState = 'NOT_CONNECTED';
  const loads: Array<{ info: any; autoplay: boolean; currentTime: number }> = [];
  const media: { idleReason: string | null } = { idleReason: null };
  const session = {
    getCastDevice: () => ({ friendlyName: 'Living Room' }),
    loadMedia: vi.fn(async (req: any) => { loads.push({ info: req.info, autoplay: req.autoplay, currentTime: req.currentTime }); }),
    getMediaSession: () => media,
  };
  const context = {
    setOptions: vi.fn(),
    addEventListener: (type: string, l: (e: unknown) => void) => { listeners.set(type, [...(listeners.get(type) ?? []), l]); },
    getCastState: () => castState,
    getCurrentSession: () => (castState === 'CONNECTED' ? session : null),
    requestSession: vi.fn(async () => undefined),
    endCurrentSession: vi.fn(),
  };
  const playerChanges: Array<(e: { field: string; value: unknown }) => void> = [];
  const player = { isPaused: true, isMediaLoaded: false, currentTime: 0, duration: 0, volumeLevel: 1, playerState: null as string | null };
  const controller = { playOrPause: vi.fn(() => { player.isPaused = !player.isPaused; }), seek: vi.fn(), setVolumeLevel: vi.fn(), stop: vi.fn() };
  const fw = {
    framework: {
      CastContext: { getInstance: () => context },
      CastContextEventType: { CAST_STATE_CHANGED: 'caststatechanged', SESSION_STATE_CHANGED: 'sessionstatechanged' },
      CastState: { NO_DEVICES_AVAILABLE: 'NO_DEVICES_AVAILABLE', NOT_CONNECTED: 'NOT_CONNECTED', CONNECTING: 'CONNECTING', CONNECTED: 'CONNECTED' },
      SessionState: { SESSION_STARTED: 'SESSION_STARTED', SESSION_RESUMED: 'SESSION_RESUMED', SESSION_ENDED: 'SESSION_ENDED', SESSION_START_FAILED: 'SESSION_START_FAILED' },
      RemotePlayer: function RemotePlayer() { return player; } as unknown as new () => typeof player,
      RemotePlayerController: function RemotePlayerController() {
        return { ...controller, addEventListener: (_t: string, l: (e: { field: string; value: unknown }) => void) => { playerChanges.push(l); } };
      } as unknown as new () => typeof controller,
      RemotePlayerEventType: { ANY_CHANGE: 'anyChanged' },
    },
    chromeCast: {
      AutoJoinPolicy: { PAGE_SCOPED: 'page_scoped' },
      media: {
        MediaInfo: class { metadata: unknown; streamType = ''; duration = 0; constructor(public contentId: string, public contentType: string) {} },
        MusicTrackMediaMetadata: class {},
        LoadRequest: class { autoplay = true; currentTime = 0; constructor(public info: unknown) {} },
        StreamType: { BUFFERED: 'BUFFERED' },
        IdleReason: { FINISHED: 'FINISHED', ERROR: 'ERROR' },
      },
      Image: class { constructor(public url: string) {} },
    },
  };
  return {
    fw, context, session, player, controller, loads, media,
    setCastState(s: string) { castState = s; emit('caststatechanged', { castState: s }); },
    endSession() { castState = 'NOT_CONNECTED'; emit('sessionstatechanged', { sessionState: 'SESSION_ENDED' }); emit('caststatechanged', { castState }); },
    change(field: string, value: unknown) { (player as Record<string, unknown>)[field] = value; playerChanges.forEach((l) => l({ field, value })); },
  };
}

describe('the Cast SDK (Chrome on a desktop)', () => {
  it('loads lazily, casts the queue with metadata and signed links, mirrors the keys and plays the next track when one ends', async () => {
    const { engine, cast } = await boot(MAC_CHROME);
    const sdk = fakeSdk();
    const load = vi.fn(async () => sdk.fw as never);
    cast.startCastWatch(elementEnv(), load);
    await flush();
    expect(load).toHaveBeenCalledOnce();
    expect(sdk.context.setOptions).toHaveBeenCalledWith({ receiverApplicationId: 'CC1AD845', autoJoinPolicy: 'page_scoped' });
    expect(cast.useCastStore.getState()).toMatchObject({ kind: 'cast', available: true, state: 'off' });

    engine.playAt(0);
    const [a] = FakeAudio.made as [FakeAudio];
    a.dispatchEvent(new Event('playing'));
    engine.usePlayerStore.setState({ position: 12 });
    cast.chooseCastDevice();
    expect(sdk.context.requestSession).toHaveBeenCalledOnce();
    sdk.setCastState('CONNECTING');
    expect(cast.useCastStore.getState().state).toBe('connecting');
    sdk.setCastState('CONNECTED');
    expect(cast.useCastStore.getState()).toMatchObject({ state: 'on', device: 'Living Room' });
    // the element is silent now; the receiver gets the track from where it was
    expect(a.src).toBe('');
    await flush();
    expect(sdk.loads).toHaveLength(1);
    const first = sdk.loads[0]!;
    expect(first.info.contentId).toBe(`${ORIGIN}/api/v1/player/cast/tok-t1?format=original`);
    expect(first.info.contentType).toBe('audio/flac');
    expect(first.info.streamType).toBe('BUFFERED');
    expect(first.info.metadata).toMatchObject({ title: 'Song t1', artist: 'Artist', albumName: 'Album', trackNumber: 2 });
    expect(first.info.metadata.images[0].url).toBe(`${ORIGIN}/api/v1/player/cast-cover/cov-t1`);
    expect(first).toMatchObject({ autoplay: true, currentTime: 12 });

    // the receiver's state and time show in the bar
    sdk.change('playerState', 'PLAYING');
    sdk.player.isPaused = false;
    expect(engine.usePlayerStore.getState().status).toBe('playing');
    sdk.player.duration = 100;
    sdk.change('currentTime', 40);
    expect(engine.usePlayerStore.getState().position).toBe(40);
    sdk.change('volumeLevel', 0.4);
    expect(engine.usePlayerStore.getState().volume).toBe(0.4);

    // the bar's keys go to the receiver
    engine.pause();
    expect(sdk.controller.playOrPause).toHaveBeenCalledTimes(1);
    engine.play();
    expect(sdk.controller.playOrPause).toHaveBeenCalledTimes(2);
    engine.seek(55);
    expect(sdk.player.currentTime).toBe(55);
    expect(sdk.controller.seek).toHaveBeenCalledOnce();
    engine.setVolume(0.7);
    expect(sdk.player.volumeLevel).toBe(0.7);
    expect(sdk.controller.setVolumeLevel).toHaveBeenCalled();

    // the receiver finished the track: tagave's next one goes there
    sdk.media.idleReason = 'FINISHED';
    sdk.change('playerState', 'IDLE');
    expect(engine.usePlayerStore.getState().index).toBe(1);
    await flush();
    expect(sdk.loads).toHaveLength(2);
    expect(sdk.loads[1]!.info.contentId).toContain('tok-t2');
    expect(sdk.loads[1]!.currentTime).toBe(0);
    // an IDLE left over from the track that was replaced is not a second end
    sdk.change('playerState', 'IDLE');
    expect(engine.usePlayerStore.getState().index).toBe(1);
    engine.next();
    await flush();
    expect(sdk.loads[2]!.info.contentId).toContain('tok-t3');
    expect(fetchMock.mock.calls.some(([u]) => String(u).endsWith('/player/events'))).toBe(true);

    // the session ends: paused here, where it was
    sdk.endSession();
    expect(cast.useCastStore.getState().state).toBe('off');
    expect(engine.usePlayerStore.getState().status).toBe('paused');
    engine.play();
    expect(a.src).toContain('/api/v1/player/stream/t3');
    cast.stopCastWatch();
  });

  it('casts a transcode where the receiver cannot play the file, and says when there is no link', async () => {
    const { engine, cast } = await boot(MAC_CHROME);
    engine.usePlayerStore.setState({
      queue: { context: null, tracks: [{ ...track('a1', 'audio/mp4; codecs="alac"'), origin: 'context', uid: 'x' }], scanRequested: false }, index: -1,
    });
    const sdk = fakeSdk();
    cast.startCastWatch(elementEnv(), async () => sdk.fw as never);
    await flush();
    sdk.setCastState('CONNECTED');
    engine.playAt(0);
    await flush();
    expect(sdk.loads[0]!.info.contentType).toBe('audio/ogg');
    expect(minted.at(-1)).toMatchObject({ localTrackId: 'a1', format: 'opus' });
    // seeking a transcode loads it again from that second
    engine.seek(30);
    await flush();
    expect(sdk.loads.at(-1)!.info.contentId).toContain('offset=30');
    cast.stopCastWatch();
  });

  it('shows no key when the SDK does not load', async () => {
    const { cast } = await boot(MAC_CHROME);
    cast.startCastWatch(elementEnv(), async () => null);
    await flush();
    expect(cast.useCastStore.getState()).toMatchObject({ kind: null, available: false });
    cast.stopCastWatch();
  });
});

describe('loading the SDK', () => {
  it('adds Google’s script once, and resolves when it says it is available', async () => {
    const { loadCastSdk, resetCastSdk, CAST_SDK_URL } = await import('./castSdk');
    resetCastSdk();
    const appended: Array<{ src: string }> = [];
    const win: any = { document: { createElement: () => ({}), head: { appendChild: (s: { src: string }) => appended.push(s) } } };
    const p = loadCastSdk(win, 1000);
    expect(loadCastSdk(win, 1000)).toBe(p);
    expect(appended.map((s) => s.src)).toEqual([CAST_SDK_URL]);
    win.cast = { framework: { CastContext: {} } };
    win.chrome = { cast: {} };
    win.__onGCastApiAvailable(true);
    expect(await p).toMatchObject({ framework: { CastContext: {} } });
    resetCastSdk();
    const failing: any = { document: { createElement: () => ({}), head: { appendChild: (s: { onerror: () => void }) => setTimeout(() => s.onerror(), 0) } } };
    expect(await loadCastSdk(failing, 1000)).toBeNull();
    resetCastSdk();
  });
});
