/**
 * "Music folder unreachable · /mnt/music": a quiet Banner across the top of
 * every page for the owner while the latest scan of a music folder was
 * aborted, with a link to Settings › Music folders. 2026-11 the NAS share
 * behind a scan root did not mount after a reboot; the scan guard (LIB-5,
 * worker › jobs/scanRoot.ts) refused to mark anything missing, but nothing
 * in the app said so for hours.
 *
 * GET /system/music-folder answers from the same state the updater's
 * self-heal reads (db › musicFolder.ts): "Reconnecting music folder" while
 * the updater mounts it again and its rescan runs, the folders while they
 * stay unreachable or the heal failed, nothing once a scan finishes. Read
 * every five minutes and when the tab comes back; only people who can
 * manage the system ever ask.
 */
import type { ReactNode } from 'react';
import { Link, useLocation } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { can, type SessionUser } from '@tagave/shared';
import { Banner } from './ui';
import { useMe } from '../hooks';
import { api } from '../services/api';
import styles from './DiskSpaceNotice.module.css';

export type MusicFolderNoticeState = { kind: 'none' } | { kind: 'healing' } | { kind: 'unreachable'; paths: string[] };

/** Whether this person sees the notice on this page: the owner, not on Settings › Music folders (it shows the same). */
export function showMusicFolderNotice(user: Pick<SessionUser, 'role'> | null | undefined, state: MusicFolderNoticeState | null | undefined, pathname: string): boolean {
  return can(user?.role, 'system.manage') && !!state && state.kind !== 'none' && !pathname.startsWith('/settings/library');
}

export function MusicFolderNoticeView({ state, action }: { state: MusicFolderNoticeState; action: ReactNode }) {
  if (state.kind === 'none') return null;
  return (
    <div className={styles.region} role="status">
      {state.kind === 'healing'
        ? <Banner tone="info">Reconnecting music folder</Banner>
        : <Banner tone="warning">{state.paths.length === 1 ? 'Music folder unreachable' : 'Music folders unreachable'} · {state.paths.join(', ')} · {action}</Banner>}
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
    queryFn: () => api.get<MusicFolderNoticeState>('/system/music-folder'),
    enabled: owner,
    retry: false,
    staleTime: 60 * 1000,
    // while it reconnects, look again sooner
    refetchInterval: (q) => ((q.state.data as MusicFolderNoticeState | undefined)?.kind === 'healing' ? 30 * 1000 : FIVE_MINUTES),
    refetchOnWindowFocus: true,
  });
  if (!state.data || !showMusicFolderNotice(user, state.data, pathname)) return null;
  return <MusicFolderNoticeView state={state.data} action={<Link to="/settings/library">Music folders</Link>} />;
}
