/**
 * Presence per person (playerPresence.ts): devices come and go with their
 * heartbeats, the device that plays follows the queue's writes, commands
 * reach only the person they belong to, and a second process hears what
 * the first one publishes.
 */
import { describe, it, expect, vi } from 'vitest';
import type { PlayerDeviceState } from '@tagave/shared';
import { DEVICES_THROTTLE_MS, HIDDEN_ONLINE_MS, MAX_DEVICES, MAX_SUBSCRIBERS, ONLINE_MS, PlayerPresence as Presence, type PresenceBus, type PresenceMessage } from './playerPresence.js';

/** No throttle unless a test asks for it: each change is heard at once. */
class PlayerPresence extends Presence {
  constructor(bus: PresenceBus | null = null, now: () => number = Date.now, opts: { throttleMs?: number } = { throttleMs: 0 }) {
    super(bus, now, opts);
  }
}

const state = (deviceId: string, patch: Partial<PlayerDeviceState> = {}): PlayerDeviceState => ({
  deviceId, name: `Chrome on ${deviceId}`, track: null, index: -1, positionMs: 0, playing: false, blocked: false, volume: 1, hidden: false, casting: null, ...patch,
});

function listen(p: PlayerPresence, userId: string) {
  const heard: Array<{ type: string; data: any }> = [];
  p.subscribe(userId, { send: (type, data) => heard.push({ type, data }) });
  return heard;
}

