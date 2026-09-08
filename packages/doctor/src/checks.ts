import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import postgres from 'postgres';
import { MIGRATIONS_DIR } from '@liner/db';
import { MusicBrainzProvider, DiscogsProvider, isSealed, openSecret } from '@liner/core';

export type CheckStatus = 'pass' | 'warn' | 'fail' | 'skip';

export interface Check {
  id: string;
  title: string;
  status: CheckStatus;
  detail: string;
  durationMs: number;
}

// Helper to format duration for display
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

// Helper to parse migrations from directory
export async function getMigrationFiles(): Promise<string[]> {
  try {
    const files = await fs.readdir(MIGRATIONS_DIR);
    return files.filter((f) => f.endsWith('.sql')).sort();
  } catch {
    return [];
  }
}

// Helper to get applied migrations from database
export async function getAppliedMigrations(sql: postgres.Sql): Promise<Set<string>> {
  try {
    const applied = new Set(
      (await sql`select name from _migrations`).map((r) => r['name'] as string),
    );
    return applied;
  } catch {
    return new Set();
  }
}

// Check 1: Database connectivity and server version
export async function checkDatabase(databaseUrl: string): Promise<Check> {
  const start = Date.now();
  try {
    const sql = postgres(databaseUrl, { max: 1 });
    try {
      const result = await sql`select version() as version`;
      const version = (result[0]?.['version'] as string) || 'unknown';
      // Extract Postgres version (e.g., "PostgreSQL 16.1 (Debian 16.1-1.pgdg120+1) on x86_64-pc-linux-gnu...")
      const versionMatch = version.match(/PostgreSQL (\d+)/);
      const majorVersion = versionMatch ? `${versionMatch[1]}.x` : version.split(' ')[1] || 'unknown';

      return {
        id: 'database',
        title: 'Database',
        status: 'pass',
        detail: `Postgres ${majorVersion}, ${Date.now() - start}ms`,
        durationMs: Date.now() - start,
      };
    } finally {
      await sql.end();
    }
  } catch (err) {
    return {
      id: 'database',
      title: 'Database',
      status: 'fail',
      detail: `Connection failed: ${(err as Error).message}`,
      durationMs: Date.now() - start,
    };
  }
}

// Check 2: Migrations status
export async function checkMigrations(databaseUrl: string): Promise<Check> {
  const start = Date.now();
  try {
    const sql = postgres(databaseUrl, { max: 1 });
    try {
      const allFiles = await getMigrationFiles();
      const applied = await getAppliedMigrations(sql);

      // Check for pending migrations
      const pending = allFiles.filter((f) => !applied.has(f));
      if (pending.length > 0) {
        return {
          id: 'migrations',
          title: 'Migrations',
          status: 'fail',
          detail: `${pending.length} pending: ${pending.slice(0, 3).join(', ')}${pending.length > 3 ? '...' : ''}`,
          durationMs: Date.now() - start,
        };
      }

      // Check for unknown ledger rows
      const unknownRows = Array.from(applied).filter((name) => !allFiles.includes(name));
      if (unknownRows.length > 0) {
        return {
          id: 'migrations',
          title: 'Migrations',
          status: 'warn',
          detail: `${unknownRows.length} unknown in ledger (rolled back?): ${unknownRows.slice(0, 2).join(', ')}${unknownRows.length > 2 ? '...' : ''}`,
          durationMs: Date.now() - start,
        };
      }

      return {
        id: 'migrations',
        title: 'Migrations',
        status: 'pass',
        detail: `${allFiles.length} applied`,
        durationMs: Date.now() - start,
      };
    } finally {
      await sql.end();
    }
  } catch (err) {
    return {
      id: 'migrations',
      title: 'Migrations',
      status: 'fail',
      detail: `Failed to check: ${(err as Error).message}`,
      durationMs: Date.now() - start,
    };
  }
}

