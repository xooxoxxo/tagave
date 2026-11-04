/**
 * Casting, per browser:
 *
 *   airplay  Safari (iPhone, iPad, Mac): WebKit says when AirPlay targets are
 *            around; the key opens the system picker for the playing element
 *            and webkitcurrentplaybacktargetiswireless says it went there.
 *   remote   Chrome on Android: the Remote Playback API on the element
 *            (watchAvailability, prompt, connecting / connect / disconnect).
 *   cast     Chrome (and Edge) on a desktop: the Google Cast SDK, loaded
 *            from Google only here (castSdk.ts); a receiver plays instead
 *            of the element.
 *
 * Firefox, and anything else, has none: there is no key.
 *
 * In every case the device fetches the music itself, from a signed link on
 * PUBLIC_URL (castLinks.ts). The key reads useCastStore: shown while a
 * device is there (or while casting), and when PUBLIC_URL cannot be reached
 * from one it opens a menu that says so instead of the picker.
 */
import {
  activeElement, armCastLinks, attachSink, currentTrack, detachSink, disarmCastLinks, ensurePlayerElements, setElementRoute,
  sinkEnded, sinkFailed, sinkState, sinkTime, sinkVolume, usePlayerStore, watchElements, type QueueEntry,
} from './engine';
import { castSrc, fetchCastLink, initialCast, useCastStore, type CastKind, type CastState } from './castLinks';
import { CastSink, DEFAULT_MEDIA_RECEIVER, loadCastSdk, receiverCanPlay, type CastFramework } from './castSdk';
import { chooseFormat } from './logic';
import { getPlayerQuality } from './quality';
import { isAppleMobile } from './platform';
import type { StreamFormat } from '@tagave/shared';

export { useCastStore, isCasting, type CastKind, type CastState } from './castLinks';

type Nav = Pick<Navigator, 'userAgent' | 'platform' | 'maxTouchPoints'> & { userAgentData?: { mobile?: boolean; brands?: Array<{ brand: string }> } };
interface CastEnv {
  navigator?: Nav;
  isSecureContext?: boolean;
  WebKitPlaybackTargetAvailabilityEvent?: unknown;
  HTMLMediaElement?: { prototype: object };
}

/** Chrome or Edge on a computer (not Android, not iOS, where Chrome is Safari underneath). */
export function isDesktopChromium(nav: Nav | undefined): boolean {
  if (!nav) return false;
  if (nav.userAgentData?.mobile) return false;
  const ua = nav.userAgent;
  if (/Android|Mobi|iPhone|iPad|iPod|CriOS|EdgiOS/i.test(ua) || isAppleMobile(nav)) return false;
  return /\b(Chrome|Chromium|Edg)\/\d+/.test(ua) && !/OPR\//.test(ua);
}

/** How this browser casts, or null. */
export function castKindFor(env: CastEnv = globalThis as unknown as CastEnv): CastKind | null {
  if (typeof env.WebKitPlaybackTargetAvailabilityEvent !== 'undefined') return 'airplay';
  const nav = env.navigator;
  if (!nav) return null;
  // the Cast SDK and Remote Playback both need a secure page (https, or localhost)
  if (env.isSecureContext === false) return null;
  if (isDesktopChromium(nav)) return 'cast';
  if (/Android/i.test(nav.userAgent) && env.HTMLMediaElement && 'remote' in env.HTMLMediaElement.prototype) return 'remote';
  return null;
}

const patch = (p: Partial<CastState>) => useCastStore.setState(p);

/** The line under the names while casting; null when not casting. */
export function castLine(s: Pick<CastState, 'state' | 'device' | 'kind'>): string | null {
  if (s.state === 'off') return null;
  if (s.device) return `Casting to ${s.device}`;
  return s.kind === 'airplay' ? 'AirPlay' : 'Casting';
}

/** What the key does: open the picker, or (PUBLIC_URL unreachable from a device) a menu saying why. */
export function castProblem(s: Pick<CastState, 'reach' | 'kind' | 'state'>): 'unreachable' | 'needs-https' | null {
  if (s.state !== 'off') return null;
  if (s.reach === 'loopback' || s.reach === 'unset') return 'unreachable';
  // AirPlay devices fetch plain http; a Chromecast's receiver page is https and blocks it
  if (s.reach === 'http' && s.kind !== 'airplay') return 'needs-https';
  return null;
}

// ---- the link for the playing track, made ahead so a click finds it ready ----

