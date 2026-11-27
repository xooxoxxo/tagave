/**
 * Is the music folder there? One answer for the owner's notice (web ›
 * MusicFolderNotice) and for the updater's self-heal (updater ›
 * music-heal.ts), so both act on the same signal. No table of its own:
 *
 *   unreachable   enabled scan roots the folder watch reads offline or
 *                 unmounted (scan_roots.reach, 0097), with since when, why
 *                 and what waits for them (parked_jobs). Legacy: a root
 *                 with no reading yet (reach unknown) whose latest scan was
 *                 aborted (scan_roots.last_status), as before 0097;
 *                 `unmounted` when that scan was stopped by the LIB-5 guard
 *                 (no files where the index has some: scans.stats.unmounted,
 *                 worker › jobs/scanRoot.ts)
 *   heal          the updater's latest attempt to mount the music folder
 *                 again, from the audit log (music.heal.start when it
 *                 begins, music.heal when it ends, with ok and a fixed
 *                 reason code), within the last day
 *
 * A finished scan stamps last_status 'completed' and a legacy folder drops
 * out; a watched folder drops out when the watch reads it online.
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
  /** the root's display name */
  name: string;
  path: string;
  lastScanAt: Date | null;
  /** latest scan aborted by the LIB-5 guard (looks unmounted), not by a failed probe */
  unmounted: boolean;
  /** offline or unmounted; unknown for a legacy root (no reading yet) */
  reach: RootReach;
  /** when reach last changed; null with no reading */
  since: Date | null;
  reason: RootReachReason | null;
  waiting: WaitingCounts;
}

