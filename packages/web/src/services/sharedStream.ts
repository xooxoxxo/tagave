/**
 * One server-sent event stream for the whole browser, not one per tab: the
 * job stream (jobStream.ts) and the player's events (player/devices.ts).
 *
 * The app is served over plain HTTP/1.1, where a browser allows six open
 * connections per host. Every tab used to hold its own EventSource, so with
 * six tabs open a seventh could not load at all, and fewer tabs left the
 * album grid's cover requests fewer connections (audit 2026-10-10).
 *
 * Now the tabs elect a leader per stream. Only the leader opens the
 * EventSource; it hands each event to its own listeners and posts it on a
 * BroadcastChannel, where the other tabs receive it. Leadership is a lease in
 * localStorage that the leader renews every few seconds. Web Locks would be
 * neater, but they exist only in secure contexts and the app is usually
 * reached at http://<lan-address>, so the lease is what works everywhere.
 *
 * Handoff: a leader that closes (pagehide) or is frozen clears the lease and
 * says so on the channel, and the next tab takes over at once. A leader that
 * dies without a word (crash, kill) stops renewing; its lease runs out after
 * LEASE_MS and another tab takes over then. If two tabs claim at the same
 * moment, the later write wins and the other steps down on its next check.
 *
 * Without BroadcastChannel or a usable localStorage (very old browsers,
 * storage blocked), each tab falls back to its own EventSource.
 *
 * A browser gives an EventSource up for good when the server answers with an
 * error status, as a reverse proxy does (502) while the app restarts for an
 * update. The stream then opens again here, after RETRY_MIN_MS and doubling
 * up to RETRY_MAX_MS; without that every tab went without live updates until
 * a reload (freeze hunt 2026-10-11).
 */

/** How often the leader renews its lease and followers check it. */
export const RENEW_MS = 5_000;
/**
 * How long a lease lasts without renewal. Longer than a background tab's
 * throttled timers (Chrome may run them once a minute after five hidden
 * minutes): a hidden leader then loses the lease to a visible tab, which is
 * fine, and steps down when its timer next fires.
 */
export const LEASE_MS = 30_000;
/** First wait before opening a stream the browser gave up on; doubles up to RETRY_MAX_MS. */
export const RETRY_MIN_MS = 2_000;
export const RETRY_MAX_MS = 60_000;
/** Wait after writing a claim before trusting it, so a simultaneous claim settles. */
const CONFIRM_MIN_MS = 60;
const CONFIRM_JITTER_MS = 120;

interface Lease { id: string; expires: number }
type ChannelMessage =
  | { kind: 'event'; type: string; data: string; from: string }
  | { kind: 'released'; from: string };

export type StreamListener = (type: string, data: string) => void;

/** What a shared stream is: where it connects, which events it passes on, and what the tabs elect by. */
export interface SharedStreamConfig {
  url: string;
  /** the localStorage key of the leader's lease */
  leaseKey: string;
  /** the BroadcastChannel the leader passes events on */
  channelName: string;
  eventTypes: readonly string[];
  /** the tab's stream dropped, and opened again after a drop */
  onDrop?: () => void;
  onReconnect?: () => void;
}

function storageAvailable(): Storage | null {
  try {
    const s = globalThis.localStorage;
    if (!s) return null;
    const probe = '__tagave_probe__';
    s.setItem(probe, '1');
    s.removeItem(probe);
    return s;
  } catch {
    return null;
  }
}

export class SharedStream {
  readonly listeners = new Set<StreamListener>();
  private readonly tabId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  private channel: BroadcastChannel | null = null;
  private storage: Storage | null = null;
  private source: EventSource | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private confirmTimer: ReturnType<typeof setTimeout> | null = null;
  /** set while a stream the browser gave up on waits to open again (this tab still leads) */
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retryMs = 0;
  /** the stream dropped or was given up since it last opened */
  private dropped = false;
  private stopped = false;
  private readonly onPageHide = () => this.release();
  private readonly onPageShow = () => this.tryClaim();

  constructor(private readonly config: SharedStreamConfig) {}

  private get leaseKey(): string {
    return this.config.leaseKey;
  }

  start(): void {
    this.storage = storageAvailable();
    if (typeof BroadcastChannel === 'undefined' || !this.storage) {
      this.openSource(false); // fallback: this tab's own stream
      return;
    }
    this.channel = new BroadcastChannel(this.config.channelName);
    this.channel.onmessage = (e: MessageEvent<ChannelMessage>) => {
      const msg = e.data;
      if (!msg || msg.from === this.tabId) return;
      if (msg.kind === 'event') this.dispatch(msg.type, msg.data);
      else if (msg.kind === 'released') this.tryClaim();
    };
    this.tryClaim();
    this.timer = setInterval(() => this.tick(), RENEW_MS);
    globalThis.addEventListener?.('pagehide', this.onPageHide);
    globalThis.addEventListener?.('pageshow', this.onPageShow);
    // Page Lifecycle: a frozen tab runs no code, so it must not stay leader
    globalThis.document?.addEventListener?.('freeze', this.onPageHide);
    globalThis.document?.addEventListener?.('resume', this.onPageShow);
  }

