/**
 * Chrome driven over the DevTools protocol without Playwright: Playwright
 * keeps every page it drives focused and visible (focus emulation), so a
 * page can never be hidden under it. Here a second tab in the same window
 * hides the first, as on a real desktop, and Chrome's background throttling
 * is left on.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from '@playwright/test';

type Message = { id?: number; method?: string; params?: Record<string, unknown>; sessionId?: string; result?: Record<string, unknown>; error?: { message: string } };

export interface Chrome {
  send<T = Record<string, unknown>>(method: string, params?: Record<string, unknown>, sessionId?: string): Promise<T>;
  on(method: string, listener: (params: Record<string, unknown>, sessionId?: string) => void): void;
  /** Runs `expression` in the page (awaited) and returns its value. */
  evaluate<T>(sessionId: string, expression: string): Promise<T>;
  close(): Promise<void>;
}

function chromePath(): string {
  const mac = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  return process.platform === 'darwin' && existsSync(mac) ? mac : chromium.executablePath();
}

export async function launchChrome(): Promise<Chrome> {
  const dir = mkdtempSync(join(tmpdir(), 'pwatest-chrome-'));
  const proc: ChildProcess = spawn(chromePath(), [
    '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${dir}`, '--no-first-run', '--no-default-browser-check',
    '--mute-audio', '--autoplay-policy=no-user-gesture-required', 'about:blank',
  ], { stdio: 'ignore' });
  const portFile = join(dir, 'DevToolsActivePort');
  const deadline = Date.now() + 15_000;
  while (!existsSync(portFile) || !readFileSync(portFile, 'utf8').includes('\n')) {
    if (Date.now() > deadline) throw new Error('Chrome did not start');
    await new Promise((r) => setTimeout(r, 100));
  }
  const [port, path] = readFileSync(portFile, 'utf8').trim().split('\n');
  const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`);
  await new Promise((ok, fail) => { ws.addEventListener('open', ok, { once: true }); ws.addEventListener('error', fail, { once: true }); });
  let seq = 0;
  const pending = new Map<number, (m: Message) => void>();
  const listeners = new Map<string, Array<(params: Record<string, unknown>, sessionId?: string) => void>>();
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(String(e.data)) as Message;
    if (m.id && pending.has(m.id)) { pending.get(m.id)!(m); pending.delete(m.id); return; }
    if (m.method) for (const l of listeners.get(m.method) ?? []) l(m.params ?? {}, m.sessionId);
  });
  const send = <T>(method: string, params: Record<string, unknown> = {}, sessionId?: string) => new Promise<T>((ok, fail) => {
    const id = ++seq;
    pending.set(id, (m) => (m.error ? fail(new Error(`${method}: ${m.error.message}`)) : ok(m.result as T)));
    ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
  return {
    send,
    on: (method, listener) => { listeners.set(method, [...(listeners.get(method) ?? []), listener]); },
    async evaluate<T>(sessionId: string, expression: string) {
      const r = await send<{ result: { value: T }; exceptionDetails?: { exception?: { description?: string }; text: string } }>(
        'Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
      return r.result.value;
    },
    async close() {
      ws.close();
      proc.kill();
      await new Promise((r) => setTimeout(r, 300));
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