/** Parked work per root, by kind. copy of WaitingCounts in @tagave/shared musicFolder.ts (db does not depend on shared). */
export interface WaitingCounts {
  scans: number;
  tagWrites: number;
  other: number;
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
  // epoch ms: drizzle makes timestamps come back raw (text) on the shared client
  const roots = await sql<Array<{ id: string; name: string; path: string; last_scan_ms: number | null; unmounted: boolean | null; reach: string; since_ms: number | null; reason: string | null }>>`
    select sr.id, sr.display_name as name, sr.path,
           (extract(epoch from sr.last_scan_at) * 1000)::float8 as last_scan_ms,
           (s.stats ->> 'unmounted') = 'true' as unmounted,
           sr.reach, (extract(epoch from sr.reach_since) * 1000)::float8 as since_ms, sr.reach_reason as reason
      from scan_roots sr
      left join lateral (select stats from scans where scan_root_id = sr.id order by started_at desc limit 1) s on true
     where sr.enabled and (sr.reach in ('offline', 'unmounted') or (sr.reach = 'unknown' and sr.last_status = 'aborted'))
     order by sr.path`;
  const waiting = await waitingCounts(sql, roots.map((r) => r.id));
  // the at index walks back one day at most
  const [last] = await sql<Array<{ action: string; payload: { ok?: unknown; reason?: unknown } | null; at: Date }>>`
    select action, payload, at from audit_log
     where at > now() - interval '1 day' and action in (${MUSIC_HEAL_START}, ${MUSIC_HEAL_DONE})
     order by at desc limit 1`;
  const reason = last?.payload?.reason;
  return {
    unreachable: roots.map((r) => ({
      id: r.id,
      name: r.name,
      path: r.path,
      lastScanAt: r.last_scan_ms === null ? null : new Date(r.last_scan_ms),
      unmounted: r.unmounted === true,
      reach: asReach(r.reach),
      since: r.since_ms === null ? null : new Date(r.since_ms),
      reason: (ROOT_REACH_REASONS as readonly unknown[]).includes(r.reason) ? (r.reason as RootReachReason) : null,
      waiting: waiting.get(r.id) ?? noneWaiting(),
    })),
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

/**
 * The updater should try to mount the music folder: the watch reads a root
 * unmounted, or (legacy, no reading yet) its latest scan was stopped by the
 * LIB-5 guard. Offline is the healer's server_silent case: nothing to mount.
 */
export function musicLooksUnmounted(state: MusicFolderState): boolean {
  return state.unreachable.some((r) => r.reach === 'unmounted' || (r.reach === 'unknown' && r.unmounted));
}

/** A folder in the notice; `since` as ISO 8601 (the API's MusicFolderView in @tagave/shared). */
export interface MusicFolderNoticeFolder {
  id: string;
  name: string;
  path: string;
  reach: RootReach;
  since: string | null;
  reason: RootReachReason | null;
  waiting: WaitingCounts;
}

export type MusicFolderNotice =
  | { kind: 'none' }
  | { kind: 'healing' }
  /** `paths`: the alias an older web build reads (it knew `unreachable` with paths); one release */
  | { kind: 'offline'; folders: MusicFolderNoticeFolder[]; paths: string[] };

/**
 * What the owner's notice says: nothing; "Reconnecting music folder" while
 * an attempt runs, or after one mounted it until the rescan it asked for
 * finishes; else the folders that are offline or not connected.
 */
export function musicFolderNotice(state: MusicFolderState, now = new Date()): MusicFolderNotice {
  if (state.unreachable.length === 0) return { kind: 'none' };
  const h = state.heal;
  if (h?.phase === 'start' && now.getTime() - h.at.getTime() < HEAL_START_STALE_MS) return { kind: 'healing' };
  if (h?.phase === 'done' && h.ok && state.unreachable.every((r) => !r.lastScanAt || r.lastScanAt < h.at)) return { kind: 'healing' };
  return {
    kind: 'offline',
    paths: state.unreachable.map((r) => r.path),
    folders: state.unreachable.map((r) => ({ id: r.id, name: r.name, path: r.path, reach: r.reach, since: r.since?.toISOString() ?? null, reason: r.reason, waiting: r.waiting })),
  };
}

const SCAN_QUEUES = ['scan.root', 'scan.dir'];
const TAG_WRITE_QUEUES = ['tags.apply', 'tags.revert', 'files.embedCover'];

function noneWaiting(): WaitingCounts {
  return { scans: 0, tagWrites: 0, other: 0 };
}

/**
 * What waits for each root (parked_jobs), by kind: scans; tag writes (the
 * tag-writing queues, and parked maintenance tasks, `queue = 'maintenance'`
 * with `data.taskId`, that apply a Tag Plan (task queue tags.apply) or embed a
 * cover); the rest. Every asked root is in the answer, at zero when nothing waits.
 */
export async function waitingCounts(sql: Q, rootIds: string[]): Promise<Map<string, WaitingCounts>> {
  const out = new Map<string, WaitingCounts>(rootIds.map((id) => [id, noneWaiting()]));
  if (rootIds.length === 0) return out;
  const rows = await sql<Array<{ root_id: string; scans: number; tag_writes: number; total: number }>>`
    select p.scan_root_id as root_id,
           (count(*) filter (where p.queue = any(${SCAN_QUEUES}::text[])))::int as scans,
           (count(*) filter (where p.queue = any(${TAG_WRITE_QUEUES}::text[])
                              or (p.queue = 'maintenance' and (t.queue = any(${TAG_WRITE_QUEUES}::text[]) or t.kind = 'embed-cover'))))::int as tag_writes,
           count(*)::int as total
      from parked_jobs p
      left join maintenance_tasks t on p.queue = 'maintenance' and t.id::text = p.data ->> 'taskId'
     where p.scan_root_id = any(${rootIds}::uuid[])
     group by p.scan_root_id`;
  for (const r of rows) out.set(r.root_id, { scans: r.scans, tagWrites: r.tag_writes, other: r.total - r.scans - r.tag_writes });
  return out;
}

/** Every enabled root's reach, for the updater's healer (GET /internal/updater/music); by path. */
export async function rootReaches(sql: Q): Promise<Array<{ id: string; reach: RootReach }>> {
  const rows = await sql<Array<{ id: string; reach: string }>>`select id, reach from scan_roots where enabled order by path`;
  return rows.map((r) => ({ id: r.id, reach: asReach(r.reach) }));
}

function asReach(value: string): RootReach {
  return (ROOT_REACH_VALUES as readonly string[]).includes(value) ? (value as RootReach) : 'unknown';
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
    reach: asReach(r.reach),
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
