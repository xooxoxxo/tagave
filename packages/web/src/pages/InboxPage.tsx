/**
 * Library care › Inbox (owner, 0081): albums dropped in the drop pool that
 * were not imported on their own: unsure or no match, already in the
 * library, failed or undone. Accept imports the best match, Pick release…
 * another one (a candidate, or a MusicBrainz release URL or MBID); for an
 * album already in the library, Replace or Keep both. The list looks again
 * every 5 s while the worker is on a row.
 */
import { useState, type FormEvent } from 'react';
import { Link } from '@tanstack/react-router';
import type { InboxAction, InboxItem, PoolCandidate } from '@tagave/shared';
import { useCurrentLibrary } from '../hooks';
import { releaseMbidOf, useInbox, useInboxAction } from '../hooks/useNaming';
import { Button, EmptyState, Input, showToast } from '../components/ui';
import styles from './DeletingPage.module.css';
import own from './OrganizePage.module.css';

const REASON: Record<NonNullable<InboxItem['reason']>, string> = {
  unsure: 'Unsure',
  unidentified: 'Unidentified',
  in_library: 'Already in library',
  failed: 'Failed',
  undone: 'Undone',
};

const STATE: Record<InboxItem['state'], string> = {
  waiting: 'Waiting',
  identifying: 'Identifying',
  inbox: 'Inbox',
  importing: 'Importing',
  imported: 'Imported',
  skipped: 'Skipped',
};

export function inboxLabel(item: Pick<InboxItem, 'state' | 'reason'>): string {
  return item.state === 'inbox' && item.reason ? REASON[item.reason] : STATE[item.state];
}

const releaseText = (c: PoolCandidate) => [c.title, c.artist, c.year ? String(c.year) : null].filter(Boolean).join(' · ');

function Pairing({ item }: { item: InboxItem }) {
  return (
    <div className={own.pairing}>
      {item.pairing.map((p) => (
        <PairRow key={p.relPath} p={p} />
      ))}
    </div>
  );
}

function PairRow({ p }: { p: InboxItem['pairing'][number] }) {
  const pos = p.position !== null ? `${p.disc !== null ? `${p.disc}-` : ''}${p.position}` : null;
  return <>
    <span className={own.file}>{p.relPath.split('/').pop()}</span>
    <span>{pos ? `${pos} ${p.title ?? ''}` : '—'}</span>
    <span className={`${own.pct} ${p.confidence !== null && p.confidence < 60 ? own.low : ''}`}>{p.confidence !== null ? `${p.confidence}%` : '—'}</span>
  </>;
}

function PickRelease({ item, busy, onPick }: { item: InboxItem; busy: boolean; onPick: (mbid: string) => void }) {
  const [text, setText] = useState('');
  const mbid = releaseMbidOf(text);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (mbid) onPick(mbid);
  };
  return (
    <div className={own.pick}>
      {item.candidates.filter((c) => c.mbid).map((c) => (
        <div key={c.releaseId}>
          <Button variant="quiet" size="sm" disabled={busy} onClick={() => onPick(c.mbid!)}>
            {releaseText(c)} · {c.percent}%
          </Button>
        </div>
      ))}
      <form className={own.pickForm} onSubmit={submit}>
        <Input dense aria-label="MusicBrainz release" placeholder="MusicBrainz URL or MBID" value={text} spellCheck={false} autoComplete="off" onChange={(e) => setText(e.target.value)} />
        <Button type="submit" variant="secondary" size="sm" disabled={!mbid || busy}>Pick</Button>
      </form>
    </div>
  );
}

function InboxRow({ item, busy, act }: { item: InboxItem; busy: boolean; act: (action: InboxAction) => void }) {
  const [tracks, setTracks] = useState(false);
  const [picking, setPicking] = useState(false);
  const decide = item.state === 'inbox' || item.state === 'skipped';
  const inLibrary = item.reason === 'in_library';
  return (
    <li className={`${styles.row} ${styles.wrapRow} ${own.inboxRow}`} data-item={item.id}>
      <div className={styles.body}>
        <p className={styles.title} title={item.folder}>{item.folder}</p>
        <p className={styles.meta}>
          <span><span className={`${own.label} ${item.reason === 'failed' ? own.labelWarn : ''}`}>{inboxLabel(item)}</span></span>
          <span>{item.files === 1 ? '1 song' : `${item.files} songs`}</span>
          {item.best && <span>{releaseText(item.best)} · {item.best.percent}%</span>}
        </p>
        {inLibrary && item.existing && (
          <p className={styles.meta}>
            <span><Link to="/albums/$albumId" params={{ albumId: item.existing.albumId }} className={styles.link}>{item.existing.title}</Link></span>
            {item.existing.artist && <span>{item.existing.artist}</span>}
          </p>
        )}
        {item.toDir && <p className={own.path}>→ <span className={own.to}>{item.toDir}</span></p>}
        {item.error && <p className={styles.error}>{item.error}</p>}
        {tracks && item.pairing.length > 0 && <Pairing item={item} />}
        {picking && <PickRelease item={item} busy={busy} onPick={(releaseMbid) => act({ action: 'pick', releaseMbid })} />}
      </div>
      <div className={`${styles.actions} ${own.wrapActions}`}>
        {item.pairing.length > 0 && (
          <Button variant="quiet" size="sm" aria-expanded={tracks} onClick={() => setTracks((v) => !v)}>Tracks</Button>
        )}
        {decide && inLibrary && <>
          <Button variant="secondary" size="sm" disabled={busy} onClick={() => act({ action: 'replace' })}>Replace</Button>
          <Button variant="secondary" size="sm" disabled={busy} onClick={() => act({ action: 'keepBoth' })}>Keep both</Button>
        </>}
        {decide && !inLibrary && <>
          {item.best && <Button variant="secondary" size="sm" disabled={busy} onClick={() => act({ action: 'accept' })}>Accept</Button>}
          <Button variant="quiet" size="sm" aria-expanded={picking} onClick={() => setPicking((v) => !v)}>Pick release…</Button>
        </>}
        {(item.state === 'inbox' || item.state === 'waiting') && (
          <Button variant="quiet" size="sm" disabled={busy} onClick={() => act({ action: 'skip' })}>Skip</Button>
        )}
      </div>
    </li>
  );
}

export function InboxPanel() {
  const { libraryId } = useCurrentLibrary();
  const { data, isLoading, isError, refetch } = useInbox(libraryId);
  const action = useInboxAction(libraryId);

  if (isLoading) return <p className={styles.muted}>Loading…</p>;
  if (isError || !data) {
    return <p role="alert" className={styles.error}>Couldn’t load. <Button variant="quiet" size="sm" onClick={() => void refetch()}>Try again</Button></p>;
  }
  if (data.items.length === 0) return <EmptyState title="Inbox empty" />;
  const waiting = data.items.filter((i) => i.state === 'inbox').length;
  return (
    <div className={styles.container}>
      <section aria-labelledby="inbox-list">
        <div className={styles.head}>
          <h2 id="inbox-list" className={styles.heading}>Inbox <span className={styles.count}>{waiting.toLocaleString()}</span></h2>
        </div>
        <ul className={styles.list}>
          {data.items.map((item) => (
            <InboxRow
              key={item.id}
              item={item}
              busy={action.isPending && action.variables?.itemId === item.id}
              act={(a) => action.mutate({ itemId: item.id, action: a }, {
                onError: (err) => showToast({ message: (err as { detail?: string })?.detail ?? 'Not done. Try again.', tone: 'danger' }),
              })}
            />
          ))}
        </ul>
      </section>
    </div>
  );
}