// Check 3: Contact string set in settings
export async function checkContactString(databaseUrl: string): Promise<Check> {
  const start = Date.now();
  try {
    const sql = postgres(databaseUrl, { max: 1 });
    try {
      const result = await sql`
        select settings->>'contactString' as contact_string
        from libraries
        limit 1
      `;

      const contactString = result[0]?.['contact_string'] as string | null;

      if (!contactString) {
        return {
          id: 'contactString',
          title: 'Contact String',
          status: 'fail',
          detail: 'Not set in library settings (providers require it)',
          durationMs: Date.now() - start,
        };
      }

      return {
        id: 'contactString',
        title: 'Contact String',
        status: 'pass',
        detail: `Set to: ${contactString.substring(0, 50)}${contactString.length > 50 ? '...' : ''}`,
        durationMs: Date.now() - start,
      };
    } finally {
      await sql.end();
    }
  } catch (err) {
    return {
      id: 'contactString',
      title: 'Contact String',
      status: 'fail',
      detail: `Failed to check: ${(err as Error).message}`,
      durationMs: Date.now() - start,
    };
  }
}

// Check 4: Worker heartbeat
export async function checkWorkerHeartbeat(
  databaseUrl: string,
  expectWorkers: number = 2,
): Promise<Check> {
  const start = Date.now();
  try {
    const sql = postgres(databaseUrl, { max: 1 });
    try {
      // Find the freshest worker heartbeat rows within the last 120 seconds per workerId
      const result = await sql`
        select distinct (progress->>'workerId') as worker_id, created_at
        from job_runs
        where type = 'worker.heartbeat'
          and created_at > now() - interval '120 seconds'
        order by created_at desc
      `;

      const workerIds = new Set(result.map((r) => r['worker_id'] as string).filter(Boolean));
      const liveWorkers = workerIds.size;

      if (expectWorkers === 0) {
        return {
          id: 'workerHeartbeat',
          title: 'Worker Heartbeat',
          status: liveWorkers === 0 ? 'skip' : 'pass',
          detail: liveWorkers === 0 ? 'no workers expected (--expect-workers 0)' : `${liveWorkers} live worker(s)`,
          durationMs: Date.now() - start,
        };
      }
      if (liveWorkers === 0) {
        return {
          id: 'workerHeartbeat',
          title: 'Worker Heartbeat',
          status: 'fail',
          detail: 'No live workers detected (last heartbeat >120s ago)',
          durationMs: Date.now() - start,
        };
      }

      if (liveWorkers < expectWorkers) {
        return {
          id: 'workerHeartbeat',
          title: 'Worker Heartbeat',
          status: 'warn',
          detail: `${liveWorkers} live worker(s), expected ${expectWorkers}`,
          durationMs: Date.now() - start,
        };
      }

      return {
        id: 'workerHeartbeat',
        title: 'Worker Heartbeat',
        status: 'pass',
        detail: `${liveWorkers} live worker(s) detected`,
        durationMs: Date.now() - start,
      };
    } finally {
      await sql.end();
    }
  } catch (err) {
    return {
      id: 'workerHeartbeat',
      title: 'Worker Heartbeat',
      status: 'fail',
      detail: `Failed to check: ${(err as Error).message}`,
      durationMs: Date.now() - start,
    };
  }
}

