/**
 * Play in one place, Spotify Connect style, within one person's own
 * sessions. Every tab with the player is a device (deviceIdentity.ts); the
 * one that plays is the queue's device on the server (engine.ts claims it
 * with PUT /me/player/queue mode play). Here:
 *
 *   - this device's state goes to the server every HEARTBEAT_MS and on a
 *     change (PUT /me/player/device); the server says a device is gone after
 *     about 20 s without one;
 *   - the person's events (GET /me/player/events, one stream per browser,
 *     shared by its tabs: services/sharedStream.ts) say which devices are
 *     there, what the one that plays is doing, when the queue was written
 *     (another device started playing: this one stops at once) and which
 *     commands are for this device;
 *   - while another device plays, this one shows it (engine.mirrorRemote,
 *     the place moving on between states) and its keys go there
 *     (POST /me/player/command);
 *   - the device menu moves playback: to another device (transferTo), or
 *     here ("This device").
 *
 * When the device that plays goes away, the others show it paused where it
 * was last heard of, and Play plays here.
 */
import { create } from 'zustand';
import {
  PLAYER_EVENT_TYPES, type PlayerActive, type PlayerCommandAction, type PlayerCommandEvent, type PlayerDeviceState, type PlayerDeviceView,
  type PlayerDevicesEvent, type PlayerQueueEvent,
} from '@tagave/shared';
import { api } from '../services/api';
import { SharedStream } from '../services/sharedStream';
import {
  currentTrack, handOff, isRemote, mirrorRemote, next, pause, play, playAt, playHere, playsHere, previous, queueRevision, restAt, seek, setRemoteControl,
  setVolume, syncQueue, takeOver, usePlayerStore, type PlayerState, type RemoteState,
} from './engine';
import { deviceId, deviceName, onDeviceIdChange, setDeviceName } from './deviceIdentity';
import { castLine, useCastStore } from './cast';

export const HEARTBEAT_MS = 5_000;
/** how often the other device's place moves on here between its states */
const TICK_MS = 500;

export interface DevicesState {
  /** the person's devices the server knows of (online or not), this one among them */
  devices: PlayerDeviceView[];
  active: PlayerActive | null;
  /** this device */
  me: string;
  name: string;
  /** when the last devices event arrived (this clock) */
  receivedAt: number;
}

export const useDevicesStore = create<DevicesState>()(() => ({ devices: [], active: null, me: '', name: '', receivedAt: 0 }));
const dget = () => useDevicesStore.getState();

/** The device that plays when it is another one (online or not), or null. */
export function remoteDevice(s: DevicesState = dget()): PlayerDeviceView | null {
  if (!s.active || s.active.deviceId === s.me) return null;
  return s.devices.find((d) => d.deviceId === s.active!.deviceId) ?? null;
}

/** The devices to choose from: online ones, this one first. */
export function choosableDevices(s: DevicesState = dget()): PlayerDeviceView[] {
  return s.devices.filter((d) => d.online || d.deviceId === s.me).sort((a, b) => (a.deviceId === s.me ? -1 : b.deviceId === s.me ? 1 : 0));
}

// ---- this device's state ----

const PLAYING: ReadonlySet<PlayerState['status']> = new Set(['playing', 'buffering', 'loading']);

/** Whether this device speaks for the queue: it plays, or the server says it is the one that does. */
function speaksForQueue(): boolean {
  return !isRemote() && (playsHere() || dget().active?.deviceId === deviceId());
}

/** What this device tells the others. */
export function deviceState(s: PlayerState = usePlayerStore.getState()): PlayerDeviceState {
  const own = speaksForQueue();
  const t = own ? currentTrack(s) : null;
  return {
    deviceId: deviceId(),
    name: dget().name || deviceName(),
    track: t ? { localTrackId: t.localTrackId, title: t.title, artist: t.artist || t.albumArtist, album: t.album, albumId: t.albumId ?? null, coverUrl: t.coverUrl, durationMs: t.durationMs ?? null } : null,
    index: own && t ? s.index : -1,
    positionMs: own && t ? Math.min(24 * 3600_000, Math.max(0, Math.round(s.position * 1000))) : 0,
    playing: own && PLAYING.has(s.status),
    blocked: own && s.needsTap,
    volume: Math.min(1, Math.max(0, s.volume)),
    hidden: globalThis.document?.visibilityState === 'hidden',
    casting: own ? castLine(useCastStore.getState()) : null,
  };
}

let sendTimer: ReturnType<typeof setTimeout> | null = null;
let lastSent = '';

