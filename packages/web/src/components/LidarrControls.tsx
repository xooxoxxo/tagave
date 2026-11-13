/**
 * Get missing albums through Lidarr on the artist page (the lidarr module):
 * a missing album's state as a chip on its cover (Wanted, Downloading 40%,
 * Importing, Not found), a Get from Lidarr button, and Retry and Cancel; the Missing
 * heading's ⋮ with Get all missing. Get, Retry and Cancel are the owner's;
 * everyone who sees the artist sees the states.
 */
import { createContext, useContext } from 'react';
import { LIDARR_STATE_LABELS, type ArtistLidarrView, type LidarrRequestView } from '@tagave/shared';
import { Button, CoverChip, KebabIcon, Menu, embossClassName, showToast, type MenuItem } from './ui';
import { useLidarrCancel, useLidarrGet, useLidarrGetAll, useLidarrRetry } from '../hooks/useLidarr';
import styles from './LidarrControls.module.css';

export interface MissingLidarrValue {
  view: ArtistLidarrView;
  libraryId: string | undefined;
  artistId: string | undefined;
}

/** The artist page's Lidarr view (null: the module is off or not set up). */
export const MissingLidarr = createContext<MissingLidarrValue | null>(null);

/** "Downloading 40%", "Wanted", … */
export function lidarrStateText(r: Pick<LidarrRequestView, 'state' | 'progress'>): string {
  const word = LIDARR_STATE_LABELS[r.state];
  return r.state === 'downloading' && r.progress !== null ? `${word} ${r.progress}%` : word;
}

export function LidarrChip({ releaseGroupId }: { releaseGroupId: string | null }) {
  const ctx = useContext(MissingLidarr);
  const r = releaseGroupId ? ctx?.view.requests[releaseGroupId] : undefined;
  if (!r || r.state === 'done') return null;
  return <CoverChip tone={r.state === 'not_found' ? 'warn' : r.state === 'wanted' ? 'neutral' : 'accent'}>{lidarrStateText(r)}</CoverChip>;
}

const problem = (err: unknown, fallback: string) => {
  const e = err as { detail?: string; title?: string } | null;
  return e?.detail || e?.title || fallback;
};

/** The items a missing album's ⋮ offers: Get, or Retry / Cancel for a request. */
export function missingAlbumItems(r: LidarrRequestView | undefined, gettable: boolean, act: { get: () => void; retry: (id: string) => void; cancel: (id: string) => void }): MenuItem[] {
  if (!r) return gettable ? [{ key: 'get', label: 'Get from Lidarr', onSelect: act.get }] : [];
  if (r.state === 'done') return [];
  return [
    ...(r.state === 'not_found' ? [{ key: 'retry', label: 'Retry', onSelect: () => act.retry(r.id) }] : []),
    { key: 'cancel', label: 'Cancel', tone: 'danger' as const, onSelect: () => act.cancel(r.id) },
  ];
}

export function MissingAlbumMenu({ releaseGroupId, title, placement = 'menu' }: { releaseGroupId: string | null; title: string; placement?: 'menu' | 'card' }) {
  const ctx = useContext(MissingLidarr);
  return ctx?.view.canGet && releaseGroupId ? <AlbumMenuOf ctx={ctx} releaseGroupId={releaseGroupId} title={title} placement={placement} /> : null;
}

function AlbumMenuOf({ ctx, releaseGroupId, title, placement }: { ctx: MissingLidarrValue; releaseGroupId: string; title: string; placement: 'menu' | 'card' }) {
  const get = useLidarrGet(ctx.libraryId);
  const retry = useLidarrRetry(ctx.libraryId);
  const cancel = useLidarrCancel(ctx.libraryId);
  const r = ctx.view.requests[releaseGroupId];
  const items = missingAlbumItems(r, ctx.view.gettable.includes(releaseGroupId), {
    get: () => get.mutate(releaseGroupId, { onError: (e) => showToast({ message: problem(e, 'Not sent to Lidarr'), tone: 'danger' }) }),
    retry: (id) => retry.mutate(id, { onError: (e) => showToast({ message: problem(e, 'Not sent to Lidarr'), tone: 'danger' }) }),
    cancel: (id) => cancel.mutate(id, { onError: (e) => showToast({ message: problem(e, 'Not cancelled'), tone: 'danger' }) }),
  });
  const getItem = items.find((item) => item.key === 'get');
  if (placement === 'card') {
    return getItem ? <Button variant="secondary" size="sm" className={styles.get}
      onClick={getItem.onSelect} loading={get.isPending} aria-label={`Get ${title} from Lidarr`}>{getItem.label}</Button> : null;
  }
  if (items.length === 0 || getItem) return null;
  return <Menu label={`More for ${title}`} items={items} className={styles.anchor ?? ''} triggerClassName={embossClassName('page', styles.more)} icon={<KebabIcon />} />;
}

/** The Missing heading's ⋮: Get all missing (one job; the owner's). */
export function MissingHeadingMenu() {
  const ctx = useContext(MissingLidarr);
  return ctx?.view.canGet ? <HeadingMenuOf ctx={ctx} /> : null;
}

function HeadingMenuOf({ ctx }: { ctx: MissingLidarrValue }) {
  const all = useLidarrGetAll(ctx.libraryId, ctx.artistId);
  const open = ctx.view.gettable.filter((id) => !ctx.view.requests[id] || ctx.view.requests[id]!.state === 'not_found');
  if (open.length === 0) return null;
  return (
    <Menu
      label="More for missing albums"
      className={styles.anchor ?? ''}
      triggerClassName={embossClassName('page', styles.more)}
      icon={<KebabIcon />}
      items={[{
        key: 'get-all',
        label: 'Get all missing',
        hint: String(open.length),
        onSelect: () => all.mutate(undefined, {
          onSuccess: () => showToast({ message: `${open.length} sent to Lidarr` }),
          onError: (e) => showToast({ message: problem(e, 'Not sent to Lidarr'), tone: 'danger' }),
        }),
      }]}
    />
  );
}