// Check 5: Scan roots validation
export async function checkScanRoots(databaseUrl: string): Promise<Check> {
  const start = Date.now();
  try {
    const sql = postgres(databaseUrl, { max: 1 });
    try {
      const result = await sql`
        select path, writable, validation_status, validation_message, validated_at, probe_writable
        from scan_roots
        where enabled = true
        order by path
      `;

      if (result.length === 0) {
        return {
          id: 'scanRoots',
          title: 'Scan Roots',
          status: 'warn',
          detail: 'No enabled scan roots configured',
          durationMs: Date.now() - start,
        };
      }

      const issues: string[] = [];
      const warnings: string[] = [];

      for (const row of result) {
        const rootPath = row['path'] as string;
        const writable = row['writable'] as boolean;
        const status = row['validation_status'] as string;
        const message = row['validation_message'] as string | null;
        const validatedAt = row['validated_at'] as Date | null;
        const probeWritable = row['probe_writable'] as boolean | null;

        // Check if path exists on this host
        let hostProbe: string | undefined;
        try {
          await fs.stat(rootPath);
          try {
            const dir = await fs.opendir(rootPath);
            await dir.close();
            hostProbe = 'readable';
          } catch {
            hostProbe = 'present but not readable';
          }
        } catch {
          hostProbe = 'not mounted on this host';
        }

        // Evaluate status
        if (status === 'ok') {
          const ageMinutes = validatedAt ? (Date.now() - new Date(validatedAt).getTime()) / 60000 : 999;
          let statusDetail = `${rootPath} (validated ${Math.round(ageMinutes)}m ago)`;
          if (hostProbe) statusDetail += ` [${hostProbe}]`;

          if (ageMinutes > 60) {
            warnings.push(`${statusDetail} (validation >1h old)`);
          } else if (writable && !probeWritable) {
            warnings.push(`${statusDetail} (writable intent but probe_writable=false)`);
          }
        } else if (status === 'pending') {
          warnings.push(`${rootPath} (validation pending)`);
        } else if (status === 'missing' || status === 'not_directory' || status === 'unreadable') {
          issues.push(`${rootPath} (${status}): ${message || 'unknown reason'}`);
        }
      }

      if (issues.length > 0) {
        return {
          id: 'scanRoots',
          title: 'Scan Roots',
          status: 'fail',
          detail: `${issues.length} failed: ${issues.slice(0, 2).join('; ')}${issues.length > 2 ? '; ...' : ''}`,
          durationMs: Date.now() - start,
        };
      }

      if (warnings.length > 0) {
        return {
          id: 'scanRoots',
          title: 'Scan Roots',
          status: 'warn',
          detail: `${warnings.length} warning(s): ${warnings.slice(0, 2).join('; ')}${warnings.length > 2 ? '; ...' : ''}`,
          durationMs: Date.now() - start,
        };
      }

      return {
        id: 'scanRoots',
        title: 'Scan Roots',
        status: 'pass',
        detail: `${result.length} root(s) OK`,
        durationMs: Date.now() - start,
      };
    } finally {
      await sql.end();
    }
  } catch (err) {
    return {
      id: 'scanRoots',
      title: 'Scan Roots',
      status: 'fail',
      detail: `Failed to check: ${(err as Error).message}`,
      durationMs: Date.now() - start,
    };
  }
}

// Check 6: Cache directory writability
export async function checkCacheDir(cacheDir?: string): Promise<Check> {
  const start = Date.now();
  const dir = cacheDir || path.join(os.homedir(), 'liner-cache');

  try {
    // Ensure directory exists
    await fs.mkdir(dir, { recursive: true });

    // Write and delete a temp file
    const testFile = path.join(dir, `.liner-doctor-${Date.now()}.tmp`);
    try {
      await fs.writeFile(testFile, 'test', 'utf-8');
      await fs.unlink(testFile);

      return {
        id: 'cacheDir',
        title: 'Cache Directory',
        status: 'pass',
        detail: `${dir} (writable)`,
        durationMs: Date.now() - start,
      };
    } catch (writeErr) {
      return {
        id: 'cacheDir',
        title: 'Cache Directory',
        status: 'fail',
        detail: `${dir} (not writable: ${(writeErr as Error).message})`,
        durationMs: Date.now() - start,
      };
    } finally {
      try {
        await fs.unlink(testFile);
      } catch {
        // Ignore cleanup errors
      }
    }
  } catch (err) {
    return {
      id: 'cacheDir',
      title: 'Cache Directory',
      status: 'fail',
      detail: `Failed to access ${dir}: ${(err as Error).message}`,
      durationMs: Date.now() - start,
    };
  }
}

