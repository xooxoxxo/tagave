/**
 * Mutagen sidecar tag writer client
 * Manages a long-lived subprocess communicating via JSON-lines over stdio
 * Spec §12.6 TAG-4; M2 build order #2
 */

import { spawn, type ChildProcess } from 'child_process';
import path from 'path';
import { existsSync } from 'node:fs';
import type { TagSet } from '@tagave/shared';
import type { TagWriter, WriteOptions } from '@tagave/core';
import { tagaveEnv } from '@tagave/shared/env';
import { fileGate } from './fileGate.js';
import { FolderOfflineError } from './folderOffline.js';

/**
 * Response from the sidecar
 */
interface SidecarResponse {
  [key: string]: any;
  id?: string | number;
  error?: string;
  success?: boolean;
  supported?: boolean;
}

/** How long the sidecar may take to answer one request. */
const RESPONSE_MS = 30_000;

export interface MutagenTagWriterOptions {
  /**
   * The scan root the files are under. A response deadline then throws
   * FolderOfflineError for it; without one it throws an Error with code
   * ETIMEDOUT. Settable later (`rootId`), as the file helper does per op.
   */
  rootId?: string;
  /** The response deadline (30 s). */
  responseMs?: number;
  /** Told of each sidecar given up on. Default: counts it stuck for the root in this process's file gate. */
  onStuck?: (rootId: string | undefined) => void;
}

interface Pending {
  resolve: (value: SidecarResponse) => void;
  reject: (err: unknown) => void;
  timer: NodeJS.Timeout;
}

/**
 * Mutagen tag writer implementation via sidecar subprocess
 * Creates one long-lived process per instance, reused for all read/write calls.
 *
 * A sidecar that does not answer in time is taken to be stuck on the music
 * share: it is killed and abandoned (never waited on, never reused), every
 * request it held fails, and the next request goes to a fresh sidecar.
 */
export class MutagenTagWriter implements TagWriter {
  private stderrTail = '';
  private exitCode: number | null | undefined = undefined;

  /** Why the sidecar is unusable, with the last lines it wrote (e.g. a Python import error). */
  private notRunningMessage(): string {
    const tail = this.stderrTail.trim().split('\n').filter(Boolean).slice(-3).join(' | ');
    const code = this.exitCode === undefined ? '' : ` (exit code ${this.exitCode})`;
    return `Mutagen sidecar is not running${code}${tail ? `: ${tail}` : ''}`;
  }

  readonly id = 'mutagen';
  /** The scan root of the files being written (see MutagenTagWriterOptions.rootId). */
  rootId: string | undefined;
  private readonly responseMs: number;
  private readonly onStuck: (rootId: string | undefined) => void;
  private subprocess: ChildProcess | null = null;
  private pending: Map<number, Pending> = new Map();
  private nextRequestId = 0;
  private initPromise: Promise<void>;

  constructor(opts: MutagenTagWriterOptions = {}) {
    this.rootId = opts.rootId;
    this.responseMs = opts.responseMs ?? RESPONSE_MS;
    this.onStuck = opts.onStuck ?? ((rootId) => { if (rootId !== undefined) fileGate().markStuck(rootId); });
    this.initPromise = this.start();
  }

  /** The running sidecar's process id (it changes when a stuck one is replaced). */
  get pid(): number | undefined {
    return this.subprocess?.pid;
  }

  /** Starts a sidecar; its failure waits for the next request without leaving an unhandled rejection. */
  private start(): Promise<void> {
    const p = this.initSubprocess();
    void p.catch(() => undefined);
    return p;
  }