function linkFormat(track: QueueEntry, kind: CastKind | null): StreamFormat {
  const quality = getPlayerQuality();
  if (kind === 'cast') return chooseFormat(quality, track.mime, receiverCanPlay);
  const a = activeElement();
  return chooseFormat(quality, track.mime, (t) => { try { return a?.canPlayType(t) ?? ''; } catch { return ''; } });
}

let lastPrepared: string | null = null;
/** A device is around and a track is current: its link (and so the reach) is made now. */
function prepareLink() {
  const s = useCastStore.getState();
  const track = currentTrack();
  if (!s.available || !track) return;
  const format = linkFormat(track, s.kind);
  const key = `${track.localTrackId}|${format}`;
  if (key === lastPrepared) return;
  lastPrepared = key;
  void fetchCastLink(track.localTrackId, format, getPlayerQuality().bitrate).catch(() => { lastPrepared = null; });
}

// ---- AirPlay ----

type WebKitAudio = HTMLAudioElement & {
  webkitShowPlaybackTargetPicker?: () => void;
  webkitCurrentPlaybackTargetIsWireless?: boolean;
};

function watchAirPlay(): () => void {
  const seen = new WeakMap<HTMLAudioElement, boolean>();
  const offs: Array<() => void> = [];
  const update = (els: readonly HTMLAudioElement[]) => {
    const available = els.some((e) => seen.get(e));
    const wireless = els.some((e) => !!(e as WebKitAudio).webkitCurrentPlaybackTargetIsWireless);
    setElementRoute(wireless);
    patch({ available: available || wireless, state: wireless ? 'on' : 'off' });
    if (!wireless) disarmCastLinks();
  };
  offs.push(watchElements((els) => {
    for (const e of els) {
      const onAvail = (ev: Event) => { seen.set(e, (ev as Event & { availability?: string }).availability === 'available'); update(els); };
      const onWireless = () => update(els);
      e.addEventListener('webkitplaybacktargetavailabilitychanged', onAvail);
      e.addEventListener('webkitcurrentplaybacktargetiswirelesschanged', onWireless);
      offs.push(() => {
        e.removeEventListener('webkitplaybacktargetavailabilitychanged', onAvail);
        e.removeEventListener('webkitcurrentplaybacktargetiswirelesschanged', onWireless);
      });
    }
  }));
  // WebKit reports targets only for an element that exists
  ensurePlayerElements();
  return () => offs.forEach((off) => off());
}

// ---- Remote Playback (Chrome on Android) ----

type RemoteAudio = HTMLAudioElement & {
  remote?: RemotePlayback;
};

function watchRemote(): () => void {
  const offs: Array<() => void> = [];
  offs.push(watchElements((els) => {
    const avail = new Map<HTMLAudioElement, boolean>();
    const update = () => {
      const states = els.map((e) => (e as RemoteAudio).remote?.state ?? 'disconnected');
      const state = states.includes('connected') ? 'on' : states.includes('connecting') ? 'connecting' : 'off';
      setElementRoute(state !== 'off');
      if (state === 'off') disarmCastLinks();
      patch({ available: [...avail.values()].some(Boolean) || state !== 'off', state });
    };
    for (const e of els) {
      const remote = (e as RemoteAudio).remote;
      if (!remote) continue;
      const on = () => update();
      remote.addEventListener('connecting', on);
      remote.addEventListener('connect', on);
      remote.addEventListener('disconnect', on);
      let id: number | null = null;
      remote.watchAvailability((a) => { avail.set(e, a); update(); }).then((n) => { id = n; }, () => {
        // availability cannot be watched here (data saver, an old phone): no key, quietly
        avail.set(e, false);
        update();
      });
      offs.push(() => {
        remote.removeEventListener('connecting', on);
        remote.removeEventListener('connect', on);
        remote.removeEventListener('disconnect', on);
        if (id != null) void remote.cancelWatchAvailability(id).catch(() => undefined);
      });
    }
  }));
  ensurePlayerElements();
  return () => offs.forEach((off) => off());
}

// ---- the Cast SDK (Chrome on a desktop) ----

let sdk: CastFramework | null = null;
let sdkSink: CastSink | null = null;

function castLinks() {
  return {
    async link(track: QueueEntry, format: StreamFormat, offset: number) {
      const view = await fetchCastLink(track.localTrackId, format, getPlayerQuality().bitrate);
      const url = castSrc(view, format, offset, null);
      return url ? { url, coverUrl: view.coverUrl } : null;
    },
  };
}