describe('player presence', () => {
  it('lists a person’s devices and takes one offline after its heartbeat stops', async () => {
    let now = 1_000_000;
    const p = new PlayerPresence(null, () => now);
    const heard = listen(p, 'anna');
    expect(heard[0]).toMatchObject({ type: 'devices', data: { devices: [], active: null } });
    await p.publish({ t: 'state', userId: 'anna', state: state('mac-tab-1'), at: now });
    await p.publish({ t: 'state', userId: 'anna', state: state('phone-tab-1'), at: now });
    expect(p.snapshot('anna').devices.map((d) => [d.deviceId, d.online])).toEqual([['mac-tab-1', true], ['phone-tab-1', true]]);
    now += ONLINE_MS - 1000;
    await p.publish({ t: 'state', userId: 'anna', state: state('phone-tab-1'), at: now });
    now += 2000;
    const before = heard.length;
    p.sweep();
    expect(heard.length).toBe(before + 1);
    expect(p.snapshot('anna').devices.map((d) => [d.deviceId, d.online])).toEqual([['mac-tab-1', false], ['phone-tab-1', true]]);
    // nothing changed: the sweep sends nothing
    p.sweep();
    expect(heard.length).toBe(before + 1);
  });

  it('keeps a page in the background online longer, unless it plays', async () => {
    let now = 0;
    const p = new PlayerPresence(null, () => now);
    await p.publish({ t: 'state', userId: 'anna', state: state('hidden-tab', { hidden: true }), at: now });
    await p.publish({ t: 'state', userId: 'anna', state: state('playing-tab', { hidden: true, playing: true }), at: now });
    now = ONLINE_MS + 1000;
    expect(p.hasDevice('anna', 'hidden-tab')).toBe(true);
    expect(p.hasDevice('anna', 'playing-tab')).toBe(false);
    now = HIDDEN_ONLINE_MS + 1;
    expect(p.hasDevice('anna', 'hidden-tab')).toBe(false);
  });

  it('a device that says goodbye is offline at once, and shown paused', async () => {
    const p = new PlayerPresence();
    await p.publish({ t: 'state', userId: 'anna', state: state('mac-tab-1', { playing: true }), at: 0 });
    await p.publish({ t: 'leave', userId: 'anna', deviceId: 'mac-tab-1', at: 0 });
    expect(p.snapshot('anna').devices[0]).toMatchObject({ online: false, playing: false });
  });

  it('follows the device that plays from the queue’s writes, newest revision first', async () => {
    const p = new PlayerPresence();
    const heard = listen(p, 'anna');
    p.setActive('anna', { deviceId: 'mac-tab-1', revision: 4 });
    await p.publish({ t: 'queue', userId: 'anna', queue: { deviceId: 'phone-tab-1', revision: 6, mode: 'play' } });
    await p.publish({ t: 'queue', userId: 'anna', queue: { deviceId: 'mac-tab-1', revision: 5, mode: 'play' } });
    expect(p.snapshot('anna').active).toEqual({ deviceId: 'phone-tab-1', revision: 6 });
    expect(heard.filter((h) => h.type === 'queue').map((h) => h.data.revision)).toEqual([6, 5]);
    expect(heard.filter((h) => h.type === 'devices').at(-1)!.data.active).toEqual({ deviceId: 'phone-tab-1', revision: 6 });
    await p.publish({ t: 'queue', userId: 'anna', queue: { deviceId: null, revision: 0, mode: 'clear' } });
    expect(p.snapshot('anna').active).toBeNull();
  });

  it('sends every state of the device that plays, and others only when they change', async () => {
    const p = new PlayerPresence();
    const heard = listen(p, 'anna');
    p.setActive('anna', { deviceId: 'mac-tab-1', revision: 1 });
    await p.publish({ t: 'state', userId: 'anna', state: state('mac-tab-1', { playing: true, positionMs: 1000 }), at: 0 });
    await p.publish({ t: 'state', userId: 'anna', state: state('phone-tab-1'), at: 0 });
    const n = heard.length;
    await p.publish({ t: 'state', userId: 'anna', state: state('mac-tab-1', { playing: true, positionMs: 6000 }), at: 0 });
    await p.publish({ t: 'state', userId: 'anna', state: state('phone-tab-1'), at: 0 });
    expect(heard.length).toBe(n + 1);
    await p.publish({ t: 'state', userId: 'anna', state: state('phone-tab-1', { volume: 0.5 }), at: 0 });
    expect(heard.length).toBe(n + 2);
  });

  it('never shows or sends one person’s devices or commands to another', async () => {
    const p = new PlayerPresence();
    const anna = listen(p, 'anna');
    const ben = listen(p, 'ben');
    await p.publish({ t: 'state', userId: 'anna', state: state('mac-tab-1'), at: 0 });
    await p.publish({ t: 'command', userId: 'anna', command: { to: 'mac-tab-1', from: null, action: 'pause', value: null, index: null } });
    expect(ben).toHaveLength(1);
    expect(ben[0]!.data.devices).toEqual([]);
    expect(anna.some((h) => h.type === 'command')).toBe(true);
    expect(p.hasDevice('ben', 'mac-tab-1')).toBe(false);
  });

  it('a second process hears what the first publishes (NOTIFY)', async () => {
    const processes: PlayerPresence[] = [];
    // the bus: every process applies every message, as LISTEN delivers it
    const bus = { publish: async (m: PresenceMessage) => { for (const q of processes) q.apply(JSON.parse(JSON.stringify(m))); } };
    const one = new PlayerPresence(bus);
    const two = new PlayerPresence(bus);
    processes.push(one, two);
    const onTwo = listen(two, 'anna');
    await one.publish({ t: 'state', userId: 'anna', state: state('mac-tab-1'), at: 0 });
    await one.publish({ t: 'command', userId: 'anna', command: { to: 'mac-tab-1', from: 'phone-tab-1', action: 'next', value: null, index: null } });
    expect(two.hasDevice('anna', 'mac-tab-1')).toBe(true);
    expect(onTwo.map((h) => h.type)).toEqual(['devices', 'devices', 'command']);
  });

  it('applies changes itself when the bus fails', async () => {
    const p = new PlayerPresence({ publish: async () => { throw new Error('no LISTEN'); } });
    await p.publish({ t: 'state', userId: 'anna', state: state('mac-tab-1'), at: 0 });
    expect(p.hasDevice('anna', 'mac-tab-1')).toBe(true);
  });

  it('keeps at most MAX_DEVICES per person: a new one replaces the longest-gone offline one, and is refused when all are online', async () => {
    let now = 0;
    const p = new PlayerPresence(null, () => now);
    for (let i = 0; i < MAX_DEVICES; i++) {
      now = i;
      await p.publish({ t: 'state', userId: 'anna', state: state(`device-${String(i).padStart(4, '0')}`), at: now });
    }
    expect(p.deviceCount('anna')).toBe(MAX_DEVICES);
    // all online: no room
    expect(p.admits('anna', 'device-new-1')).toBe(false);
    expect(p.admits('anna', 'device-0005')).toBe(true);
    await p.publish({ t: 'state', userId: 'anna', state: state('device-new-1'), at: now });
    expect(p.deviceCount('anna')).toBe(MAX_DEVICES);
    expect(p.hasDevice('anna', 'device-new-1')).toBe(false);
    // three go offline (0001 longest ago, but it plays: kept even offline; 0003 next)
    p.setActive('anna', { deviceId: 'device-0001', revision: 1 });
    await p.publish({ t: 'leave', userId: 'anna', deviceId: 'device-0001', at: now });
    await p.publish({ t: 'leave', userId: 'anna', deviceId: 'device-0003', at: now });
    await p.publish({ t: 'leave', userId: 'anna', deviceId: 'device-0007', at: now });
    expect(p.admits('anna', 'device-new-1')).toBe(true);
    await p.publish({ t: 'state', userId: 'anna', state: state('device-new-1'), at: now });
    const ids = p.snapshot('anna').devices.map((d) => d.deviceId);
    expect(ids).toContain('device-new-1');
    expect(ids).toContain('device-0001');
    expect(ids).not.toContain('device-0003');
    expect(ids).toContain('device-0007');
    expect(p.deviceCount('anna')).toBe(MAX_DEVICES);
    // another person is not limited by Anna's devices
    expect(p.admits('ben', 'device-new-1')).toBe(true);
  });

  it('keeps at most MAX_SUBSCRIBERS streams per person, closing the oldest', () => {
    const p = new PlayerPresence();
    const closed: number[] = [];
    for (let i = 0; i <= MAX_SUBSCRIBERS; i++) p.subscribe('anna', { send: () => undefined, close: () => closed.push(i) });
    expect(closed).toEqual([0]);
    expect(p.subscriberCount('anna')).toBe(MAX_SUBSCRIBERS);
  });

  it('sends a person’s devices event at most once per DEVICES_THROTTLE_MS, with the latest state', async () => {
    vi.useFakeTimers();
    try {
      const p = new Presence(null, () => Date.now());
      const heard = listen(p, 'anna');
      for (let i = 0; i < 10; i++) await p.publish({ t: 'state', userId: 'anna', state: state(`device-${i}0000000`), at: 0 });
      const devices = () => heard.filter((h) => h.type === 'devices');
      // the snapshot on subscribe and the first change at once; the rest wait
      expect(devices()).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(DEVICES_THROTTLE_MS);
      expect(devices()).toHaveLength(3);
      expect(devices().at(-1)!.data.devices).toHaveLength(10);
      await vi.advanceTimersByTimeAsync(DEVICES_THROTTLE_MS * 4);
      expect(devices()).toHaveLength(3);
    } finally {
      vi.useRealTimers();
    }
  });
});
