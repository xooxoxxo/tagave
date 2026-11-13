/**
 * The Google Cast Web Sender SDK, for Chrome on a desktop (there the Remote
 * Playback API does not cast audio). Loaded from Google at runtime, only in
 * that browser, only once tagave looks for cast devices; when it does not
 * load (blocked, offline, Brave without its media router), there is no cast
 * key and nothing else changes.
 *
 * The receiver is Google's Default Media Receiver (CC1AD845). It is given a
 * MediaInfo with the track's signed link (castLinks.ts), its type and the
 * title, artist, album and cover; the engine stays in charge of the queue
 * (CastSink is its RemoteSink): when the receiver finishes a track, the
 * engine loads the next one of tagave's queue into it.
 *
 * Only the few SDK calls used here are typed (CastFramework below), so tests
 * pass a fake of the same shape.
 */
import type { QueueEntry, RemoteSink } from './engine';
import type { StreamFormat } from '@tagave/shared';
import type { CanPlay } from './logic';

export const CAST_SDK_URL = 'https://www.gstatic.com/cv/js/sender/v1/cast_sender.js?loadCastFramework=1';
export const DEFAULT_MEDIA_RECEIVER = 'CC1AD845';

/* eslint-disable @typescript-eslint/no-explicit-any */
export interface CastMediaSession {
  idleReason?: string | null;
  playerState?: string;
}
export interface CastSessionLike {
  getCastDevice(): { friendlyName?: string };
  loadMedia(request: unknown): Promise<unknown>;
  getMediaSession(): CastMediaSession | null;
}
export interface CastContextLike {
  setOptions(options: Record<string, unknown>): void;
  addEventListener(type: string, listener: (event: any) => void): void;
  getCastState(): string;
  getCurrentSession(): CastSessionLike | null;
  requestSession(): Promise<unknown>;
  endCurrentSession(stopCasting: boolean): void;
}
export interface RemotePlayerLike {
  isPaused: boolean;
  isMediaLoaded: boolean;
  currentTime: number;
  duration: number;
  volumeLevel: number;
  playerState: string | null;
}
export interface RemotePlayerControllerLike {
  addEventListener(type: string, listener: (event: { field: string; value: unknown }) => void): void;
  playOrPause(): void;
  seek(): void;
  setVolumeLevel(): void;
  stop(): void;
}
/** window.cast.framework and window.chrome.cast, as far as tagave uses them. */
export interface CastFramework {
  framework: {
    CastContext: { getInstance(): CastContextLike };
    CastContextEventType: { CAST_STATE_CHANGED: string; SESSION_STATE_CHANGED: string };
    CastState: { NO_DEVICES_AVAILABLE: string; NOT_CONNECTED: string; CONNECTING: string; CONNECTED: string };
    SessionState: { SESSION_STARTED: string; SESSION_RESUMED: string; SESSION_ENDED: string; SESSION_START_FAILED: string };
    RemotePlayer: new () => RemotePlayerLike;
    RemotePlayerController: new (player: RemotePlayerLike) => RemotePlayerControllerLike;
    RemotePlayerEventType: { ANY_CHANGE: string };
  };
  chromeCast: {
    AutoJoinPolicy: { PAGE_SCOPED: string };
    media: {
      MediaInfo: new (contentId: string, contentType: string) => any;
      MusicTrackMediaMetadata: new () => any;
      LoadRequest: new (info: unknown) => any;
      StreamType: { BUFFERED: string };
      IdleReason: { FINISHED: string; ERROR: string };
    };
    Image: new (url: string) => any;
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

type CastWindow = Window & {
  __onGCastApiAvailable?: (available: boolean) => void;
  cast?: { framework?: CastFramework['framework'] };
  chrome?: { cast?: CastFramework['chromeCast'] };
};

let loading: Promise<CastFramework | null> | null = null;

/** The SDK, once: null when it does not load in `timeoutMs` or says casting is not available here. */
export function loadCastSdk(win: CastWindow = window as CastWindow, timeoutMs = 15_000): Promise<CastFramework | null> {
  if (loading) return loading;
  loading = new Promise<CastFramework | null>((resolve) => {
    const done = (fw: CastFramework | null) => { clearTimeout(timer); resolve(fw); };
    const timer = setTimeout(() => done(null), timeoutMs);
    win.__onGCastApiAvailable = (available) => {
      const framework = win.cast?.framework;
      const chromeCast = win.chrome?.cast;
      done(available && framework && chromeCast ? { framework, chromeCast } : null);
    };
    try {
      const script = win.document.createElement('script');
      script.src = CAST_SDK_URL;
      script.async = true;
      script.onerror = () => done(null);
      win.document.head.appendChild(script);
    } catch {
      done(null);
    }
  });
  return loading;
}

/** Tests. */
export function resetCastSdk(): void {
  loading = null;
}

/** What the Default Media Receiver plays as the original file (Chromecast's media list; no ALAC). */
export const receiverCanPlay: CanPlay = (type) => {
  const t = type.toLowerCase();
  if (/alac/.test(t)) return '';
  return /^audio\/(flac|x-flac|mpeg|mp3|aac|mp4|x-m4a|ogg|opus|wav|x-wav|wave|webm)\b/.test(t) ? 'probably' : '';
};

/** The type the receiver is told: the file's own for the original, else the transcode's. */
export function castContentType(format: StreamFormat, mime: string | null): string {
  if (format === 'original') return mime || 'audio/mpeg';
  return format === 'opus' ? 'audio/ogg' : format === 'aac' ? 'audio/aac' : 'audio/mpeg';
}

export interface CastLinkSource {
  /** absolute links for a track and its cover (PUBLIC_URL), or null when there are none */
  link(track: QueueEntry, format: StreamFormat, offset: number): Promise<{ url: string; coverUrl: string | null } | null>;
}

export interface CastSinkEvents {
  time(currentTime: number, duration: number | null): void;
  state(state: 'playing' | 'paused' | 'buffering'): void;
  ended(): void;
  failed(message: string): void;
  volume(volume: number): void;
}

/**
 * The receiver as the engine's RemoteSink: loads, transport and volume go to
 * it; its time, state, end and volume come back as events.
 */
export class CastSink implements RemoteSink {
  readonly canPlay = receiverCanPlay;
  private readonly player: RemotePlayerLike;
  private readonly controller: RemotePlayerControllerLike;
  /** bumped by every load: a late answer for an old track is ignored */
  private loads = 0;
  /** the load whose end was already reported */
  private endedLoad = -1;
  private loadedLoad = -1;
  private activeLoad = -1;

  constructor(private readonly fw: CastFramework, private readonly session: CastSessionLike, private readonly links: CastLinkSource, private readonly on: CastSinkEvents) {
    this.player = new fw.framework.RemotePlayer();
    this.controller = new fw.framework.RemotePlayerController(this.player);
    this.controller.addEventListener(fw.framework.RemotePlayerEventType.ANY_CHANGE, (e) => this.change(e.field));
  }

  get device(): string | null {
    try { return this.session.getCastDevice()?.friendlyName || null; } catch { return null; }
  }

  load(track: QueueEntry, opts: { format: StreamFormat; offset: number; autoplay: boolean }): void {
    const n = ++this.loads;
    const { media, Image } = { media: this.fw.chromeCast.media, Image: this.fw.chromeCast.Image };
    void this.links.link(track, opts.format, opts.offset).then(async (links) => {
      if (n !== this.loads) return;
      if (!links) { this.on.failed('Casting needs PUBLIC_URL.'); return; }
      const info = new media.MediaInfo(links.url, castContentType(opts.format, track.mime));
      info.streamType = media.StreamType.BUFFERED;
      if (track.durationMs) info.duration = opts.format === 'original' ? track.durationMs / 1000 : Math.max(0, track.durationMs / 1000 - opts.offset);
      const meta = new media.MusicTrackMediaMetadata();
      meta.title = track.title;
      meta.artist = track.artist || track.albumArtist;
      meta.albumName = track.album;
      meta.albumArtist = track.albumArtist;
      if (track.trackNo) meta.trackNumber = track.trackNo;
      if (track.discNo) meta.discNumber = track.discNo;
      meta.images = links.coverUrl ? [new Image(links.coverUrl)] : [];
      info.metadata = meta;
      const request = new media.LoadRequest(info);
      request.autoplay = opts.autoplay;
      request.currentTime = opts.format === 'original' ? opts.offset : 0;
      try {
        await this.session.loadMedia(request);
        if (n === this.loads) this.loadedLoad = n;
      } catch {
        if (n === this.loads) this.on.failed('The cast device could not play this track.');
      }
    }, () => {
      if (n === this.loads) this.on.failed('tagave could not make a link for the cast device.');
    });
  }

  play(): void { if (this.player.isPaused) this.controller.playOrPause(); }
  pause(): void { if (!this.player.isPaused) this.controller.playOrPause(); }
  seek(sec: number): void { this.player.currentTime = sec; this.controller.seek(); }
  setVolume(volume: number): void { this.player.volumeLevel = volume; this.controller.setVolumeLevel(); }
  stop(): void { this.loads++; this.controller.stop(); }

  private change(field: string) {
    const p = this.player;
    if (field === 'currentTime' || field === 'duration') {
      this.on.time(p.currentTime, Number.isFinite(p.duration) && p.duration > 0 ? p.duration : null);
      return;
    }
    if (field === 'volumeLevel') { this.on.volume(p.volumeLevel); return; }
    if (field !== 'playerState' && field !== 'isPaused') return;
    const state = p.playerState;
    // the track this load put there has been seen playing (or paused, or waiting)
    if ((state === 'PLAYING' || state === 'BUFFERING' || state === 'PAUSED') && this.loadedLoad === this.loads) this.activeLoad = this.loads;
    if (state === 'PLAYING') this.on.state('playing');
    else if (state === 'BUFFERING') this.on.state('buffering');
    else if (state === 'PAUSED') this.on.state('paused');
    // an IDLE left over from the track a load replaced is not this one's end
    else if (state === 'IDLE' && this.activeLoad === this.loads && this.endedLoad !== this.loads) {
      // IDLE after a track that was loaded: finished, failed, or stopped from elsewhere
      const reason = this.session.getMediaSession()?.idleReason ?? null;
      const media = this.fw.chromeCast.media;
      const nearEnd = p.duration > 0 && p.currentTime >= p.duration - 2;
      if (reason === media.IdleReason.FINISHED || (reason == null && nearEnd)) {
        this.endedLoad = this.loads;
        this.on.ended();
      } else if (reason === media.IdleReason.ERROR) {
        this.endedLoad = this.loads;
        this.on.failed('The cast device could not play this track.');
      } else {
        this.on.state('paused');
      }
    }
  }
}
