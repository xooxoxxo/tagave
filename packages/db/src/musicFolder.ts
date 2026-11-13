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

/** Why an attempt ended: fixed codes, never text from the host or the remote. */
export const MUSIC_HEAL_REASONS = ['mounted', 'no_systemd', 'not_in_fstab', 'mount_failed', 'still_empty', 'restart_failed', 'docker_failed'] as const;
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
