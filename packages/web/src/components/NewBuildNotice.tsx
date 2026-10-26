/**
 * "tagave was updated." with a Reload button: the server runs a newer build
 * than this tab (services/buildCheck.ts). A small glass note in the corner;
 * it never reloads by itself, so nothing typed into a form is lost unless
 * the person chooses to reload. Dismissed, it stays away for that build in
 * this tab.
 */
import { useEffect, useState } from 'react';
import { Button, IconButton } from './ui';
import { CloseIcon } from './ui/icons';
import { startBuildWatch, useNewBuild } from '../services/buildCheck';
import { onJobStreamReconnect } from '../services/jobStream';
import styles from './NewBuildNotice.module.css';

export interface NewBuildNoticeViewProps {
  onReload: () => void;
  onDismiss: () => void;
}

/** The note itself, without the watching (stories, tests). */
export function NewBuildNoticeView({ onReload, onDismiss }: NewBuildNoticeViewProps) {
  return (
    <div className={styles.region} role="status" aria-live="polite">
      <div className={styles.notice}>
        <span className={styles.message}>tagave was updated.</span>
        <Button size="sm" variant="secondary" onClick={onReload}>Reload</Button>
        <IconButton variant="quiet" size="sm" label="Dismiss" className={styles.close} onClick={onDismiss}><CloseIcon /></IconButton>
      </div>
    </div>
  );
}

/** Mounted once at the root, next to the toast host. */
export function NewBuildNotice() {
  const build = useNewBuild();
  const [dismissed, setDismissed] = useState<string | null>(null);
  useEffect(() => startBuildWatch(onJobStreamReconnect), []);
  const shown = !!build && build.sha !== dismissed;
  // a toast moves up while the note holds the foot of the screen
  useEffect(() => {
    const root = globalThis.document?.documentElement;
    if (!root || !shown) return;
    root.dataset['newBuild'] = '';
    return () => { delete root.dataset['newBuild']; };
  }, [shown]);
  if (!shown) return null;
  return <NewBuildNoticeView onReload={() => globalThis.location.reload()} onDismiss={() => setDismissed(build.sha)} />;
}