// Check 7: Provider connectivity
/**
 * Every process on this network shares one MusicBrainz / Discogs budget
 * through provider_state (see the worker's pacer). A diagnostic request
 * that skips the queue would race the identify worker and read as a 503.
 */
async function claimProviderSlot(sql: postgres.Sql, provider: string, intervalMs: number): Promise<void> {
  const secs = intervalMs / 1000;
  const rows = await sql`
    insert into provider_state (provider, window_started_at, requests_used, next_slot_at)
    values (${provider}, now(), 1, now() + make_interval(secs => ${secs}))
    on conflict (provider) do update set
      next_slot_at = greatest(
        coalesce(provider_state.next_slot_at, now()), now(),
        coalesce(provider_state.circuit_open_until, now())
      ) + make_interval(secs => ${secs}),
      requests_used = coalesce(provider_state.requests_used, 0) + 1
    returning extract(epoch from (next_slot_at - make_interval(secs => ${secs}) - now())) * 1000 as wait_ms`;
  const waitMs = Math.max(0, Math.round(Number(rows[0]?.['wait_ms'] ?? 0)));
  if (waitMs > 0) await new Promise((r) => setTimeout(r, Math.min(waitMs, 120_000)));
}

export async function checkProviders(
  databaseUrl: string,
  offline: boolean = false,
  timeoutMs: number = 10000,
): Promise<Check> {
  const start = Date.now();

  if (offline) {
    return {
      id: 'providers',
      title: 'Providers',
      status: 'skip',
      detail: '--offline flag set',
      durationMs: Date.now() - start,
    };
  }

  try {
    const sql = postgres(databaseUrl, { max: 1 });
    try {
      const result = await sql`
        select settings->>'contactString' as contact_string,
               settings->>'discogsToken' as discogs_token,
               settings->>'acoustidKey' as acoustid_key
        from libraries
        limit 1
      `;

      const contactString = result[0]?.['contact_string'] as string | null;
      const acoustidKey = result[0]?.['acoustid_key'] as string | null;
      // Credentials are sealed at rest (XO-299): open the box with this host's
      // APP_SECRET, otherwise probe unauthenticated and say why.
      const storedToken = result[0]?.['discogs_token'] as string | null;
      let discogsToken: string | null = storedToken;
      let tokenNote = '';
      if (storedToken && isSealed(storedToken)) {
        const appSecret = process.env.APP_SECRET;
        if (!appSecret) {
          discogsToken = null;
          tokenNote = ' (sealed token; APP_SECRET missing here)';
        } else {
          try {
            discogsToken = openSecret(storedToken, appSecret);
          } catch {
            discogsToken = null;
            tokenNote = ' (sealed token does not open with this APP_SECRET)';
          }
        }
      }

      const checks: { name: string; status: CheckStatus; detail: string }[] = [];

      // MusicBrainz — UA format per their policy: App/version (contact)
      const userAgent = contactString ? `Liner-doctor/0.1 (+${contactString})` : 'Liner-doctor/0.1';
      try {
        await claimProviderSlot(sql, 'musicbrainz', 1100);
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

        const mbResponse = await fetch(
          'https://musicbrainz.org/ws/2/release-group/082c6aff-a7cc-36e0-a960-35a578ecd937?fmt=json',
          {
            headers: {
              'User-Agent': userAgent,
              Accept: 'application/json',
            },
            signal: controller.signal,
          },
        );

        clearTimeout(timeoutId);

        if (mbResponse.ok) {
          checks.push({ name: 'MusicBrainz', status: 'pass', detail: 'OK' });
        } else if (mbResponse.status === 503) {
          // MusicBrainz answers 503 whenever the shared per-IP budget is busy
          // (the workers pace and retry); reachable, just throttled right now.
          checks.push({
            name: 'MusicBrainz',
            status: 'warn',
            detail: 'HTTP 503 (rate limited right now; workers are pacing — retry in a minute)',
          });
        } else {
          checks.push({
            name: 'MusicBrainz',
            status: 'fail',
            detail: `HTTP ${mbResponse.status}`,
          });
        }
      } catch (err) {
        checks.push({
          name: 'MusicBrainz',
          status: 'fail',
          detail: `Network error: ${(err as Error).message}`,
        });
      }

      // Discogs
      try {
        await claimProviderSlot(sql, 'discogs', discogsToken ? 1091 : 2400);
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

        const discogsUrl = new URL('https://api.discogs.com/database/search');
        discogsUrl.searchParams.set('q', 'nevermind');
        discogsUrl.searchParams.set('per_page', '1');
        // Header auth like the worker's provider (a query-string token leaks into logs).
        const dcHeaders: Record<string, string> = { 'User-Agent': userAgent, Accept: 'application/json' };
        if (discogsToken) dcHeaders['Authorization'] = `Discogs token=${discogsToken}`;

        const dcResponse = await fetch(discogsUrl.toString(), { headers: dcHeaders, signal: controller.signal });

        clearTimeout(timeoutId);

        if (dcResponse.ok) {
          const rateLimit = dcResponse.headers.get('x-discogs-ratelimit-remaining');
          const limit = dcResponse.headers.get('x-discogs-ratelimit');
          // A token that Discogs rejects silently drops to the 25/min bucket.
          const isAuth = discogsToken ? (limit === '60' ? ' (authenticated)' : ' (token NOT accepted — unauthenticated bucket)') : '';
          checks.push({
            name: 'Discogs',
            status: discogsToken && limit !== '60' ? 'warn' : 'pass',
            detail: `OK${isAuth}${tokenNote}${rateLimit ? `, ${rateLimit}/${limit ?? '?'} remaining` : ''}`,
          });
        } else {
          checks.push({
            name: 'Discogs',
            status: 'warn',
            detail: `HTTP ${dcResponse.status} (optional)`,
          });
        }
      } catch (err) {
        checks.push({
          name: 'Discogs',
          status: 'warn',
          detail: `Network error (optional): ${(err as Error).message}`,
        });
      }

      // AcoustID
      if (acoustidKey) {
        checks.push({
          name: 'AcoustID',
          status: 'skip',
          detail: 'Key stored; fingerprinting not enabled yet',
        });
      }

      // Wikidata
      checks.push({
        name: 'Wikidata',
        status: 'skip',
        detail: 'No credential',
      });

      // Determine overall status
      const failures = checks.filter((c) => c.status === 'fail');
      const warnings = checks.filter((c) => c.status === 'warn');

      if (failures.length > 0) {
        return {
          id: 'providers',
          title: 'Providers',
          status: 'fail',
          detail: `${failures.map((c) => `${c.name}: ${c.detail}`).join('; ')}`,
          durationMs: Date.now() - start,
        };
      }

      if (warnings.length > 0) {
        return {
          id: 'providers',
          title: 'Providers',
          status: 'warn',
          detail: checks.filter((c) => c.status !== 'skip').map((c) => `${c.name}: ${c.detail}`).join('; '),
          durationMs: Date.now() - start,
        };
      }

      const checkDetails = checks
        .filter((c) => c.status !== 'skip')
        .map((c) => `${c.name}: ${c.detail}`)
        .join('; ');

      return {
        id: 'providers',
        title: 'Providers',
        status: 'pass',
        detail: `${checkDetails} OK`,
        durationMs: Date.now() - start,
      };
    } finally {
      await sql.end();
    }
  } catch (err) {
    return {
      id: 'providers',
      title: 'Providers',
      status: 'fail',
      detail: `Failed to check: ${(err as Error).message}`,
      durationMs: Date.now() - start,
    };
  }
}

