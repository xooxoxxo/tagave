/**
 * Mutagen sidecar tag writer client
 * Manages a long-lived subprocess communicating via JSON-lines over stdio
 * Spec §12.6 TAG-4; M2 build order #2
 */

import { spawn, type ChildProcess } from 'child_process';
import path from 'path';
import { existsSync } from 'node:fs';
import type { TagSet } from '@liner/shared';
import type { TagWriter, WriteOptions } from '@liner/core';

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

/**
 * Mutagen tag writer implementation via sidecar subprocess
 * Creates one long-lived process per instance, reused for all read/write calls
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
  private subprocess: ChildProcess | null = null;
  private inputBuffer = '';
  private responseQueue: Promise<SidecarResponse>[] = [];
  private responseResolvers: Map<string | number, (value: SidecarResponse) => void> = new Map();
  private nextRequestId = 0;
  private initPromise: Promise<void>;

  constructor() {
    // Start the subprocess immediately in constructor
    this.initPromise = this.initSubprocess();
  }

  /**
   * Initialize the subprocess once
   */
  private async initSubprocess(): Promise<void> {
    return new Promise((resolve, reject) => {
      const pythonInterpreter = this.getPythonInterpreter();
      const scriptPath = path.resolve(
        import.meta.dirname,
        '../../../tagwriter-py/liner_tagwriter.py'
      );

      try {
        this.subprocess = spawn(pythonInterpreter, [scriptPath], {
          stdio: ['pipe', 'pipe', 'pipe'],
          // Ensure the subprocess inherits environment for Python path
          env: {
            ...process.env,
            PYTHONUNBUFFERED: '1',
          },
        });

        // Handle stdout (responses)
        this.subprocess.stdout?.on('data', (data) => {
          this.handleStdoutData(data);
        });

        // Handle stderr (logging) and keep a tail for error messages
        let settled = false;
        this.subprocess.stderr?.on('data', (data) => {
          const message = data.toString();
          this.stderrTail = (this.stderrTail + message).slice(-4000);
          if (message.includes('tagwriter sidecar started') && !settled) { settled = true; resolve(); }
          const trimmed = message.trim();
          if (trimmed && !trimmed.includes('tagwriter sidecar started')) {
            process.stderr.write(`[mutagen sidecar] ${trimmed}\n`);
          }
        });

        // Handle subprocess exit
        this.subprocess.on('exit', (code) => {
          this.exitCode = code;
          if (code !== 0 && code !== null) {
            process.stderr.write(`[mutagen sidecar] exited with code ${code}\n`);
          }
          this.subprocess = null;
          if (!settled) { settled = true; reject(new Error(this.notRunningMessage())); }
        });

        // Handle subprocess errors
        this.subprocess.on('error', (error) => {
          reject(error);
        });

        // Resolve once the sidecar announces itself, or after a grace period
        // if it stays silent but alive (older sidecar builds).
        setTimeout(() => { if (!settled) { settled = true; resolve(); } }, 300);
      } catch (error) {
        reject(error);
      }
    });
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
          const resolver = this.responseResolvers.get(requestId);
          if (resolver) {
            this.responseResolvers.delete(requestId);
            resolver(response);
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

    if (!this.subprocess?.stdin) {
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

      const commandWithId = JSON.stringify(cmdObj);

      // Create a timeout handler
      let timeoutId: NodeJS.Timeout | null = null;

      // Create wrapper resolver that clears timeout
      const wrappedResolve = (response: SidecarResponse) => {
        if (timeoutId) clearTimeout(timeoutId);
        resolve(response);
      };

      // Add resolver to map by request id
      this.responseResolvers.set(requestId, wrappedResolve);

      // Send command
      this.subprocess!.stdin!.write(commandWithId + '\n', (error) => {
        if (error) {
          this.responseResolvers.delete(requestId);
          reject(error);
        }
      });

      // Set timeout to prevent hanging
      timeoutId = setTimeout(() => {
        if (this.responseResolvers.has(requestId)) {
          this.responseResolvers.delete(requestId);
          reject(new Error('Sidecar response timeout'));
        }
      }, 30000); // 30 second timeout
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
    if (this.subprocess) {
      return new Promise((resolve) => {
        if (this.subprocess) {
          this.subprocess.stdin?.end();
          this.subprocess.on('exit', () => {
            this.subprocess = null;
            resolve();
          });

          // Force kill after 5 seconds
          setTimeout(() => {
            if (this.subprocess) {
              this.subprocess.kill();
            }
            resolve();
          }, 5000);
        } else {
          resolve();
        }
      });
    }
  }
}

/**
 * Interpreter for the mutagen sidecar: LINER_TAGWRITER_PYTHON, then the
 * repo-local venv (packages/tagwriter-py/.venv), then the system python3.
 * Exported so tests decide availability with the same rule the client uses
 * (the previous copy used require('fs') inside an ES module, which threw,
 * was swallowed, and silently always chose the system python3).
 */
export function resolvePythonInterpreter(): string {
  const env = process.env.LINER_TAGWRITER_PYTHON;
  if (env) return env;
  const venv = path.resolve(import.meta.dirname, '../../../tagwriter-py/.venv/bin/python');
  if (existsSync(venv)) return venv;
  return 'python3';
}