  stop(): void {
    this.stopped = true;
    this.release();
    if (this.timer) clearInterval(this.timer);
    if (this.confirmTimer) clearTimeout(this.confirmTimer);
    this.timer = this.confirmTimer = null;
    this.channel?.close();
    this.channel = null;
    this.closeSource();
    globalThis.removeEventListener?.('pagehide', this.onPageHide);
    globalThis.removeEventListener?.('pageshow', this.onPageShow);
    globalThis.document?.removeEventListener?.('freeze', this.onPageHide);
    globalThis.document?.removeEventListener?.('resume', this.onPageShow);
  }

  /** True while this tab holds the stream (exposed for tests and debugging). */
  get isLeader(): boolean {
    return this.source !== null && this.channel !== null;
  }

  private readLease(): Lease | null {
    try {
      const raw = this.storage?.getItem(this.leaseKey);
      if (!raw) return null;
      const lease = JSON.parse(raw) as Lease;
      return typeof lease?.id === 'string' && typeof lease?.expires === 'number' ? lease : null;
    } catch {
      return null;
    }
  }

  private writeLease(): void {
    try {
      this.storage?.setItem(this.leaseKey, JSON.stringify({ id: this.tabId, expires: Date.now() + LEASE_MS }));
    } catch {
      /* storage full or blocked: the next tick tries again */
    }
  }

  private tick(): void {
    if (this.stopped) return;
    const lease = this.readLease();
    if (this.source || this.retryTimer) {
      // leader: renew, unless another tab took over while our timers were throttled
      if (!lease || lease.id === this.tabId) this.writeLease();
      else if (lease.expires > Date.now()) this.closeSource();
      return;
    }
    if (!lease || lease.expires <= Date.now()) this.tryClaim();
  }

  private tryClaim(): void {
    if (this.stopped || !this.channel || this.confirmTimer) return;
    const lease = this.readLease();
    if (lease && lease.id !== this.tabId && lease.expires > Date.now()) return;
    this.writeLease();
    this.confirmTimer = setTimeout(() => {
      this.confirmTimer = null;
      if (this.stopped) return;
      if (this.readLease()?.id === this.tabId) this.openSource(true);
      else this.closeSource();
    }, CONFIRM_MIN_MS + Math.random() * CONFIRM_JITTER_MS);
  }

  /** Give the stream up: clear our lease and tell the other tabs to claim it. */
  private release(): void {
    if ((!this.source && !this.retryTimer) || !this.channel) return;
    this.closeSource();
    try {
      if (this.readLease()?.id === this.tabId) this.storage?.removeItem(this.leaseKey);
    } catch {
      /* ignore */
    }
    this.channel.postMessage({ kind: 'released', from: this.tabId } satisfies ChannelMessage);
  }

  private openSource(broadcast: boolean): void {
    if (this.source) return;
    const source = new EventSource(this.config.url, { withCredentials: true });
    source.addEventListener('open', () => {
      this.retryMs = 0;
      if (this.dropped) {
        this.dropped = false;
        this.config.onReconnect?.();
      }
    });
    source.addEventListener('error', () => {
      if (this.source === source) {
        if (!this.dropped) this.config.onDrop?.();
        this.dropped = true;
      }
      // CONNECTING: the browser retries by itself. CLOSED: it gave up (an HTTP error status).
      if (source.readyState !== 2 || this.source !== source || this.stopped) return;
      source.close();
      this.source = null;
      this.retryMs = Math.min(RETRY_MAX_MS, this.retryMs ? this.retryMs * 2 : RETRY_MIN_MS);
      this.retryTimer = setTimeout(() => {
        this.retryTimer = null;
        if (!this.stopped) this.openSource(broadcast);
      }, this.retryMs);
    });
    for (const type of this.config.eventTypes) {
      source.addEventListener(type, (e) => {
        const data = (e as MessageEvent<string>).data;
        this.dispatch(type, data);
        if (broadcast) this.channel?.postMessage({ kind: 'event', type, data, from: this.tabId } satisfies ChannelMessage);
      });
    }
    this.source = source;
  }

  private closeSource(): void {
    this.source?.close();
    this.source = null;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  private dispatch(type: string, data: string): void {
    for (const listener of this.listeners) {
      try {
        listener(type, data);
      } catch {
        /* one listener's bug must not starve the others */
      }
    }
  }
}
