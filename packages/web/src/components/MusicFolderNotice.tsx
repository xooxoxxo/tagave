/**
 * "Music folder unreachable · /mnt/music": a quiet Banner across the top of
 * every page for the owner while the latest scan of a music folder was
 * aborted, with a link to Settings › Music folders. 2026-11 the NAS share
 * behind a scan root did not mount after a reboot; the scan guard (LIB-5,
 * worker › jobs/scanRoot.ts) refused to mark anything missing, but nothing
 * in the app said so for hours.
 *
 * The worker stamps scan_roots.last_status 'aborted' when a scan stops
 * before reading anything: the folder looks unmounted (no files where the
 * index has some) or is missing or unreadable. The next scan that finishes
 * stamps 'completed', and the notice goes. It reads the music folders
 * (GET /libraries/:id/scan-roots) every five minutes and when the tab comes
 * back; only people who can manage the system ever ask.
 */
import type { ReactNode } from 'react';
import { Link, useLocation } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { can, type SessionUser } from '@tagave/shared';
import type { ScanRootWithStatus } from '../types';
import { Banner } from './ui';
import { useCurrentLibrary, useMe } from '../hooks';
import { fetchScanRoots, scanRootsKey } from '../hooks/useLibrary';
import styles from './DiskSpaceNotice.module.css';

/** The enabled folders whose latest scan was aborted: nothing was read from them. */
export function unreachableRoots(roots: Pick<ScanRootWithStatus, 'path' | 'enabled' | 'lastStatus'>[] | null | undefined): string[] {
  return (roots ?? []).filter((r) => r.enabled && r.lastStatus === 'aborted').map((r) => r.path);
}

/** Whether this person sees the notice on this page: the owner, not on Settings › Music folders (it shows the same). */
export function showMusicFolderNotice(user: Pick<SessionUser, 'role'> | null | undefined, paths: string[], pathname: string): boolean {
  return can(user?.role, 'system.manage') && paths.length > 0 && !pathname.startsWith('/settings/library');
}

export function MusicFolderNoticeView({ paths, action }: { paths: string[]; action: ReactNode }) {
  if (paths.length === 0) return null;
  return (
    <div className={styles.region} role="status">
      <Banner tone="warning">{paths.length === 1 ? 'Music folder unreachable' : 'Music folders unreachable'} · {paths.join(', ')} · {action}</Banner>
    </div>
  );
}

const FIVE_MINUTES = 5 * 60 * 1000;

/** Mounted once in the app shell, above the page. */
export function MusicFolderNotice() {
  const { data: user } = useMe();
  const { pathname } = useLocation();
  const { libraryId } = useCurrentLibrary();
  const owner = can(user?.role, 'system.manage');
  // the same cache as Settings › Music folders, refreshed now and then
  const roots = useQuery({
    queryKey: scanRootsKey(libraryId),
    queryFn: () => fetchScanRoots(libraryId!),
    enabled: owner && !!libraryId,
    retry: false,
    staleTime: 60 * 1000,
    refetchInterval: FIVE_MINUTES,
    refetchOnWindowFocus: true,
  });
  const paths = unreachableRoots(roots.data);
  if (!showMusicFolderNotice(user, paths, pathname)) return null;
  return <MusicFolderNoticeView paths={paths} action={<Link to="/settings/library">Music folders</Link>} />;
}