function startSdk(fw: CastFramework): () => void {
  sdk = fw;
  const context = fw.framework.CastContext.getInstance();
  context.setOptions({ receiverApplicationId: DEFAULT_MEDIA_RECEIVER, autoJoinPolicy: fw.chromeCast.AutoJoinPolicy.PAGE_SCOPED });
  let live = true;
  const S = fw.framework.CastState;
  const onCastState = (castState: string) => {
    if (!live) return;
    if (castState === S.NO_DEVICES_AVAILABLE) { patch({ available: false, state: 'off', device: null }); return; }
    if (castState === S.NOT_CONNECTED) { patch({ available: true, state: 'off', device: null }); return; }
    if (castState === S.CONNECTING) { patch({ available: true, state: 'connecting' }); return; }
    if (castState === S.CONNECTED) {
      const session = context.getCurrentSession();
      if (!session) return;
      if (!sdkSink) {
        sdkSink = new CastSink(fw, session, castLinks(), {
          time: sinkTime, state: sinkState, ended: sinkEnded, failed: sinkFailed, volume: sinkVolume,
        });
        attachSink(sdkSink);
      }
      patch({ available: true, state: 'on', device: sdkSink.device });
    }
  };
  context.addEventListener(fw.framework.CastContextEventType.CAST_STATE_CHANGED, (e: { castState: string }) => onCastState(e.castState));
  context.addEventListener(fw.framework.CastContextEventType.SESSION_STATE_CHANGED, (e: { sessionState: string }) => {
    if (!live) return;
    if (e.sessionState === fw.framework.SessionState.SESSION_ENDED || e.sessionState === fw.framework.SessionState.SESSION_START_FAILED) {
      if (sdkSink) { sdkSink = null; detachSink(); }
      patch({ state: 'off', device: null });
    }
  });
  onCastState(context.getCastState());
  return () => { live = false; };
}

// ---- start, choose ----

let stopWatch: (() => void) | null = null;
let unsubscribeTrack: (() => void) | null = null;

/**
 * Starts looking for cast devices (PlayerBar, once something is queued).
 * The Cast SDK is fetched from Google here, on a desktop Chrome only.
 */
export function startCastWatch(env: CastEnv = globalThis as unknown as CastEnv, load: () => Promise<CastFramework | null> = () => loadCastSdk()): () => void {
  if (stopWatch) return stopCastWatch;
  const kind = castKindFor(env);
  patch({ ...initialCast, kind });
  if (!kind) { stopWatch = () => undefined; return stopCastWatch; }
  let stopKind: () => void = () => undefined;
  let live = true;
  if (kind === 'airplay') stopKind = watchAirPlay();
  else if (kind === 'remote') stopKind = watchRemote();
  else {
    void load().then((fw) => {
      if (!live) return;
      // no SDK: no key, quietly
      if (!fw) { patch({ kind: null, available: false }); return; }
      stopKind = startSdk(fw);
    });
  }
  const offAvail = useCastStore.subscribe((s, prev) => { if (s.available && !prev.available) prepareLink(); });
  unsubscribeTrack = usePlayerStore.subscribe((s, prev) => { if (s.index !== prev.index || s.queue !== prev.queue) prepareLink(); });
  prepareLink();
  stopWatch = () => { live = false; stopKind(); offAvail(); unsubscribeTrack?.(); unsubscribeTrack = null; };
  return stopCastWatch;
}

export function stopCastWatch(): void {
  stopWatch?.();
  stopWatch = null;
  lastPrepared = null;
  sdk = null;
  if (sdkSink) { sdkSink = null; detachSink(); }
  setElementRoute(false);
  patch({ ...initialCast });
}

/**
 * The cast key: the platform's device picker (which also stops casting).
 * Called from the click itself: the pickers open only from a user gesture.
 */
export function chooseCastDevice(): void {
  const { kind } = useCastStore.getState();
  if (kind === 'airplay' || kind === 'remote') {
    // the device fetches what the element loads: a signed link, before the picker opens
    armCastLinks();
    const a = activeElement() ?? ensurePlayerElements()[0];
    if (!a) return;
    if (kind === 'airplay') {
      try { (a as WebKitAudio).webkitShowPlaybackTargetPicker?.(); } catch { disarmCastLinks(); }
      return;
    }
    const remote = (a as RemoteAudio).remote;
    if (!remote) return;
    remote.prompt().catch(() => { if (remote.state === 'disconnected') disarmCastLinks(); });
    return;
  }
  if (kind === 'cast' && sdk) {
    const context = sdk.framework.CastContext.getInstance();
    if (useCastStore.getState().state === 'off') void context.requestSession().catch(() => undefined);
    else context.endCurrentSession(true);
  }
}
