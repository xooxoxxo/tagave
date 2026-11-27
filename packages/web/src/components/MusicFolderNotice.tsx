/**
 * "Music folder offline since 14:02 · Music folders": a quiet Banner across
 * the top of every page for the owner while the folder watch cannot reach a
 * music folder, with a link to Settings › Library. "not connected" when the
 * folder is not mounted at all, "2 music folders offline" for several.
 * 2026-11 the NAS share behind a scan root did not mount after a reboot; the
 * scan guard (LIB-5, worker › jobs/scanRoot.ts) refused to mark anything
 * missing, but nothing in the app said so for hours.
 *
 * GET /system/music-folder (MusicFolderResponse in @tagave/shared) answers
 * from the same state the updater's self-heal reads (db › musicFolder.ts):
 * "Reconnecting music folder" while the updater mounts it again and its
 * rescan runs, the folders while they stay offline, nothing once they are
 * back. An API older than 0097 answers `unreachable` with paths only, which
 * reads as it did then. Read every five minutes and when the tab comes back;
 * only people who can manage the system ever ask.
 */
import type { ReactNode } from 'react';
import { Link, useLocation } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { can, type MusicFolderResponse, type SessionUser } from '@tagave/shared';
import { Banner } from './ui';
import { useMe } from '../hooks';
import { api } from '../services/api';
import { sinceLabel } from '../utils/time';
import styles from './DiskSpaceNotice.module.css';

/** Whether this person sees the notice on this page: the owner, not on Settings › Library (it shows the same). */
export function showMusicFolderNotice(user: Pick<SessionUser, 'role'> | null | undefined, state: MusicFolderResponse | null | undefined, pathname: string): boolean {
  return can(user?.role, 'system.manage') && !!state && state.kind !== 'none' && !pathname.startsWith('/settings/library');
}

/** The banner's words (spec §7), without the link; null with nothing to say. */
export function noticeText(state: MusicFolderResponse, now: Date = new Date()): string | null {
  if (state.kind === 'none') return null;
  if (state.kind === 'healing') return 'Reconnecting music folder';
  const folders = state.folders ?? [];
  if (folders.length > 1) return `${folders.length} music folders offline`;
  const [folder] = folders;
  if (folder) {
    const label = folder.reach === 'unmounted' ? 'Music folder not connected' : 'Music folder offline';
    // no reading recorded yet: no time to give
    return folder.since ? `${label} since ${sinceLabel(folder.since, now)}` : label;
  }
  // an API older than 0097: paths only
  const paths = state.paths ?? [];
  if (paths.length === 0) return 'Music folder offline';
  return `${paths.length === 1 ? 'Music folder unreachable' : 'Music folders unreachable'} · ${paths.join(', ')}`;
}

export function MusicFolderNoticeView({ state, action, now }: { state: MusicFolderResponse; action: ReactNode; now?: Date }) {
  const text = noticeText(state, now);
  if (text === null) return null;
  return (
    <div className={styles.region} role="status">
      {state.kind === 'healing'
        ? <Banner tone="info">{text}</Banner>
        : <Banner tone="warning">{text} · {action}</Banner>}
    </div>
  );
}

const FIVE_MINUTES = 5 * 60 * 1000;

/** Mounted once in the app shell, above the page. */
export function MusicFolderNotice() {
  const { data: user } = useMe();
  const { pathname } = useLocation();
  const owner = can(user?.role, 'system.manage');
  const state = useQuery({
    queryKey: ['system', 'music-folder'],
    queryFn: () => api.get<MusicFolderResponse>('/system/music-folder'),
    enabled: owner,
    retry: false,
    staleTime: 60 * 1000,
    // while it reconnects, look again sooner
    refetchInterval: (q) => ((q.state.data as MusicFolderResponse | undefined)?.kind === 'healing' ? 30 * 1000 : FIVE_MINUTES),
    refetchOnWindowFocus: true,
  });
  if (!state.data || !showMusicFolderNotice(user, state.data, pathname)) return null;
  return <MusicFolderNoticeView state={state.data} action={<Link to="/settings/library">Music folders</Link>} />;
}
