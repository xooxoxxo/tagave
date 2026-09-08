#!/usr/bin/env node

import { runDoctor } from './index.js';
import type { Check } from './checks.js';

// Color support for TTY
const isTTY = process.stdout.isTTY;

const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
};

function colorize(text: string, color: keyof typeof colors): string {
  if (!isTTY) return text;
  return `${colors[color]}${text}${colors.reset}`;
}

function statusIcon(status: string): string {
  switch (status) {
    case 'pass':
      return colorize('✓', 'green');
    case 'warn':
      return colorize('⚠', 'yellow');
    case 'fail':
      return colorize('✗', 'red');
    case 'skip':
      return colorize('◯', 'cyan');
    default:
      return '?';
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatCheckLine(check: Check): string {
  const icon = statusIcon(check.status);
  const statusStr = check.status.toUpperCase().padEnd(4);
  const title = check.title.padEnd(20);
  const detail = check.detail;
  return `${icon} ${statusStr} ${title} ${detail}`;
}

async function main() {
  // Parse arguments
  const args = process.argv.slice(2);
  const command = args[0];

  // Check for DATABASE_URL
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error(colorize('ERROR: DATABASE_URL environment variable not set', 'red'));
    process.exit(1);
  }

  // Handle reseal subcommand
  if (command === 'reseal') {
    const { resealCredentials } = await import('./reseal.js');
    try {
      await resealCredentials(databaseUrl);
      console.log(colorize('Credentials re-sealed successfully', 'green'));
      process.exit(0);
    } catch (err) {
      const message = (err as Error).message || String(err);
      console.error(colorize(`FATAL: ${message}`, 'red'));
      process.exit(1);
    }
  }

  // Handle backup subcommand
  if (command === 'backup') {
    const { runBackup, defaultBackupDir } = await import('./backup.js');
    let outDir = defaultBackupDir(process.env);
    let keep: number | undefined;
    let jsonOut = false;
    for (let i = 1; i < args.length; i++) {
      const arg = args[i];
      const next = args[i + 1];
      if (arg === '--json') {
        jsonOut = true;
      } else if (arg === '--out' && next !== undefined) {
        outDir = next;
        i++;
      } else if (arg === '--keep' && next !== undefined) {
        const parsed = parseInt(next, 10);
        if (!Number.isInteger(parsed) || parsed < 1) {
          console.error(colorize('ERROR: --keep expects a positive integer (dumps to keep, including this one)', 'red'));
          process.exit(2);
        }
        keep = parsed;
        i++;
      } else {
        console.error(colorize(`ERROR: unknown option ${arg}; usage: backup [--out DIR] [--keep N] [--json]`, 'red'));
        process.exit(2);
      }
    }
    try {
      const result = await runBackup({ databaseUrl, outDir, ...(keep !== undefined ? { keep } : {}) });
      if (jsonOut) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(
          `${statusIcon('pass')} backup written ${result.path} (${formatBytes(result.bytes)}, ${result.tocEntries} TOC entries, ${(result.durationMs / 1000).toFixed(1)} s)`,
        );
        if (result.pruned.length > 0) {
          console.log(`  pruned ${result.pruned.length} older dump(s): ${result.pruned.join(', ')}`);
        }
      }
      process.exit(0);
    } catch (err) {
      const message = (err as Error).message || String(err);
      console.error(colorize(`FATAL: ${message}`, 'red'));
      process.exit(1);
    }
  }

  // Default: run doctor checks
  let json = false;
  let offline = false;
  let expectWorkers = 2;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--json') {
      json = true;
    } else if (arg === '--offline') {
      offline = true;
    } else if (arg === '--expect-workers') {
      const next = args[i + 1];
      if (next) {
        const parsed = parseInt(next, 10);
        if (Number.isInteger(parsed) && parsed >= 0) {
          expectWorkers = parsed;
          i++;
        }
      }
    }
  }

  // Get CACHE_DIR
  const cacheDir = process.env.CACHE_DIR;

  // Run doctor
  try {
    const result = await runDoctor({
      databaseUrl,
      ...(cacheDir ? { cacheDir } : {}),
      expectWorkers,
      offline,
    });

    if (json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      // Print checks
      for (const check of result.checks) {
        console.log(formatCheckLine(check));
      }

      // Print summary
      const failCount = result.checks.filter((c) => c.status === 'fail').length;
      const warnCount = result.checks.filter((c) => c.status === 'warn').length;
      const passCount = result.checks.filter((c) => c.status === 'pass').length;
      const skipCount = result.checks.filter((c) => c.status === 'skip').length;

      let summary = `\n${passCount} pass`;
      if (warnCount > 0) summary += `, ${colorize(`${warnCount} warn`, 'yellow')}`;
      if (failCount > 0) summary += `, ${colorize(`${failCount} fail`, 'red')}`;
      if (skipCount > 0) summary += `, ${skipCount} skip`;

      console.log(summary);
    }

    // Exit with 1 if any check failed
    process.exit(result.ok ? 0 : 1);
  } catch (err) {
    const message = (err as Error).message || String(err);
    console.error(colorize(`FATAL: ${message}`, 'red'));
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(colorize(`Uncaught error: ${(err as Error).message}`, 'red'));
  process.exit(1);
});