  /**
   * Initialize the subprocess once
   */
  private async initSubprocess(): Promise<void> {
    return new Promise((resolve, reject) => {
      const pythonInterpreter = this.getPythonInterpreter();
      const scriptPath = path.resolve(
        import.meta.dirname,
        '../../../tagwriter-py/tagave_tagwriter.py'
      );

      try {
        const child = spawn(pythonInterpreter, [scriptPath], {
          stdio: ['pipe', 'pipe', 'pipe'],
          // Ensure the subprocess inherits environment for Python path
          env: {
            ...process.env,
            PYTHONUNBUFFERED: '1',
          },
        });
        this.subprocess = child;
        this.exitCode = undefined;
        this.stderrTail = '';
        const current = () => this.subprocess === child;

        // Handle stdout (responses)
        child.stdout?.on('data', (data: Buffer) => {
          if (current()) this.handleStdoutData(data);
        });

        // Handle stderr (logging) and keep a tail for error messages
        let settled = false;
        child.stderr?.on('data', (data: Buffer) => {
          if (!current()) return;
          const message = data.toString();
          this.stderrTail = (this.stderrTail + message).slice(-4000);
          if (message.includes('tagwriter sidecar started') && !settled) { settled = true; resolve(); }
          const trimmed = message.trim();
          if (trimmed && !trimmed.includes('tagwriter sidecar started')) {
            process.stderr.write(`[mutagen sidecar] ${trimmed}\n`);
          }
        });

        // Handle subprocess exit
        child.on('exit', (code) => {
          if (!current()) return;
          this.exitCode = code;
          if (code !== 0 && code !== null) {
            process.stderr.write(`[mutagen sidecar] exited with code ${code}\n`);
          }
          this.subprocess = null;
          // A sidecar that died is not one stuck on the share: its requests fail now.
          this.failPending(() => new Error(this.notRunningMessage()));
          if (!settled) { settled = true; reject(new Error(this.notRunningMessage())); }
        });

        // Handle subprocess errors
        child.on('error', (error) => {
          if (!settled) { settled = true; reject(error); }
        });
        child.stdin?.on('error', () => undefined);

        // Resolve once the sidecar announces itself, or after a grace period
        // if it stays silent but alive (older sidecar builds).
        setTimeout(() => { if (!settled) { settled = true; resolve(); } }, 300);
      } catch (error) {
        reject(error);
      }
    });
  }

  /** Fails every request in flight. */
  private failPending(err: () => unknown): void {
    const all = [...this.pending.values()];
    this.pending.clear();
    for (const p of all) {
      clearTimeout(p.timer);
      p.reject(err());
    }
  }

  /**
   * The sidecar did not answer in time: kill it and let go without waiting
   * (one stuck in the kernel on a dead share may never exit), fail what it
   * held, and start a fresh one for the next request.
   */
  private giveUp(): void {
    const child = this.subprocess;
    const rootId = this.rootId;
    this.subprocess = null;
    if (child) {
      child.on('error', () => undefined);
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      child.unref();
      child.stdin?.destroy();
      child.stdout?.destroy();
      child.stderr?.destroy();
    }
    this.failPending(() => rootId !== undefined
      ? new FolderOfflineError(rootId, 'timeout')
      : Object.assign(new Error('Sidecar response timeout'), { code: 'ETIMEDOUT' }));
    this.onStuck(rootId);
    this.initPromise = this.start();
  }

  /**
   * Detect Python interpreter from environment
   */
  private getPythonInterpreter(): string {
    return resolvePythonInterpreter();
  }

  /**
   * Handle data from subprocess stdout
   */
  private handleStdoutData(data: Buffer): void {
    const lines = data.toString().split('\n');

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }

      try {
        const response = JSON.parse(trimmed) as SidecarResponse;
        const requestId = response.id;

        if (requestId !== undefined && requestId !== null) {
          const p = typeof requestId === 'number' ? this.pending.get(requestId) : undefined;
          if (p) {
            this.pending.delete(requestId as number);
            clearTimeout(p.timer);
            p.resolve(response);
          } else {
            // Late response for timed-out or unknown request
            process.stderr.write(
              `[mutagen sidecar] Received response for unknown request id ${requestId}\n`
            );
          }
        } else {
          // No id in response; log warning but try FIFO for backwards compatibility
          process.stderr.write(
            `[mutagen sidecar] Response missing id field\n`
          );
        }
      } catch (error) {
        process.stderr.write(
          `[mutagen sidecar] Failed to parse response: ${trimmed}\n`
        );
      }
    }
  }

  /**
   * Send a command to the subprocess and wait for response
   */
  private async sendCommand(command: string): Promise<SidecarResponse> {
    await this.initPromise;

    const child = this.subprocess;
    if (!child?.stdin) {
      throw new Error(this.notRunningMessage());
    }

    return new Promise((resolve, reject) => {
      const requestId = this.nextRequestId++;

      // Parse command and add request id
      let cmdObj: any;
      try {
        cmdObj = JSON.parse(command);
        cmdObj.id = requestId;
      } catch {
        // Not JSON, send as-is with id appended (legacy support)
        cmdObj = { id: requestId, __raw: command };
      }

      // The response deadline: past it the sidecar is taken to be stuck and replaced.
      const timer = setTimeout(() => {
        if (this.pending.has(requestId) && this.subprocess === child) this.giveUp();
      }, this.responseMs);
      this.pending.set(requestId, { resolve, reject, timer });

      child.stdin!.write(JSON.stringify(cmdObj) + '\n', (error) => {
        const p = this.pending.get(requestId);
        if (error && p) {
          this.pending.delete(requestId);
          clearTimeout(p.timer);
          reject(error);
        }
      });
    });
  }

  /**
   * Read tags from an audio file
   */
  async read(filePath: string): Promise<TagSet> {
    const response = await this.sendCommand(JSON.stringify({ op: 'read', path: filePath }));

    if (response.error) {
      throw new Error(`Failed to read tags from ${filePath}: ${response.error}`);
    }

    // Remove error and other meta fields
    const result: TagSet = {};
    for (const [key, value] of Object.entries(response)) {
      if (!key.startsWith('__') && key !== 'error' && key !== 'success' && key !== 'id') {
        result[key] = value as string | string[] | undefined;
      }
    }

    return result;
  }

  /**
   * Write tags to an audio file
   */
  async write(
    filePath: string,
    tags: TagSet,
    opts?: WriteOptions
  ): Promise<void> {
    // One JSON object per line: paths with spaces and quotes inside the tag
    // values need no escaping, and the sidecar never tokenises the payload.
    const response = await this.sendCommand(JSON.stringify({ op: 'write', path: filePath, tags, options: opts ?? {} }));

    if (response.error) {
      throw new Error(`Failed to write tags to ${filePath}: ${response.error}`);
    }

    if (!response.success) {
      throw new Error(`Sidecar write failed for ${filePath}`);
    }
  }

  async embedCover(filePath: string, jpeg: Buffer): Promise<void> {
    const response = await this.sendCommand(JSON.stringify({ op: 'embed-cover', path: filePath, jpeg: jpeg.toString('base64') }));
    if (!response.success) throw new Error(response.error ?? 'Could not write cover art');
  }

  /**
   * Check if a container format is supported for writing
   */
  supports(container: string): boolean {
    // Note: This is synchronous but we're calling the subprocess
    // For this implementation, we'll handle it asynchronously in a separate method
    // This method returns false for APE/WV per spec guardrail 2
    const lowercased = container.toLowerCase().replace(/^\./, '');
    return !['ape', 'wv'].includes(lowercased);
  }

  /**
   * Async version of supports() for internal use
   */
  async supportsAsync(container: string): Promise<boolean> {
    const response = await this.sendCommand(JSON.stringify({ op: 'supports', container }));

    if (response.error) {
      // Default to false on error
      return false;
    }

    return response.supported === true;
  }

  /**
   * Cleanup: close the subprocess
   */
  async close(): Promise<void> {
    await this.initPromise.catch(() => undefined);
    const child = this.subprocess;
    if (!child) return;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        // Force kill after 5 seconds, and do not wait on it further
        if (this.subprocess === child) this.subprocess = null;
        child.kill('SIGKILL');
        child.unref();
        resolve();
      }, 5000);
      timer.unref();
      child.once('exit', () => {
        clearTimeout(timer);
        if (this.subprocess === child) this.subprocess = null;
        resolve();
      });
      child.stdin?.end();
    });
  }
}

/**
 * Interpreter for the mutagen sidecar: TAGAVE_TAGWRITER_PYTHON, then the
 * repo-local venv (packages/tagwriter-py/.venv), then the system python3.
 * Exported so tests decide availability with the same rule the client uses
 * (the previous copy used require('fs') inside an ES module, which threw,
 * was swallowed, and silently always chose the system python3).
 */
export function resolvePythonInterpreter(): string {
  const env = tagaveEnv('TAGWRITER_PYTHON');
  if (env) return env;
  const venv = path.resolve(import.meta.dirname, '../../../tagwriter-py/.venv/bin/python');
  if (existsSync(venv)) return venv;
  return 'python3';
}
