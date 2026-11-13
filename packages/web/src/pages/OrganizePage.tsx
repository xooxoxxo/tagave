/**
 * Library care › Organize (owner, 0081): the albums whose folder or file
 * names differ from the naming rules (Settings › Library › Naming). Organize
 * queues one move per album, in batches of 50; each shows under Moved,
 * with its Undo.
 */
import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import type { OrganizeAlbum } from '@tagave/shared';
import { useCurrentLibrary } from '../hooks';
import { useOrganize, useRunOrganize } from '../hooks/useNaming';
import { Button, EmptyState, showToast } from '../components/ui';
import styles from './DeletingPage.module.css';
import own from './OrganizePage.module.css';

const songs = (n: number) => (n === 1 ? '1 song' : `${n} songs`);

function Group({ id, title, albums, selected, onToggle, onToggleAll }: {
  id: string;
  title: string;
  albums: OrganizeAlbum[];
  selected: Set<string>;
  onToggle: (albumId: string, on: boolean) => void;
  onToggleAll: (ids: string[], on: boolean) => void;
}) {
  if (albums.length === 0) return null;
  const ids = albums.map((a) => a.albumId);
  const all = ids.every((i) => selected.has(i));
  return (
    <section aria-labelledby={id}>
      <div className={styles.head}>
        <h2 id={id} className={styles.heading}>{title} <span className={styles.count}>{albums.length.toLocaleString()}</span></h2>
        <label className={`${own.selectAll} ${styles.headAction}`}>
          <input type="checkbox" checked={all} onChange={(e) => onToggleAll(ids, e.target.checked)} />
          All
        </label>
      </div>
      <ul className={styles.list}>
        {albums.map((a) => (
          <li key={a.albumId} className={styles.row} data-album={a.albumId}>
            <label className={own.check}>
              <input type="checkbox" aria-label={a.title} checked={selected.has(a.albumId)} onChange={(e) => onToggle(a.albumId, e.target.checked)} />
            </label>
            <div className={styles.body}>
              <p className={styles.title}>
                <Link to="/albums/$albumId" params={{ albumId: a.albumId }} className={styles.album}>{a.title}</Link>
              </p>
              <p className={styles.meta}>
                {a.artist && <span>{a.artist}</span>}
                <span>{songs(a.files)}</span>
                {a.renamed > 0 && <span>{a.renamed.toLocaleString()} renamed</span>}
              </p>
              {a.fromDir !== a.toDir && <p className={own.path}>{a.fromDir || '/'} → <span className={own.to}>{a.toDir}</span></p>}
              {a.sample && <p className={own.path}>{a.sample.from} → <span className={own.to}>{a.sample.to}</span></p>}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function OrganizePanel() {
  const { libraryId } = useCurrentLibrary();
  const { data, isLoading, isError, refetch } = useOrganize(libraryId);
  const run = useRunOrganize(libraryId);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  if (isLoading) return <p className={styles.muted}>Loading…</p>;
  if (isError || !data) {
    return <p role="alert" className={styles.error}>Couldn’t load. <Button variant="quiet" size="sm" onClick={() => void refetch()}>Try again</Button></p>;
  }

  const toggle = (id: string, on: boolean) => setSelected((prev) => {
    const next = new Set(prev);
    if (on) next.add(id); else next.delete(id);
    return next;
  });
  const toggleAll = (ids: string[], on: boolean) => setSelected((prev) => {
    const next = new Set(prev);
    for (const id of ids) { if (on) next.add(id); else next.delete(id); }
    return next;
  });
  // only albums still listed count (a refetch may drop organized ones)
  const listed = new Set([...data.wrongFolder, ...data.wrongNames].map((a) => a.albumId));
  const chosen = [...selected].filter((id) => listed.has(id));

  const organize = () => run.mutate(chosen, {
    onSuccess: ({ queued }) => {
      setSelected(new Set());
      showToast({ message: `${queued.toLocaleString()} queued` });
    },
    onError: (err) => showToast({ message: (err as { detail?: string })?.detail ?? 'Not organized. Try again.', tone: 'danger' }),
  });

  return (
    <div className={styles.container}>
      <div className={styles.head}>
        <dl className={own.values}>
          <div><dt>In place</dt><dd>{data.inPlace.toLocaleString()}</dd></div>
          <div><dt>Left alone</dt><dd>{data.leftAlone.toLocaleString()}</dd></div>
          {!data.saved && <div><dt>Rules</dt><dd><Link to="/settings/$section" params={{ section: 'library' }} className={styles.link}>Default rules</Link></dd></div>}
        </dl>
        <Button className={styles.headAction} onClick={organize} loading={run.isPending} disabled={chosen.length === 0 || run.isPending}>
          {chosen.length > 0 ? `Organize ${chosen.length.toLocaleString()}` : 'Organize'}
        </Button>
      </div>
      {data.wrongFolder.length === 0 && data.wrongNames.length === 0
        ? <EmptyState title="All in place" />
        : <>
          <Group id="organize-folder" title="Wrong folder" albums={data.wrongFolder} selected={selected} onToggle={toggle} onToggleAll={toggleAll} />
          <Group id="organize-names" title="Wrong names" albums={data.wrongNames} selected={selected} onToggle={toggle} onToggleAll={toggleAll} />
        </>}
    </div>
  );
}
