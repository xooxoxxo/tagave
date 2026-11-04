/**
 * Which device this is: every tab (or home-screen app session) with the
 * player is one. Its id is random and kept in sessionStorage, so a reload
 * keeps it and another tab has its own; a duplicated tab copies the
 * sessionStorage, so a tab that finds its id taken by another tab of the
 * browser takes a new one. Its name comes from the browser ("Chrome on
 * Mac"), or is the one the person gave this browser (localStorage).
 */
import { PLAYER_DEVICE_NAME_MAX } from '@tagave/shared';

const ID_KEY = 'tagave-player-tab';
const NAME_KEY = 'tagave-player-device-name';
const CHANNEL = 'tagave:player-device';

type Nav = Pick<Navigator, 'userAgent' | 'platform' | 'maxTouchPoints'> & { userAgentData?: { platform?: string; mobile?: boolean } };

export function randomId(): string {
  const c = globalThis.crypto;
  // randomUUID exists only in secure contexts; a homelab over plain http is not one
  if (c && typeof c.randomUUID === 'function') {
    try { return c.randomUUID(); } catch { /* fall through */ }
  }
  const b = new Uint8Array(16);
  if (c && typeof c.getRandomValues === 'function') c.getRandomValues(b);
  else for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

let idCache: string | null = null;
let channel: BroadcastChannel | null = null;
const idWatchers = new Set<(id: string) => void>();

function store(kind: 'session' | 'local'): Storage | null {
  try { return (kind === 'session' ? globalThis.sessionStorage : globalThis.localStorage) ?? null; } catch { return null; }
}

/** This tab's device id. */
export function deviceId(): string {
  if (idCache) return idCache;
  const s = store('session');
  let id: string | null = null;
  try { id = s?.getItem(ID_KEY) ?? null; } catch { /* storage blocked */ }
  if (!id || id.length < 8) {
    id = randomId();
    try { s?.setItem(ID_KEY, id); } catch { /* this page only */ }
  }
  idCache = id;
  watchDuplicates();
  return id;
}

/** Called when this tab had to take a new id (it was a copy of another tab). */
export function onDeviceIdChange(watch: (id: string) => void): () => void {
  idWatchers.add(watch);
  return () => { idWatchers.delete(watch); };
}

/** Asks the browser's other tabs whether one has this id already; the newcomer then takes a new one. */
function watchDuplicates() {
  if (channel || typeof BroadcastChannel === 'undefined') return;
  try { channel = new BroadcastChannel(CHANNEL); } catch { return; }
  channel.onmessage = (e: MessageEvent<{ kind: 'hello' | 'mine'; id: string }>) => {
    const m = e.data;
    if (!m || m.id !== idCache) return;
    if (m.kind === 'hello') channel?.postMessage({ kind: 'mine', id: m.id });
    else {
      const fresh = randomId();
      idCache = fresh;
      try { store('session')?.setItem(ID_KEY, fresh); } catch { /* this page only */ }
      for (const w of idWatchers) w(fresh);
    }
  };
  channel.postMessage({ kind: 'hello', id: idCache });
}

function browserOf(ua: string): string {
  if (/\bEdg(A|iOS)?\//.test(ua)) return 'Edge';
  if (/\bOPR\//.test(ua)) return 'Opera';
  if (/\b(Firefox|FxiOS)\//.test(ua)) return 'Firefox';
  if (/\b(Chrome|CriOS|Chromium)\//.test(ua)) return 'Chrome';
  if (/\bSafari\//.test(ua) || /AppleWebKit/.test(ua)) return 'Safari';
  return 'Browser';
}

function systemOf(nav: Nav): string {
  const ua = nav.userAgent;
  if (/iPhone|iPod/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua) || (nav.platform === 'MacIntel' && nav.maxTouchPoints > 1)) return 'iPad';
  if (/Android/.test(ua)) return 'Android';
  if (/CrOS/.test(ua)) return 'ChromeOS';
  if (/Mac OS X|Macintosh/.test(ua)) return 'Mac';
  if (/Windows/.test(ua)) return 'Windows';
  if (/Linux/.test(ua)) return 'Linux';
  return '';
}

/** "Chrome on Mac", "Safari on iPhone": what the browser says it is. */
export function defaultDeviceName(nav: Nav | undefined = globalThis.navigator): string {
  if (!nav?.userAgent) return 'Browser';
  const system = systemOf(nav);
  const browser = browserOf(nav.userAgent);
  return system ? `${browser} on ${system}` : browser;
}

/** This browser's name: the one the person gave it, or the default. */
export function deviceName(): string {
  let named: string | null = null;
  try { named = store('local')?.getItem(NAME_KEY) ?? null; } catch { /* storage blocked */ }
  const clean = named?.replace(/\s+/g, ' ').trim();
  return clean ? clean.slice(0, PLAYER_DEVICE_NAME_MAX) : defaultDeviceName();
}

/** Renames this browser; a blank name goes back to the default. Returns the name now. */
export function setDeviceName(raw: string): string {
  const clean = raw.replace(/\s+/g, ' ').trim().slice(0, PLAYER_DEVICE_NAME_MAX);
  try {
    if (clean && clean !== defaultDeviceName()) store('local')?.setItem(NAME_KEY, clean);
    else store('local')?.removeItem(NAME_KEY);
  } catch { /* this page only */ }
  return deviceName();
}

/** Tests: forget the cached id. */
export function resetDeviceIdentity(): void {
  idCache = null;
  try { channel?.close(); } catch { /* closed */ }
  channel = null;
}