function sendState(soon = false) {
  if (sendTimer) clearTimeout(sendTimer);
  sendTimer = null;
  if (soon) {
    sendTimer = setTimeout(() => sendState(false), 250);
    return;
  }
  const state = deviceState();
  lastSent = JSON.stringify({ ...state, positionMs: Math.round(state.positionMs / 1000) });
  void api.put('/me/player/device', state).catch(() => undefined);
}

// ---- what the device that plays is doing, here ----

function remoteState(d: PlayerDeviceView, receivedAt: number): RemoteState {
  const since = d.playing ? d.ageMs + (Date.now() - receivedAt) : 0;
  const durationMs = d.track?.durationMs ?? null;
  const ms = d.positionMs + since;
  return {
    index: d.index,
    trackId: d.track?.localTrackId ?? null,
    position: (durationMs ? Math.min(ms, durationMs) : ms) / 1000,
    playing: d.playing,
    volume: d.volume,
    durationMs,
  };
}

let lastFollow = 0;
/** the device whose last state this one rested at (it went away), so it is done once */
let restedFor: string | null = null;

function follow() {
  const now = Date.now();
  if (now - lastFollow < 2000) return;
  lastFollow = now;
  void syncQueue().then(evaluate, () => undefined);
}

function control(target: string) {
  return {
    send(action: PlayerCommandAction, opts: { value?: number; index?: number } = {}) {
      void api.post('/me/player/command', { deviceId: target, action, from: deviceId(), ...opts }).catch(() => undefined);
    },
  };
}

/** Which device this one is, after an event: on its own, showing another, or resting where the one that played went away. */
export function evaluate() {
  const s = dget();
  const me = deviceId();
  const active = s.active;
  if (!active || active.deviceId === me || playsHere()) {
    // this device plays (or has audio of its own: a newer claim elsewhere arrives as a queue event)
    if (isRemote()) setRemoteControl(null);
    restedFor = null;
    return;
  }
  const other = s.devices.find((d) => d.deviceId === active.deviceId);
  if (!other) {
    if (isRemote()) setRemoteControl(null);
    return;
  }
  if (!other.online) {
    if (isRemote() || restedFor !== other.deviceId) {
      restedFor = other.deviceId;
      if (other.track) restAt(remoteState(other, s.receivedAt));
      else setRemoteControl(null);
    }
    return;
  }
  restedFor = null;
  setRemoteControl(control(other.deviceId), other.deviceId);
  mirror();
}

function mirror() {
  if (!isRemote()) return;
  const other = remoteDevice();
  if (!other) return;
  if (!other.track) {
    if (usePlayerStore.getState().status === 'playing') usePlayerStore.setState({ status: 'paused' });
    return;
  }
  if (!mirrorRemote(remoteState(other, dget().receivedAt))) follow();
}

// ---- commands for this device ----

function execute(c: PlayerCommandEvent) {
  if (c.action === 'transfer') {
    // a page in the background starts nothing by itself: it waits for a tap
    const hidden = globalThis.document?.visibilityState === 'hidden';
    void takeOver(c.index ?? 0, c.value ?? 0, { autoplay: !hidden }).then(() => sendState());
    return;
  }
  // a command for a device that does not play (it moved on meanwhile) would only bounce back
  if (isRemote()) return;
  switch (c.action) {
    case 'play': play(); break;
    case 'pause': pause(); break;
    case 'next': next(); break;
    case 'previous': previous(); break;
    case 'seek': if (c.value != null) seek(c.value); break;
    case 'volume': if (c.value != null) setVolume(c.value); break;
    case 'index': if (c.index != null) playAt(c.index); break;
  }
  sendState(true);
}

// ---- the menu ----

/**
 * Plays on `target`: another device (this one, or the one that plays, goes
 * quiet once it has written its place) or this one ("This device").
 */
export async function transferTo(target: string): Promise<void> {
  const me = deviceId();
  if (target === me) {
    if (isRemote() || !playsHere()) playHere();
    sendState();
    return;
  }
  if (isRemote()) {
    // from a device that only shows: straight from the one that plays to the chosen one
    const s = usePlayerStore.getState();
    if (s.index < 0) return;
    if (remoteDevice()?.deviceId === target) return;
    await api.post('/me/player/command', { deviceId: target, action: 'transfer', index: s.index, value: Math.max(0, s.position), from: me }).catch(() => undefined);
    return;
  }
  const at = await handOff();
  sendState();
  if (!at) return;
  await api.post('/me/player/command', { deviceId: target, action: 'transfer', index: at.index, value: Math.max(0, at.position), from: me }).catch(() => undefined);
}

