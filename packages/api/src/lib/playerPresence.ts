/**
 * Who has the player open, per person, and what the device that plays is
 * doing: the memory behind GET /me/player/events (routes/playerDevices.ts).
 *
 * Nothing here is stored. Each device sends its state every few seconds
 * (PUT /me/player/device); a device is online while those keep coming. The
 * device that plays is the queue's (player_queue_state.device_id, 0055),
 * as before: this only says so to the other devices at once, where they used
 * to find out on their next poll.
 *
 * More than one api process: every change goes out as a Postgres NOTIFY on
 * `tagave_player`, and each process applies what it hears (its own changes
 * included) to its copy and to its own open streams. So a command reaches a
 * device whichever process holds its stream, and every process knows every
 * device. A process that cannot LISTEN applies its changes itself (one
 * process, as the image runs).
 */
import {
  PLAYER_EVENTS_CHANNEL, type PlayerActive, type PlayerCommandEvent, type PlayerDeviceState, type PlayerDeviceView, type PlayerDevicesEvent,
  type PlayerEventType, type PlayerQueueEvent,
} from '@tagave/shared';

/** No heartbeat for this long: the device is offline. */
export const ONLINE_MS = 20_000;
/** A page in the background that does not play: its timers may run only once a minute. */
export const HIDDEN_ONLINE_MS = 90_000;
/** An offline device is forgotten after this long (the one that played is shown, paused, until then). */
export const FORGET_MS = 30 * 60_000;
export const SWEEP_MS = 5_000;
/** At most this many devices per person; a new one past it takes the place of the longest-gone offline one. */
export const MAX_DEVICES = 20;
/** At most this many open streams per person; one more closes the oldest. */
export const MAX_SUBSCRIBERS = 10;
/** A person's devices event goes out at most once per this long (changes in between are sent together). */
export const DEVICES_THROTTLE_MS = 250;

export type PresenceMessage =
  | { t: 'state'; userId: string; state: PlayerDeviceState; at: number }
  | { t: 'leave'; userId: string; deviceId: string; at: number }
  | { t: 'command'; userId: string; command: PlayerCommandEvent }
  | { t: 'queue'; userId: string; queue: PlayerQueueEvent };

export interface Subscriber {
  send(type: PlayerEventType, data: unknown): void;
  /** ends the stream (it was one too many) */
  close?(): void;
}

interface Entry {
  state: PlayerDeviceState;
  /** this process's clock when the state arrived */
  seenAt: number;
  /** it said goodbye (pagehide): offline at once */
  left: boolean;
}

interface UserPresence {
  devices: Map<string, Entry>;
  active: PlayerActive | null;
  subs: Set<Subscriber>;
  /** what the last devices event said each device was (online or not), to send only on a change */
  shown: Map<string, boolean>;
  /** when the last devices event went out, and the one waiting to */
  lastSent: number;
  timer: ReturnType<typeof setTimeout> | null;
}

export interface PresenceBus {
  /** sends to every process (this one too); rejects when it cannot */
  publish(message: PresenceMessage): Promise<void>;
}

export class PlayerPresence {
  private readonly users = new Map<string, UserPresence>();
  private sweeper: ReturnType<typeof setInterval> | null = null;

  private readonly throttleMs: number;

  constructor(private bus: PresenceBus | null = null, private readonly now: () => number = Date.now, opts: { throttleMs?: number } = {}) {
    this.throttleMs = opts.throttleMs ?? DEVICES_THROTTLE_MS;
  }

  setBus(bus: PresenceBus | null): void {
    this.bus = bus;
  }

  private user(userId: string): UserPresence {
    let u = this.users.get(userId);
    if (!u) {
      u = { devices: new Map(), active: null, subs: new Set(), shown: new Map(), lastSent: 0, timer: null };
      this.users.set(userId, u);
    }
    return u;
  }

  /** Out to every process; applied here only when there is no bus or it failed. */
  async publish(message: PresenceMessage): Promise<void> {
    if (this.bus) {
      try {
        await this.bus.publish(message);
        return;
      } catch { /* applied here: this process's streams still hear it */ }
    }
    this.apply(message);
  }

