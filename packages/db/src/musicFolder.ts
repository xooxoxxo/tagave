/**
 * Is the music folder there? One answer for the owner's notice (web ›
 * MusicFolderNotice) and for the updater's self-heal (updater ›
 * music-heal.ts), so both act on the same signal. No table of its own:
 *
 *   unreachable   enabled scan roots whose latest scan was aborted
 *                 (scan_roots.last_status); `unmounted` when that scan was
 *                 stopped by the LIB-5 guard (no files where the index has
 *                 some: scans.stats.unmounted, worker › jobs/scanRoot.ts)
 *   heal          the updater's latest attempt to mount the music folder
 *                 again, from the audit log (music.heal.start when it
 *                 begins, music.heal when it ends, with ok and a fixed
 *                 reason code), within the last day
 *
 * A finished scan stamps last_status 'completed' and the folder drops out.
 */
import type postgres from 'postgres';

type Q = postgres.Sql<any> | postgres.TransactionSql<any>;

export const MUSIC_HEAL_START = 'music.heal.start';
export const MUSIC_HEAL_DONE = 'music.heal';

/**
 * Why an attempt ended: fixed codes, never text from the host or the remote.
 * The same list as HEAL_REASONS in packages/updater/src/music-heal.ts (the
 * updater does not depend on this package): change both together.
 */
export const MUSIC_HEAL_REASONS = ['mounted', 'no_systemd', 'not_in_fstab', 'mount_failed', 'still_empty', 'restart_failed', 'docker_failed', 'server_silent'] as const;
export type MusicHealReason = (typeof MUSIC_HEAL_REASONS)[number];

export interface UnreachableRoot {
  id: string;
  path: string;
  lastScanAt: Date | null;
  /** aborted by the LIB-5 guard (looks unmounted), not by a failed probe */
  unmounted: boolean;
}

export interface MusicHealAttempt {
  phase: 'start' | 'done';
  ok: boolean | null;
  reason: MusicHealReason | null;
  at: Date;
}

export interface MusicFolderState {
  unreachable: UnreachableRoot[];
  heal: MusicHealAttempt | null;
}

/** A start this old with no end is taken as over (the updater restarted mid-attempt). */
export const HEAL_START_STALE_MS = 10 * 60 * 1000;

export async function musicFolderState(sql: Q): Promise<MusicFolderState> {
  const roots = await sql<Array<{ id: string; path: string; last_scan_at: Date | null; unmounted: boolean | null }>>`
    select sr.id, sr.path, sr.last_scan_at, (s.stats ->> 'unmounted') = 'true' as unmounted
      from scan_roots sr
      left join lateral (select stats from scans where scan_root_id = sr.id order by started_at desc limit 1) s on true
     where sr.enabled and sr.last_status = 'aborted'
     order by sr.path`;
  // the at index walks back one day at most
  const [last] = await sql<Array<{ action: string; payload: { ok?: unknown; reason?: unknown } | null; at: Date }>>`
    select action, payload, at from audit_log
     where at > now() - interval '1 day' and action in (${MUSIC_HEAL_START}, ${MUSIC_HEAL_DONE})
     order by at desc limit 1`;
  const reason = last?.payload?.reason;
  return {
    unreachable: roots.map((r) => ({ id: r.id, path: r.path, lastScanAt: r.last_scan_at, unmounted: r.unmounted === true })),
    heal: last
      ? {
          phase: last.action === MUSIC_HEAL_START ? 'start' : 'done',
          ok: typeof last.payload?.ok === 'boolean' ? last.payload.ok : null,
          reason: (MUSIC_HEAL_REASONS as readonly unknown[]).includes(reason) ? (reason as MusicHealReason) : null,
          at: last.at,
        }
      : null,
  };
}

/** The updater should try to mount the music folder: a root looks unmounted. */
export function musicLooksUnmounted(state: MusicFolderState): boolean {
  return state.unreachable.some((r) => r.unmounted);
}

/**
 * What the owner's notice says: nothing; "Reconnecting music folder" while
 * an attempt runs, or after one mounted it until the rescan it asked for
 * finishes; else the folders that cannot be reached.
 */
