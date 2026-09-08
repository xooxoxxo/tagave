/**
 * Mutagen sidecar tag writer client
 * Manages a long-lived subprocess communicating via JSON-lines over stdio
 * Spec §12.6 TAG-4; M2 build order #2
 */

import { spawn, type ChildProcess } from 'child_process';
import path from 'path';
import type { TagSet } from '@liner/shared';
import type { TagWriter, WriteOptions } from '@liner/core';

/**
 * Response from the sidecar
 */
interface SidecarResponse {
  [key: string]: any;
  error?: string;
  success?: boolean;
  supported?: boolean;
}

/**
 * Mutagen tag writer implementation via sidecar subprocess
 * Creates one long-lived process per instance, reused for all read/write calls
 */
export class MutagenTagWriter implements TagWriter {
  readonly id = 'mutagen';
  private subprocess: ChildProcess | null = null;
  private inputBuffer = '';
  private responseQueue: Promise<SidecarResponse>[] = [];
  private responseResolvers: Array<(value: SidecarResponse) => void> = [];
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

        // Handle stderr (logging)
        this.subprocess.stderr?.on('data', (data) => {
          const message = data.toString().trim();
          if (message && !message.includes('tagwriter sidecar started')) {
            process.stderr.write(`[mutagen sidecar] ${message}\n`);
          }
        });

        // Handle subprocess exit
        this.subprocess.on('exit', (code) => {
          if (code !== 0 && code !== null) {
            process.stderr.write(`[mutagen sidecar] exited with code ${code}\n`);
          }
          this.subprocess = null;
        });

        // Handle subprocess errors
        this.subprocess.on('error', (error) => {
          reject(error);
        });

        // Give the subprocess a moment to start and confirm it's running
        setTimeout(() => resolve(), 100);
      } catch (error) {
        reject(error);
      }
    });
  }

  /**
   * Detect Python interpreter from environment
   */
  private getPythonInterpreter(): string {
    // Try environment variable first
    const envInterpreter = process.env.LINER_TAGWRITER_PYTHON;
    if (envInterpreter) {
      return envInterpreter;
    }

    // Try .venv in the tagwriter-py directory
    const venvPath = path.resolve(
      import.meta.dirname,
      '../../../tagwriter-py/.venv/bin/python'
    );
    try {
      // Check if .venv exists
      const fs = require('fs');
      if (fs.existsSync(venvPath)) {
        return venvPath;
      }
    } catch {
      // Ignore
    }

    // Fall back to system python3
    return 'python3';
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
        const resolver = this.responseResolvers.shift();
        if (resolver) {
          resolver(response);
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
      throw new Error('Subprocess stdin is not available');
    }

    return new Promise((resolve, reject) => {
      // Add resolver to queue
      this.responseResolvers.push(resolve);

      // Send command
      this.subprocess!.stdin!.write(command + '\n', (error) => {
        if (error) {
          this.responseResolvers.pop();
          reject(error);
        }
      });

      // Set timeout to prevent hanging
      setTimeout(() => {
        const idx = this.responseResolvers.indexOf(resolve);
        if (idx !== -1) {
          this.responseResolvers.splice(idx, 1);
          reject(new Error('Sidecar response timeout'));
        }
      }, 30000); // 30 second timeout
    });
  }

  /**
   * Read tags from an audio file
   */
  async read(filePath: string): Promise<TagSet> {
    const response = await this.sendCommand(`read ${filePath}`);

    if (response.error) {
      throw new Error(`Failed to read tags from ${filePath}: ${response.error}`);
    }

    // Remove error and other meta fields
    const result: TagSet = {};
    for (const [key, value] of Object.entries(response)) {
      if (!key.startsWith('__') && key !== 'error' && key !== 'success') {
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
    // Build the write command with JSON-encoded parameters
    const tagsJson = JSON.stringify(tags);
    const optsJson = JSON.stringify(opts || {});

    // Quote paths for shell safety
    const quotedPath = `'${filePath.replace(/'/g, "'\\''")}'`;

    const command = `write ${quotedPath} ${tagsJson} ${optsJson}`;
    const response = await this.sendCommand(command);

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
    const response = await this.sendCommand(`supports ${container}`);

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