/** Renames this browser (every tab of it); a blank name goes back to the default. */
export function renameDevice(raw: string): string {
  const name = setDeviceName(raw);
  useDevicesStore.setState({ name });
  sendState();
  return name;
}

// ---- the stream ----

function onEvent(type: string, data: string) {
  let payload: unknown;
  try { payload = JSON.parse(data); } catch { return; }
  switch (type) {
    case 'hello':
      sendState();
      return;
    case 'devices': {
      const e = payload as PlayerDevicesEvent;
      useDevicesStore.setState({ devices: e.devices ?? [], active: e.active ?? null, receivedAt: Date.now() });
      evaluate();
      return;
    }
    case 'queue': {
      const q = payload as PlayerQueueEvent;
      if (q.mode === 'clear') return;
      if (q.deviceId && (q.mode === 'play' || q.mode === 'save')) {
        const active = dget().active;
        if (!active || q.revision >= active.revision) useDevicesStore.setState({ active: { deviceId: q.deviceId, revision: q.revision } });
      }
      // another device started playing (this one stops), or the queue changed: follow it (not this device's own writes)
      const own = q.deviceId === deviceId() && q.mode !== 'edit';
      if (!own && q.revision > queueRevision()) void syncQueue().then(evaluate, () => undefined);
      else evaluate();
      return;
    }
    case 'command': {
      const c = payload as PlayerCommandEvent;
      if (c.to === deviceId()) execute(c);
    }
  }
}

let users = 0;
let stopAll: (() => void) | null = null;

/** Joins: this device is listed, follows the others and can be controlled. Returns the leave. */
export function startDevices(): () => void {
  users++;
  if (users === 1) stopAll = begin();
  return () => {
    users--;
    if (users === 0) { stopAll?.(); stopAll = null; }
  };
}

function begin(): () => void {
  useDevicesStore.setState({ me: deviceId(), name: deviceName() });
  const stream = new SharedStream({
    url: '/api/v1/me/player/events',
    leaseKey: 'tagave:player-events-leader',
    channelName: 'tagave:player-events',
    eventTypes: PLAYER_EVENT_TYPES,
  });
  stream.listeners.add(onEvent);
  stream.start();
  sendState();
  const heartbeat = setInterval(() => sendState(), HEARTBEAT_MS);
  const tick = setInterval(mirror, TICK_MS);
  // a change another device shows goes out at once; the place only when it jumps (a seek)
  const unwatch = usePlayerStore.subscribe((s, prev) => {
    if (isRemote()) return;
    if (s.status !== prev.status || s.index !== prev.index || s.needsTap !== prev.needsTap || Math.abs(s.volume - prev.volume) > 0.01
      || Math.abs(s.position - prev.position) > 2 || s.queue !== prev.queue) {
      const state = deviceState(s);
      if (JSON.stringify({ ...state, positionMs: Math.round(state.positionMs / 1000) }) !== lastSent) sendState(true);
    }
  });
  const unwatchCast = useCastStore.subscribe((c, prev) => { if (castLine(c) !== castLine(prev)) sendState(true); });
  const unwatchId = onDeviceIdChange((id) => { useDevicesStore.setState({ me: id }); sendState(); });
  const onVisibility = () => sendState();
  const onLeave = () => {
    try {
      void fetch(`/api/v1/me/player/device/${encodeURIComponent(deviceId())}`, { method: 'DELETE', keepalive: true, credentials: 'include' }).catch(() => undefined);
    } catch { /* dropped: the heartbeat runs out instead */ }
  };
  const onShow = () => sendState();
  const onStorage = (e: StorageEvent) => { if (e.key === 'tagave-player-device-name') { useDevicesStore.setState({ name: deviceName() }); sendState(); } };
  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('pagehide', onLeave);
  window.addEventListener('pageshow', onShow);
  window.addEventListener('storage', onStorage);
  return () => {
    stream.listeners.delete(onEvent);
    stream.stop();
    clearInterval(heartbeat);
    clearInterval(tick);
    if (sendTimer) clearTimeout(sendTimer);
    sendTimer = null;
    unwatch();
    unwatchCast();
    unwatchId();
    document.removeEventListener('visibilitychange', onVisibility);
    window.removeEventListener('pagehide', onLeave);
    window.removeEventListener('pageshow', onShow);
    window.removeEventListener('storage', onStorage);
    setRemoteControl(null);
  };
}