  /** A message from the bus (or this process): the copy changes and this process's streams hear it. */
  apply(message: PresenceMessage): void {
    const u = this.user(message.userId);
    switch (message.t) {
      case 'state': {
        const before = u.devices.get(message.state.deviceId);
        if (!before && !this.makeRoom(u)) return;
        u.devices.set(message.state.deviceId, { state: message.state, seenAt: this.now(), left: false });
        // the device that plays: every state goes out (its place keeps the others' clocks true);
        // another device's heartbeat that changes nothing shown is not sent on
        const changed = !before || before.left || !this.isOnline(before, u) || !sameShown(before.state, message.state);
        this.sendDevices(message.userId, { onlyIfChanged: !changed && !this.stateWanted(message.userId, message.state.deviceId) });
        return;
      }
      case 'leave': {
        const e = u.devices.get(message.deviceId);
        if (e) {
          e.left = true;
          e.state = { ...e.state, playing: false };
        }
        this.sendDevices(message.userId);
        return;
      }
      case 'command':
        for (const s of u.subs) s.send('command', message.command);
        return;
      case 'queue': {
        const q = message.queue;
        const before = u.active;
        if (q.mode === 'clear' || !q.deviceId) u.active = null;
        else if (!u.active || q.revision >= u.active.revision) u.active = { deviceId: q.deviceId, revision: q.revision };
        for (const s of u.subs) s.send('queue', q);
        if (before?.deviceId !== u.active?.deviceId) this.sendDevices(message.userId);
      }
    }
  }

  /** Room for one more device: the longest-gone offline one goes when the person is at MAX_DEVICES. False when all are online. */
  private makeRoom(u: UserPresence): boolean {
    if (u.devices.size < MAX_DEVICES) return true;
    let oldest: [string, Entry] | null = null;
    for (const [id, e] of u.devices) {
      if (this.isOnline(e, u) || u.active?.deviceId === id) continue;
      if (!oldest || e.seenAt < oldest[1].seenAt) oldest = [id, e];
    }
    if (!oldest) return false;
    u.devices.delete(oldest[0]);
    u.shown.delete(oldest[0]);
    return true;
  }

  /**
   * Whether a state from `deviceId` would be taken: a device already listed,
   * or room for a new one (the route answers 429 otherwise).
   */
  admits(userId: string, deviceId: string): boolean {
    const u = this.users.get(userId);
    if (!u || u.devices.has(deviceId) || u.devices.size < MAX_DEVICES) return true;
    for (const [id, e] of u.devices) if (!this.isOnline(e, u) && u.active?.deviceId !== id) return true;
    return false;
  }

  /** How many streams the person has open here (tests). */
  subscriberCount(userId: string): number {
    return this.users.get(userId)?.subs.size ?? 0;
  }

  /** How many devices are listed for the person (tests). */
  deviceCount(userId: string): number {
    return this.users.get(userId)?.devices.size ?? 0;
  }

  /** The device that plays, as the queue's row says (read when a stream opens). */
  setActive(userId: string, active: PlayerActive | null): void {
    this.user(userId).active = active;
  }

  private ttl(e: Entry, u: UserPresence): number {
    const playsHere = u.active?.deviceId === e.state.deviceId;
    return e.state.hidden && !playsHere && !e.state.playing ? HIDDEN_ONLINE_MS : ONLINE_MS;
  }

  private isOnline(e: Entry, u: UserPresence): boolean {
    return !e.left && this.now() - e.seenAt < this.ttl(e, u);
  }

  /** The devices event for one person. */
  snapshot(userId: string): PlayerDevicesEvent {
    const u = this.user(userId);
    const now = this.now();
    const devices: PlayerDeviceView[] = [];
    for (const e of u.devices.values()) {
      const online = this.isOnline(e, u);
      devices.push({ ...e.state, playing: online && e.state.playing, online, ageMs: Math.max(0, now - e.seenAt) });
    }
    devices.sort((a, b) => a.name.localeCompare(b.name) || a.deviceId.localeCompare(b.deviceId));
    return { devices, active: u.active };
  }

  /** Whether `deviceId` is one of this person's devices, online. */
  hasDevice(userId: string, deviceId: string): boolean {
    const u = this.users.get(userId);
    const e = u?.devices.get(deviceId);
    return !!u && !!e && this.isOnline(e, u);
  }