export function musicFolderNotice(state: MusicFolderState, now = new Date()): { kind: 'none' } | { kind: 'healing' } | { kind: 'unreachable'; paths: string[] } {
  if (state.unreachable.length === 0) return { kind: 'none' };
  const h = state.heal;
  if (h?.phase === 'start' && now.getTime() - h.at.getTime() < HEAL_START_STALE_MS) return { kind: 'healing' };
  if (h?.phase === 'done' && h.ok && state.unreachable.every((r) => !r.lastScanAt || r.lastScanAt < h.at)) return { kind: 'healing' };
  return { kind: 'unreachable', paths: state.unreachable.map((r) => r.path) };
}

/** One audit entry per step of an attempt; the library is none (the install's). */
export async function recordMusicHeal(sql: Q, entry: { phase: 'start' } | { phase: 'done'; ok: boolean; reason: MusicHealReason }): Promise<void> {
  const action = entry.phase === 'start' ? MUSIC_HEAL_START : MUSIC_HEAL_DONE;
  const payload = entry.phase === 'start' ? {} : { ok: entry.ok, reason: entry.reason };
  await sql`insert into audit_log (library_id, actor_user_id, action, subject_type, payload)
            values (null, null, ${action}, 'music_folder', ${JSON.stringify(payload)}::text::jsonb)`;
}

/**
 * Music folder reach (0097, vault "tagave - Offline Library Spec" §2 "The
 * folder watch"): what the file worker's folder watch last saw on a root.
 * copy of @tagave/shared musicFolder.ts (db does not depend on shared);
 * api › reachCopies.test.ts checks they agree.
 */
export const ROOT_REACH_VALUES = ['unknown', 'online', 'offline', 'unmounted'] as const;
export type RootReach = (typeof ROOT_REACH_VALUES)[number];
export const ROOT_REACH_REASONS = ['server_silent', 'timeout', 'io_error', 'stale', 'empty', 'not_mounted'] as const;
export type RootReachReason = (typeof ROOT_REACH_REASONS)[number];

/** How many of a root's present files the watch asks about (the `checkMusicFolder` sample rule). */
const KNOWN_SAMPLE = 5;

export interface RootToWatch {
  id: string;
  path: string;
  displayName: string;
  reach: RootReach;
  reachSince: Date | null;
  /** up to 5 present files, relative to the root */
  known: string[];
}

/** Every enabled root, with its last reach and a few present files the probe looks for. */
export async function rootsToWatch(sql: Q): Promise<RootToWatch[]> {
  const rows = await sql<Array<{ id: string; path: string; display_name: string; reach: string; since_ms: number | null; known: string[] | null }>>`
    select sr.id, sr.path, sr.display_name, sr.reach,
           -- epoch ms: drizzle makes timestamps come back raw (text) on the shared client
           (extract(epoch from sr.reach_since) * 1000)::float8 as since_ms,
           array(select f.rel_path from files f
                  where f.scan_root_id = sr.id and f.status = 'present'
                  limit ${KNOWN_SAMPLE}) as known
      from scan_roots sr
     where sr.enabled
     order by sr.path`;
  return rows.map((r) => ({
    id: r.id,
    path: r.path,
    displayName: r.display_name,
    reach: (ROOT_REACH_VALUES as readonly string[]).includes(r.reach) ? (r.reach as RootReach) : 'unknown',
    reachSince: r.since_ms === null ? null : new Date(r.since_ms),
    known: r.known ?? [],
  }));
}

/**
 * One reading of a root. Always stamps `reach_checked_at`. On a change
 * (`changed`) it sets `reach`, `reach_reason` and `reach_since`. While the
 * root stays offline or not connected it also writes the reason, which can
 * change without a change of reach (server_silent, then timeout); `reach_since`
 * still moves only with `reach`.
 */
export async function recordReach(
  sql: Q,
  rootId: string,
  next: { reach: RootReach; reason: RootReachReason | null; since: Date | null; changed: boolean },
): Promise<void> {
  // An ISO string: drizzle makes timestamps pass through raw on the shared client.
  if (next.changed) {
    await sql`update scan_roots
                 set reach = ${next.reach}, reach_reason = ${next.reason}, reach_since = ${next.since?.toISOString() ?? null}::timestamptz, reach_checked_at = now()
               where id = ${rootId}`;
  } else if (next.reach !== 'online' && next.reach !== 'unknown') {
    await sql`update scan_roots set reach_reason = ${next.reason}, reach_checked_at = now() where id = ${rootId}`;
  } else {
    await sql`update scan_roots set reach_checked_at = now() where id = ${rootId}`;
  }
}