// Check 8: App secret (only on app host where APP_SECRET is set)
export async function checkAppSecret(databaseUrl?: string): Promise<Check> {
  const start = Date.now();
  const secret = process.env.APP_SECRET;

  if (!secret) {
    // On a worker host without APP_SECRET, check if there are sealed credentials
    if (databaseUrl) {
      try {
        const sql = postgres(databaseUrl, { max: 1 });
        try {
          const result = await sql`
            select count(*) as sealed_count
            from libraries
            where settings->>'discogsToken' like 'enc:%'
               or settings->>'acoustidKey' like 'enc:%'
          `;
          const sealedCount = Number(result[0]?.['sealed_count'] ?? 0);
          if (sealedCount > 0) {
            return {
              id: 'appSecret',
              title: 'App Secret',
              status: 'warn',
              detail: `Worker host with ${sealedCount} sealed credential(s) but APP_SECRET not set`,
              durationMs: Date.now() - start,
            };
          }
        } finally {
          await sql.end();
        }
      } catch (err) {
        // Ignore DB errors; just skip the check
      }
    }

    return {
      id: 'appSecret',
      title: 'App Secret',
      status: 'skip',
      detail: 'Worker host (APP_SECRET not set)',
      durationMs: Date.now() - start,
    };
  }

  // Same rule as the api boot: under 32 characters fails; a hex-only value
  // under 64 characters (< 32 bytes of entropy) warns and names the rotation path.
  const isHex = /^[0-9a-fA-F]+$/.test(secret);
  if (secret.length < 32) {
    return {
      id: 'appSecret',
      title: 'App Secret',
      status: 'fail',
      detail: `Too short: ${secret.length} < 32 characters (openssl rand -hex 32)`,
      durationMs: Date.now() - start,
    };
  }
  if (isHex && secret.length < 64) {
    return {
      id: 'appSecret',
      title: 'App Secret',
      status: 'warn',
      detail: `${secret.length} hex characters (< 32 bytes of entropy); rotate via liner-doctor reseal`,
      durationMs: Date.now() - start,
    };
  }

  return {
    id: 'appSecret',
    title: 'App Secret',
    status: 'pass',
    detail: `Set, length ${secret.length}`,
    durationMs: Date.now() - start,
  };
}