  private sendDevices(userId: string, opts: { onlyIfChanged?: boolean } = {}): void {
    const u = this.users.get(userId);
    if (!u) return;
    const snap = this.snapshot(userId);
    const shown = new Map(snap.devices.map((d) => [d.deviceId, d.online]));
    const changed = shown.size !== u.shown.size || [...shown].some(([id, on]) => u.shown.get(id) !== on);
    u.shown = shown;
    if (opts.onlyIfChanged && !changed) return;
    if (u.timer) return;
    const wait = u.lastSent + this.throttleMs - this.now();
    if (wait > 0) {
      // sent together a moment later, as things are then
      u.timer = setTimeout(() => { u.timer = null; this.emitDevices(userId); }, wait);
      u.timer.unref?.();
      return;
    }
    this.emitDevices(userId, snap);
  }

  private emitDevices(userId: string, snap: PlayerDevicesEvent = this.snapshot(userId)): void {
    const u = this.users.get(userId);
    if (!u) return;
    u.lastSent = this.now();
    for (const s of u.subs) s.send('devices', snap);
  }

  /** Whether `deviceId` plays the person's queue. */
  private stateWanted(userId: string, deviceId: string): boolean {
    return this.users.get(userId)?.active?.deviceId === deviceId;
  }

  subscribe(userId: string, sub: Subscriber): () => void {
    const u = this.user(userId);
    u.subs.add(sub);
    // one too many: the oldest stream ends (a Set keeps the order they opened in)
    while (u.subs.size > MAX_SUBSCRIBERS) {
      const oldest = u.subs.values().next().value!;
      u.subs.delete(oldest);
      try { oldest.close?.(); } catch { /* gone already */ }
    }
    sub.send('devices', this.snapshot(userId));
    return () => {
      u.subs.delete(sub);
    };
  }

  /** Devices whose heartbeat stopped go offline (sent once), and long-gone ones are forgotten. */
  sweep(): void {
    const now = this.now();
    for (const [userId, u] of this.users) {
      for (const [id, e] of u.devices) {
        if (now - e.seenAt > FORGET_MS) u.devices.delete(id);
      }
      this.sendDevices(userId, { onlyIfChanged: true });
      if (u.devices.size === 0 && u.subs.size === 0 && !u.timer) this.users.delete(userId);
    }
  }

  start(): void {
    if (this.sweeper) return;
    this.sweeper = setInterval(() => this.sweep(), SWEEP_MS);
    this.sweeper.unref?.();
  }

  stop(): void {
    if (this.sweeper) clearInterval(this.sweeper);
    this.sweeper = null;
  }
}

/** What another device shows of this one: a change here is sent at once. */
function sameShown(a: PlayerDeviceState, b: PlayerDeviceState): boolean {
  return a.name === b.name && a.playing === b.playing && a.index === b.index && a.blocked === b.blocked && a.hidden === b.hidden
    && a.casting === b.casting && Math.abs(a.volume - b.volume) < 0.005 && (a.track?.localTrackId ?? null) === (b.track?.localTrackId ?? null);
}

let shared: PlayerPresence | null = null;

/** The process's presence. */
export function playerPresence(): PlayerPresence {
  if (!shared) {
    shared = new PlayerPresence();
    shared.start();
  }
  return shared;
}

type Notifier = {
  listen(channel: string, onMessage: (payload: string) => void): Promise<unknown>;
  notify(channel: string, payload: string): Promise<unknown>;
};

let listening: Promise<boolean> | null = null;

/**
 * LISTEN once per process; from then on changes go through NOTIFY. Resolves
 * false (changes applied in this process only) when LISTEN fails.
 */
export function connectPresenceBus(sql: Notifier, presence: PlayerPresence = playerPresence(), log?: (err: unknown) => void): Promise<boolean> {
  if (listening) return listening;
  listening = sql.listen(PLAYER_EVENTS_CHANNEL, (payload) => {
    let message: PresenceMessage;
    try { message = JSON.parse(payload) as PresenceMessage; } catch { return; }
    if (message && typeof message.userId === 'string') presence.apply(message);
  }).then(() => {
    presence.setBus({ publish: async (m) => { await sql.notify(PLAYER_EVENTS_CHANNEL, JSON.stringify(m)); } });
    return true;
  }, (err: unknown) => {
    listening = null;
    log?.(err);
    return false;
  });
  return listening;
}

/** Tests: a fresh presence and bus. */
export function resetPlayerPresence(): void {
  shared?.stop();
  shared = null;
  listening = null;
}
