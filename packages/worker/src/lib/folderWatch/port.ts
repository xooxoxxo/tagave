/**
 * Does the music share's server answer on its port? A TCP connect to the
 * server, never a touch of the share's path, so a dead share cannot block it.
 */
import { createConnection } from 'node:net';

/** Same shape as the updater's `Connector` (music-probe.ts): true when `host:port` takes a TCP connection within `timeoutMs`. */
export type Connector = (host: string, port: number, timeoutMs: number) => Promise<boolean>;

export const tcpConnect: Connector = (host, port, timeoutMs) =>
  new Promise((resolve) => {
    const socket = createConnection({ host, port });
    const done = (ok: boolean) => {
      clearTimeout(timer);
      socket.destroy();
      resolve(ok);
    };
    const timer = setTimeout(() => done(false), timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Two tries of 3 s, 500 ms apart, by default. A connect that throws counts as no answer. */
export async function portAnswers(
  host: string,
  port: number,
  opts: { tries?: number; timeoutMs?: number; gapMs?: number; connect?: Connector } = {},
): Promise<boolean> {
  const tries = opts.tries ?? 2;
  const timeoutMs = opts.timeoutMs ?? 3_000;
  const gapMs = opts.gapMs ?? 500;
  const connect = opts.connect ?? tcpConnect;
  for (let i = 0; i < tries; i += 1) {
    if (i > 0 && gapMs > 0) await sleep(gapMs);
    if (await connect(host, port, timeoutMs).catch(() => false)) return true;
  }
  return false;
}