// Check 9: build identity across processes (XO-313). The heartbeat rows carry
// each worker's sha; this process's own sha comes from readBuildInfo(), so
// run from the app container the check compares app vs workers, and run from
// a dev checkout it simply reports what the workers are on.
export async function checkWorkerVersions(databaseUrl: string): Promise<Check> {
  const start = Date.now();
  try {
    const { readBuildInfo } = await import('@liner/core');
    const me = readBuildInfo();
    const sql = postgres(databaseUrl, { max: 1 });
    try {
      const rows = await sql`
        select distinct on (progress->>'workerId') progress->>'workerId' as worker_id, progress->>'sha' as sha
        from job_runs
        where type = 'worker.heartbeat' and created_at > now() - interval '120 seconds'
        order by progress->>'workerId', created_at desc`;
      if (rows.length === 0) {
        return { id: 'versions', title: 'Build Versions', status: 'skip', detail: `no live workers; this process is ${me.version} @ ${me.sha ?? 'unknown'} (${me.source})`, durationMs: Date.now() - start };
      }
      const shas = new Map<string, number>();
      for (const r of rows) {
        const sha = (r['sha'] as string | null) ?? 'unknown';
        shas.set(sha, (shas.get(sha) ?? 0) + 1);
      }
      const summary = [...shas.entries()].map(([sha, n]) => `${sha} (${n})`).join(', ');
      const mine = me.sha ?? 'unknown';
      const allMatch = shas.size === 1 && shas.has(mine);
      return {
        id: 'versions',
        title: 'Build Versions',
        status: allMatch ? 'pass' : 'warn',
        detail: allMatch
          ? `${rows.length} worker(s) and this process at ${mine}`
          : `this process ${mine} (${me.source}); workers at ${summary} — redeploy the lagging side`,
        durationMs: Date.now() - start,
      };
    } finally {
      await sql.end({ timeout: 2 });
    }
  } catch (err) {
    return { id: 'versions', title: 'Build Versions', status: 'fail', detail: `Failed to check: ${(err as Error).message}`, durationMs: Date.now() - start };
  }
}
