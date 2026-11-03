/**
 * Library care › Getting (owner; the lidarr module): the albums asked of
 * Lidarr that tagave does not hold yet, newest first, each with its state
 * and Retry (Not found) or Cancel. Cancel unmonitors the album in Lidarr;
 * nothing is deleted there.
 */
import { Link } from '@tanstack/react-router';
import { useCurrentLibrary } from '../hooks';
import { useGetting, useLidarrCancel, useLidarrRetry } from '../hooks/useLidarr';
import { lidarrStateText } from '../components/LidarrControls';
import { Badge, Button, EmptyState, showToast, type BadgeTone } from '../components/ui';
import type { LidarrGettingItem } from '@tagave/shared';
import styles from './DeletingPage.module.css';

const shortDate = (iso: string) => new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });

const TONE: Record<LidarrGettingItem['state'], BadgeTone> = { wanted: 'neutral', downloading: 'info', imported: 'info', done: 'success', not_found: 'warning' };

const problem = (err: unknown, fallback: string) => {
  const e = err as { detail?: string; title?: string } | null;
  return e?.detail || e?.title || fallback;
};

export function GettingPanel() {
  const { libraryId } = useCurrentLibrary();
  const { data, isLoading, isError, refetch } = useGetting(libraryId);
  const retry = useLidarrRetry(libraryId);
  const cancel = useLidarrCancel(libraryId);

  if (isLoading) return <p className={styles.muted}>Loading…</p>;
  if (isError || !data) {
    return <p role="alert" className={styles.error}>Couldn’t load. <Button variant="quiet" size="sm" onClick={() => void refetch()}>Try again</Button></p>;
  }
  if (data.items.length === 0) {
    return <EmptyState title="Nothing getting" action={<Link to="/settings/$section" params={{ section: 'connections' }} className={styles.link}>Lidarr</Link>} />;
  }
  return (
    <div className={styles.container}>
      <section aria-labelledby="getting-list">
        <div className={styles.head}>
          <h2 id="getting-list" className={styles.heading}>Getting <span className={styles.count}>{data.items.length}</span></h2>
        </div>
        <ul className={styles.list}>
          {data.items.map((it) => (
            <li key={it.id} className={`${styles.row} ${styles.wrapRow}`}>
              <div className={styles.body}>
                <p className={styles.title}><span className={styles.album}>{it.title}</span></p>
                <p className={styles.meta}>
                  {it.artist && (it.artistId
                    ? <Link to="/artists/$artistId" params={{ artistId: it.artistId }} className={styles.link}>{it.artist}</Link>
                    : <span>{it.artist}</span>)}
                  <span>{shortDate(it.requestedAt)}</span>
                  {it.error && <span className={styles.error}>{it.error}</span>}
                </p>
              </div>
              <div className={styles.actions}>
                <Badge tone={TONE[it.state]}>{lidarrStateText(it)}</Badge>
                {it.state === 'not_found' && (
                  <Button variant="quiet" size="sm" disabled={retry.isPending} onClick={() => retry.mutate(it.id, { onError: (e) => showToast({ message: problem(e, 'Not sent to Lidarr'), tone: 'danger' }) })}>Retry</Button>
                )}
                <Button variant="quiet-danger" size="sm" disabled={cancel.isPending} onClick={() => cancel.mutate(it.id, { onError: (e) => showToast({ message: problem(e, 'Not cancelled'), tone: 'danger' }) })}>Cancel</Button>
              </div>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
