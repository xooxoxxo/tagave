/**
 * One live job stream (/jobs/stream, server-sent events) for the whole
 * browser, not one per tab: the tabs of one library elect a leader that
 * holds the EventSource and passes its events on (sharedStream.ts).
 */
import { SharedStream } from './sharedStream';

export { RENEW_MS, LEASE_MS, RETRY_MIN_MS, RETRY_MAX_MS } from './sharedStream';

export const JOB_EVENT_TYPES = ['queue.changed', 'job.progress', 'job.completed', 'job.failed'] as const;
export type JobEventType = (typeof JOB_EVENT_TYPES)[number];
export type JobEventListener = (type: JobEventType, data: string) => void;

const streams = new Map<string, SharedStream>();

const reconnectListeners = new Set<() => void>();
const dropListeners = new Set<() => void>();
function notifyDrop(): void {
  for (const listener of dropListeners) {
    try {
      listener();
    } catch {
      /* ignore */
    }
  }
}

/** Called when this tab's stream drops (the app went away, or the network did): the down screen asks whether the app answers. */
export function onJobStreamDrop(listener: () => void): () => void {
  dropListeners.add(listener);
  return () => { dropListeners.delete(listener); };
}

function notifyReconnect(): void {
  for (const listener of reconnectListeners) {
    try {
      listener();
    } catch {
      /* ignore */
    }
  }
}

/**
 * Called when this tab's stream opens again after it dropped, as it does
 * when the app restarts (an update): the build check asks the server then.
 * Only the tab that holds the stream sees it; it shares what it finds.
 */
export function onJobStreamReconnect(listener: () => void): () => void {
  reconnectListeners.add(listener);
  return () => { reconnectListeners.delete(listener); };
}

/**
 * Listen to a library's job events. The first subscriber in a tab joins the
 * election; the last one to unsubscribe leaves it (handing the stream to
 * another tab if this one led).
 */
export function subscribeJobEvents(libraryId: string, listener: JobEventListener): () => void {
  let stream = streams.get(libraryId);
  if (!stream) {
    stream = new SharedStream({
      url: `/api/v1/libraries/${libraryId}/jobs/stream`,
      leaseKey: `tagave:job-stream-leader:${libraryId}`,
      channelName: `tagave:job-stream:${libraryId}`,
      eventTypes: JOB_EVENT_TYPES,
      onDrop: notifyDrop,
      onReconnect: notifyReconnect,
    });
    streams.set(libraryId, stream);
    stream.start();
  }
  stream.listeners.add(listener as (type: string, data: string) => void);
  const joined = stream;
  return () => {
    joined.listeners.delete(listener as (type: string, data: string) => void);
    if (joined.listeners.size === 0 && streams.get(libraryId) === joined) {
      streams.delete(libraryId);
      joined.stop();
    }
  };
}

/** Whether this tab currently holds the library's stream (tests, debugging). */
export function isJobStreamLeader(libraryId: string): boolean {
  return streams.get(libraryId)?.isLeader ?? false;
}
