/**
 * What everyone sees while the app is down for an update (services/appDown):
 * the page is still loaded, so this is a screen over it, not a navigation.
 * The player keeps its row above it and plays what it has loaded (the
 * current track, and the next one once it is within 30 s of its turn). The
 * screen lifts when the app answers again; a newer build is switched to at
 * the next moment nothing plays, never in the middle of a track.
 *
 * Not on Settings › Updates: the owner follows the run there.
 */
import { useEffect } from 'react';
import { useLocation } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import { noticeTrouble, useAppDown } from '../../services/appDown';
import { onJobStreamDrop } from '../../services/jobStream';
import { reloadWhenQuiet } from '../../services/quietReload';
import { updaterKey, type SeenUpdaterView } from '../../hooks/useUpdater';
import { useNow } from '../InAppUpdate';
import { UpdateGlyph } from './UpdateGlyph';
import { runProgress } from './glyphPaint';
import styles from './UpdateDownScreen.module.css';

export function UpdateDownScreen({ seed, version, progress, time }: { seed: string; version?: string | null | undefined; progress: number; time?: number | undefined }) {
  return (
    <div className={styles.down} role="status" aria-live="polite" data-update-down="">
      <UpdateGlyph className={styles.glyph} seed={seed} progress={progress} time={time} strength={1.35} />
      <div className={styles.text}>
        <p className={styles.title}>Updating</p>
        {version && <p className={styles.version}>{version}</p>}
      </div>
    </div>
  );
}

/** How far a down screen's glyph has grown when the run is not known here: with the time down, over a minute. */
export const downProgress = (downForMs: number) => 0.45 + 0.4 * Math.min(1, Math.max(0, downForMs) / 60_000);

/** Mounted once in Layout. */
export function AppDownHost() {
  const { down, since, switchPending } = useAppDown();
  const { pathname } = useLocation();
  const queryClient = useQueryClient();
  const now = useNow(down);

  useEffect(() => onJobStreamDrop(() => { void noticeTrouble(); }), []);

  // the player's row stays above the screen
  useEffect(() => {
    const root = globalThis.document?.documentElement;
    if (!root) return;
    if (down) root.setAttribute('data-app-down', '');
    else root.removeAttribute('data-app-down');
    return () => root.removeAttribute('data-app-down');
  }, [down]);

  // into the new build once nothing plays: now, or at the next pause, stop or end of the queue
  useEffect(() => (switchPending && !down ? reloadWhenQuiet() : undefined), [switchPending, down]);

  if (!down || pathname.startsWith('/settings/updates')) return null;
  // the owner's tab knows the run; everyone else only that the app is away
  const run = queryClient.getQueryData<SeenUpdaterView>(updaterKey)?.updater?.run;
  const known = run?.status === 'running' ? run : null;
  return (
    <UpdateDownScreen
      seed={known?.target ?? 'tagave'}
      version={known?.target}
      progress={known ? runProgress(known, now) : downProgress(now - (since ?? now))}
    />
  );
}
