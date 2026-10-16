/**
 * "The disk is filling up": a Banner across the top of every page for the
 * owner while the doctor's disk check warns or fails, with a link to
 * Settings › Storage. 2026-10-15 a full disk stopped Postgres during an
 * update and nothing in the app had said so.
 *
 * It reads the status from the public /health (ok, warn or error, nothing
 * about the host) every five minutes and when the tab comes back. Only when
 * a disk warns or fails does it ask the owner-only /system/checks for the
 * numbers. Only people who can manage the system ever ask.
 */
import type { ReactNode } from 'react';
import { Link, useLocation } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import type { DiskSpaceView, SessionUser } from '@tagave/shared';
import { Banner } from './ui';
import { useMe } from '../hooks';
import { api } from '../services/api';
import { formatBytes } from '../utils/format';
import { canManageSystem } from '../utils/permissions';
import styles from './DiskSpaceNotice.module.css';

/** The disk status from a /health body (200 or 503): ok, warn or error. */
export function diskStatusFromHealth(body: unknown): 'ok' | 'warn' | 'error' | null {
  const disk = (body as { disk?: unknown } | null)?.disk;
  return disk === 'ok' || disk === 'warn' || disk === 'error' ? disk : null;
}

/** The disk check's numbers from a /system/checks body (owner only), if it has them. */
export function diskFromChecks(body: unknown): DiskSpaceView | null {
  const checks = (body as { checks?: Array<{ id?: string; disk?: DiskSpaceView }> } | null)?.checks;
  if (!Array.isArray(checks)) return null;
  return checks.find((c) => c.id === 'disk')?.disk ?? null;
}

/** "Backups", "Backups and cache", "Backups, cache and database". */
export function pathsLabel(labels: string[]): string {
  const words = labels.map((l, i) => (i === 0 ? l : l.toLowerCase()));
  if (words.length <= 1) return words[0] ?? '';
  return `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;
}

/**
 * What the notice says, or null when there is nothing to say. Without the
 * numbers (they could not be fetched) it still says how the disk is.
 */
export function diskNoticeText(disk: DiskSpaceView | null | undefined, status?: 'ok' | 'warn' | 'error' | null): { tone: 'warning' | 'danger'; text: string } | null {
  if (!disk) {
    if (status === 'error') return { tone: 'danger', text: 'A disk is almost full. When it fills up the database stops; free space now.' };
    if (status === 'warn') return { tone: 'warning', text: 'A disk is filling up, or its free space could not be read.' };
    return null;
  }
  if (disk.status === 'pass') return null;
  const worst = disk.filesystems.find((f) => f.status === disk.status);
  if (!worst) return { tone: 'warning', text: 'The free space of this server’s disks could not be read.' };
  const what = `${pathsLabel(worst.paths.map((p) => p.label))}: ${Math.floor(worst.usedPct)}% used, ${formatBytes(worst.freeBytes)} free.`;
  return disk.status === 'fail'
    ? { tone: 'danger', text: `The disk is almost full. ${what} When it fills up the database stops; free space now.` }
    : { tone: 'warning', text: `The disk is filling up. ${what} Free space before the next update.` };
}

/** Whether this person sees the notice on this page: the owner, not on Storage itself. */
export function showDiskNotice(
  user: Pick<SessionUser, 'role'> | null | undefined,
  disk: DiskSpaceView | null | undefined,
  pathname: string,
  status?: 'ok' | 'warn' | 'error' | null,
): boolean {
  return canManageSystem(user) && !pathname.startsWith('/settings/storage') && diskNoticeText(disk, status) !== null;
}

export function DiskSpaceNoticeView({ disk, status, action }: { disk: DiskSpaceView | null | undefined; status?: 'ok' | 'warn' | 'error' | null; action: ReactNode }) {
  const notice = diskNoticeText(disk, status);
  if (!notice) return null;
  return (
    <div className={styles.region} role="status">
      <Banner tone={notice.tone}>{notice.text} {action}</Banner>
    </div>
  );
}

const FIVE_MINUTES = 5 * 60 * 1000;

/**
 * The disk status (public /health), and while it is not ok the numbers
 * (owner-only /system/checks). Nothing is fetched unless `enabled`.
 */
export function useDiskSpace(enabled: boolean) {
  const health = useQuery({
    queryKey: ['system', 'health', 'disk'],
    queryFn: async () => {
      try {
        return diskStatusFromHealth(await api.get<unknown>('/health'));
      } catch (err) {
        // 503 carries the same body while the database is down
        return diskStatusFromHealth(err);
      }
    },
    enabled,
    retry: false,
    staleTime: 60 * 1000,
    refetchInterval: FIVE_MINUTES,
  });
  const status = health.data ?? null;
  const detail = useQuery({
    queryKey: ['system', 'checks', 'disk', status],
    queryFn: async () => diskFromChecks(await api.get<unknown>('/system/checks')),
    enabled: enabled && (status === 'warn' || status === 'error'),
    retry: false,
    staleTime: 60 * 1000,
  });
  return { status, disk: status === 'warn' || status === 'error' ? detail.data ?? null : null, loading: detail.isLoading };
}

/** Mounted once in the app shell, above the page. */
export function DiskSpaceNotice() {
  const { data: user } = useMe();
  const { pathname } = useLocation();
  const { status, disk, loading } = useDiskSpace(canManageSystem(user));
  // wait for the numbers rather than flash the short text first
  if (loading || !showDiskNotice(user, disk, pathname, status)) return null;
  return (
    <DiskSpaceNoticeView
      disk={disk}
      status={status}
      action={<Link to="/settings/$section" params={{ section: 'storage' }}>Open Settings › Storage</Link>}
    />
  );
}
