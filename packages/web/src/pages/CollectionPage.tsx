/**
 * Physical collection (spec COL-1, GAP-3): the records and CDs in the owner's
 * Discogs collection next to the albums on disk.
 *
 * One list of every record, plus Unmapped (records tagave cannot place yet:
 * a work queue) and Duplicates while any Discogs release is in the
 * collection twice. Each row is cover, artist – title (year), a marker per
 * medium (2×CD), a drive when the album is also on disk, and one primary
 * action; the rest sit in its "⋯" menu. The copies of one release are one
 * row ("2 copies"). Removing a record hides it with a few seconds of Undo,
 * then it is gone (collectionRemoval); there is no Removed list.
 * An unmapped record offers the albums it likely is ("This is Yellow & Green
 * by Baroness (2012, 18 tracks) — Link"), "Not in my library", and linking by
 * a pasted URL as the fallback.
 */
import { useEffect, useState } from 'react';
import {
  useCollectionSources,
  useCollection,
  useSyncCollection,
  useRemapCollection,
  useMapCollectionItem,
  useUnmapCollectionItem,
  useCollectionOptions,
  useAddCollectionItem,
  useCommitCollectionRemoval,
  useInvalidatePhysical,
  useRetryPush,
  useKeepBothCopies,
  useCurrentLibrary,
  useCollectionSuggestions,
  useLinkCollectionItem,
  isAlreadyOwned,
} from '../hooks';
import { useCan } from '../hooks/usePermissions';
import {
  Badge, Button, Collapse, CoverArt, EmptyState, LinkButton, Menu, OnDiskIcon, PageShell, Tabs, confirmDialog, showToast, type MenuItem,
} from '../components/ui';
import { WantlistSection } from '../components/WantlistSection';
import { shortDate } from '../utils/time';
import { groupCopies, mediaOf, type CopyGroup } from './collectionGroups';
import { scheduleRemoval, undoRemoval, useHiddenRemovals, UNDO_MS } from './collectionRemoval';
import styles from './CollectionPage.module.css';

type View = 'active' | 'unmapped' | 'duplicates';

const VIEWS: Array<{ key: View; label: string; count?: 'unmapped' | 'duplicates' }> = [
  { key: 'active', label: 'All' },
  { key: 'unmapped', label: 'Unmapped', count: 'unmapped' },
  { key: 'duplicates', label: 'Duplicates', count: 'duplicates' },
];

interface LocalAlbumRef {
  id: string;
  title: string | null;
  artist: string | null;
  year: number | null;
  trackCount: number | null;
  coverUrl: string | null;
}

interface CollectionItem {
  id: string;
  discogsReleaseId: number;
  folderName: string | null;
  rating?: number | null;
  mediaCondition?: string | null;
  sleeveCondition?: string | null;
  notes?: string | null;
  format: string | null;
  thumbUrl: string | null;
  mappingState: string;
  mappingSource?: string | null;
  releaseGroupId?: string | null;
  basicInfo: { title?: string; artists?: string[]; year?: number } | null;
  localAlbums: LocalAlbumRef[];
  localAlbumId?: string | null;
  discogsUrl: string;
  pushState?: string | null;
  pushError?: string | null;
  copies: number;
  extraCopy?: boolean;
  duplicateOf: string | null;
}

interface SourcesResponse {
  sources: Array<{
    id: string;
    username: string | null;
    status: string;
    lastSyncAt: string | null;
    counts: { total: number; mapped: number; unmapped: number; removed: number; physicalOnly?: number; both?: number; duplicates?: number };
  }>;
}

interface CollectionOptions {
  folders: Array<{ id: number; name: string }>;
  conditionGrades: string[];
}

/** "Very Good Plus (VG+)" → "VG+": the grade's short form, as on Discogs. */
const grade = (g: string | null | undefined) => (g ? g.match(/\(([^)]+)\)\s*$/)?.[1] ?? g : null);

const EMPTY_FORM = { input: '', folderId: 1, mediaCondition: '', sleeveCondition: '', notes: '', rating: 0 };

const detailOf = (err: unknown, fallback: string) => (err as { detail?: string } | null)?.detail ?? fallback;
const artistOf = (item: CollectionItem) => (item.basicInfo?.artists ?? []).map((a) => a.replace(/\s*\(\d+\)$/, '')).join(', ') || 'Unknown artist';
const titleOf = (item: CollectionItem) => item.basicInfo?.title ?? `Discogs release ${item.discogsReleaseId}`;

export function CollectionPage() {
  const { libraryId } = useCurrentLibrary();
  // keeping the collection is library care; a listener browses it
  const canCare = useCan('library.edit');
  const canConnect = useCan('system.manage');
  const [view, setView] = useState<View>('active');
  const [showAddForm, setShowAddForm] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [addError, setAddError] = useState<string | null>(null);

  const sources = useCollectionSources(libraryId);
  const collection = useCollection(libraryId, { view });
  const sync = useSyncCollection(libraryId);
  const remap = useRemapCollection(libraryId);
  const sourcesData = (sources.data as SourcesResponse) ?? { sources: [] };
  const source = sourcesData.sources[0];
  // The options endpoint answers 400 until a Discogs source exists: ask only once one does.
  const options = useCollectionOptions(libraryId, !!source && showAddForm);
  const addItem = useAddCollectionItem(libraryId);
  const hidden = useHiddenRemovals();

  const items = ((collection.data as { items?: CollectionItem[] } | undefined)?.items) ?? [];
  const optionsData = (options.data as CollectionOptions) ?? { folders: [], conditionGrades: [] };
  const counts: SourcesResponse['sources'][number]['counts'] = source?.counts ?? { total: 0, mapped: 0, unmapped: 0, removed: 0 };
  const groups = groupCopies(items, hidden);
  const duplicates = counts.duplicates ?? 0;

  // Poll while syncing or while any record is on its way to or from Discogs
  const busy = items.some((i) => i.pushState === 'pending' || i.pushState === 'removing');
  useEffect(() => {
    if (!source || (source.status !== 'syncing' && !busy)) return;
    const interval = setInterval(() => { void sources.refetch(); void collection.refetch(); }, 3000);
    return () => clearInterval(interval);
  }, [source?.status, busy, sources, collection]);

  // leave the Duplicates view once the last duplicate is gone
  useEffect(() => {
    if (view === 'duplicates' && sources.data && duplicates === 0) setView('active');
  }, [view, duplicates, sources.data]);

  const addRecord = async (anotherCopy = false) => {
    setAddError(null);
    try {
      const res = await addItem.mutateAsync({
        input: form.input,
        folderId: form.folderId,
        ...(form.mediaCondition ? { mediaCondition: form.mediaCondition } : {}),
        ...(form.sleeveCondition ? { sleeveCondition: form.sleeveCondition } : {}),
        ...(form.notes ? { notes: form.notes } : {}),
        ...(form.rating ? { rating: form.rating } : {}),
        ...(anotherCopy ? { anotherCopy: true } : {}),
      });
      setShowAddForm(false);
      setForm(EMPTY_FORM);
      showToast({ message: res.linkedExisting ? 'It was already in your collection: tagave linked that copy' : 'Added to your physical collection' });
    } catch (err) {
      if (isAlreadyOwned(err)) {
        const formats = [...new Set(err.existing.map((e) => e.format).filter(Boolean))].join(' and ');
        if (await confirmDialog({
          title: `You already have this${formats ? ` on ${formats}` : ''}. Add another copy?`,
          message: 'Each copy is its own item in your Discogs collection.',
          confirmLabel: 'Add another copy',
        })) await addRecord(true);
        return;
      }
      setAddError(detailOf(err, 'The record could not be added.'));
    }
  };

  const subtitle = source?.lastSyncAt
    ? <span className={styles.meta}>Synced {shortDate(source.lastSyncAt)}</span>
    : undefined;

  if (sources.isLoading) {
    return <PageShell title="Physical collection" subtitle={subtitle}><p className={styles.loading}>Loading…</p></PageShell>;
  }

  const visibleViews = VIEWS.filter((v) => v.key !== 'duplicates' || duplicates > 0 || view === 'duplicates');
  const current = VIEWS.find((v) => v.key === view)!;

  return (
    <PageShell
      title="Physical collection"
      subtitle={subtitle}
      actions={source && canCare && (
        <>
          {source.status === 'syncing' && <span className={styles.statusChip} role="status">Syncing…</span>}
          <Button variant="secondary" onClick={() => setShowAddForm(!showAddForm)} aria-expanded={showAddForm}>Add a record</Button>
          <Button variant="secondary" onClick={() => sync.mutate()} disabled={sync.isPending || source.status === 'syncing'}>Sync now</Button>
          <Menu label="More collection actions" items={[
            { key: 'remap', label: 'Re-run mapping', disabled: remap.isPending || source.status === 'syncing', onSelect: () => remap.mutate() },
          ]} />
        </>
      )}
    >
      {!source ? (
        <EmptyState
          title="No collection connected"
          action={canConnect ? <LinkButton to="/settings/providers">Connect Discogs</LinkButton> : undefined}
        />
      ) : (
        <>
          <Collapse open={showAddForm}>
            <form className={styles.addForm} onSubmit={(e) => { e.preventDefault(); void addRecord(); }}>
              <h2 className={styles.formTitle}>Add a record</h2>

              <label className={styles.formGroup}>
                <span>Discogs release URL or ID</span>
                <input type="text" required placeholder="https://www.discogs.com/release/12345 or 12345" value={form.input}
                  onChange={(e) => setForm({ ...form, input: e.target.value })} className={styles.formInput} />
              </label>
              <div className={styles.formRow}>
                <label className={styles.formGroup}>
                  <span>Folder</span>
                  <select value={form.folderId} onChange={(e) => setForm({ ...form, folderId: parseInt(e.target.value, 10) })} className={styles.formInput}>
                    {(optionsData.folders.length ? optionsData.folders : [{ id: 1, name: 'Uncategorized' }]).map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
                  </select>
                </label>
                <label className={styles.formGroup}>
                  <span>Media condition</span>
                  <select value={form.mediaCondition} onChange={(e) => setForm({ ...form, mediaCondition: e.target.value })} className={styles.formInput}>
                    <option value="">Not set</option>
                    {optionsData.conditionGrades.map((g) => <option key={g} value={g}>{g}</option>)}
                  </select>
                </label>
                <label className={styles.formGroup}>
                  <span>Sleeve condition</span>
                  <select value={form.sleeveCondition} onChange={(e) => setForm({ ...form, sleeveCondition: e.target.value })} className={styles.formInput}>
                    <option value="">Not set</option>
                    {optionsData.conditionGrades.map((g) => <option key={g} value={g}>{g}</option>)}
                  </select>
                </label>
              </div>
              <label className={styles.formGroup}>
                <span>Notes</span>
                <textarea rows={2} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} className={styles.formInput} />
              </label>
              {addError && <p className={styles.formError} role="alert">{addError}</p>}
              <div className={styles.formActions}>
                <Button type="submit" loading={addItem.isPending} disabled={!form.input.trim()}>Add record</Button>
                <Button variant="secondary" onClick={() => setShowAddForm(false)}>Cancel</Button>
              </div>
            </form>
          </Collapse>

          <div className={styles.viewHead}>
            <Tabs
              label="Collection views"
              value={view}
              onChange={(v) => setView(v as View)}
              panelId="collection-panel"
              items={visibleViews.map((v) => ({ value: v.key, label: v.label, ...(v.count && counts[v.count] ? { count: counts[v.count] } : {}) }))}
            />

          </div>

          <div id="collection-panel" role="tabpanel" aria-label={current.label}>
            {collection.isLoading && <p className={styles.loading}>Loading…</p>}
            {!collection.isLoading && groups.length === 0 && <p className={styles.empty}>Nothing here.</p>}
            <ul className={styles.list}>
              {groups.map((group) => <CollectionRow key={group.lead.id} group={group} view={view} libraryId={libraryId} />)}
            </ul>
          </div>

          <p className={styles.footer}>Data provided by <a href="https://www.discogs.com" target="_blank" rel="noopener noreferrer">Discogs</a>. tagave uses the Discogs API but is not affiliated with, sponsored or endorsed by Discogs. Discogs is a trademark of Zink Media, LLC.</p>
        </>
      )}
      <WantlistSection />
    </PageShell>
  );
}

function CollectionRow({ group, view, libraryId }: { group: CopyGroup<CollectionItem>; view: View; libraryId: string | undefined }) {
  const canCare = useCan('library.edit');
  const [linkOpen, setLinkOpen] = useState(false);
  const [linkInput, setLinkInput] = useState('');
  const [error, setError] = useState<string | null>(null);
  const { lead: item, copies, extras } = group;
  const unmapItem = useUnmapCollectionItem(libraryId);
  const mapItem = useMapCollectionItem(libraryId);
  const linkItem = useLinkCollectionItem(libraryId);
  const commitRemoval = useCommitCollectionRemoval(libraryId);
  const retryPush = useRetryPush(libraryId);
  const keepBoth = useKeepBothCopies(libraryId);
  const isUnmapped = view === 'unmapped';
  const suggestions = useCollectionSuggestions(item.id, isUnmapped);
  const title = titleOf(item);
  const artist = artistOf(item);
  const album = item.localAlbums[0];

  const link = async (body: { localAlbumId?: string; notInLibrary?: boolean }, done: string) => {
    setError(null);
    try {
      await linkItem.mutateAsync({ itemId: item.id, ...body });
      showToast({ message: done });
    } catch (err) {
      setError(detailOf(err, 'That did not work. Try again.'));
    }
  };
  const linkByInput = async () => {
    setError(null);
    try {
      await mapItem.mutateAsync({ itemId: item.id, input: linkInput });
      setLinkOpen(false);
      setLinkInput('');
      showToast({ message: `Linked ${title}` });
    } catch (err) {
      setError(detailOf(err, 'That address could not be linked.'));
    }
  };
  // Gone at once with a few seconds of Undo; only then is it removed (from
  // Discogs too). No confirmation: Undo is the way back.
  const remove = (target: CollectionItem, message: string) => {
    scheduleRemoval(
      target.id,
      (opts) => commitRemoval(target.id, opts),
      (err) => showToast({ message: `Could not remove ${title}: ${detailOf(err, 'the server did not answer')}`, tone: 'danger', durationMs: 10000 }),
    );
    showToast({ message, action: { label: 'Undo', onClick: () => void undoRemoval(target.id) }, durationMs: UNDO_MS });
  };

  const ownBoth = async () => {
    try {
      await keepBoth.mutateAsync(item.id);
      showToast({ message: `Kept both copies of ${title}` });
    } catch (err) {
      showToast({ message: `Could not keep both: ${detailOf(err, 'the server did not answer')}`, tone: 'danger', durationMs: 10000 });
    }
  };

  const discogsLink = <a className={styles.textLink} href={item.discogsUrl} target="_blank" rel="noopener noreferrer">Discogs ↗</a>;
  const failed = copies.find((c) => c.pushState === 'failed');

  // one primary action per row
  let primary: React.ReactNode = null;
  if (!canCare) primary = album ? <LinkButton size="sm" variant="secondary" to="/albums/$albumId" params={{ albumId: album.id }}>Open album</LinkButton> : discogsLink;
  else if (failed) primary = <Button size="sm" variant="secondary" loading={retryPush.isPending} onClick={() => retryPush.mutate(failed.id)}>Retry</Button>;
  else if (album) primary = <LinkButton size="sm" variant="secondary" to="/albums/$albumId" params={{ albumId: album.id }}>Open album</LinkButton>;
  else if (isUnmapped) primary = <Button size="sm" variant="secondary" loading={linkItem.isPending && !!linkItem.variables?.notInLibrary} onClick={() => void link({ notInLibrary: true }, `${title} stays unlinked`)}>Not in my library</Button>;
  else primary = discogsLink;

  // the newest copy goes first: an accidental extra, else the last one added
  const extra = extras[extras.length - 1];
  const newest = copies[copies.length - 1]!;
  const removal: MenuItem = extra
    ? { key: 'remove', label: 'Remove duplicate', tone: 'danger', separated: true, onSelect: () => remove(extra, 'Removed the duplicate') }
    : copies.length > 1
      ? { key: 'remove', label: 'Remove one copy', tone: 'danger', separated: true, onSelect: () => remove(newest, 'Removed a copy') }
      : { key: 'remove', label: 'Remove from collection', tone: 'danger', separated: true, onSelect: () => remove(item, `Removed ${title}`) };
  const menu: MenuItem[] = !canCare ? [{ key: 'discogs', label: 'Open on Discogs', href: item.discogsUrl }] : [
    ...(extra ? [{ key: 'keep-both', label: 'I own both', hint: 'Not a duplicate: keep every copy', disabled: keepBoth.isPending, onSelect: () => void ownBoth() }] : []),
    ...(isUnmapped ? [{ key: 'by-url', label: 'Link by URL or ID…', hint: 'Paste a MusicBrainz or Discogs address', onSelect: () => setLinkOpen(true) }] : []),
    { key: 'discogs', label: 'Open on Discogs', href: item.discogsUrl },
    ...(item.mappingState !== 'unmapped'
      ? [{ key: 'unlink', label: 'Unlink from album', hint: 'Back to Unmapped', disabled: unmapItem.isPending, onSelect: () => unmapItem.mutate(item.id) }] : []),
    removal,
  ];

  const facts = [
    item.folderName && item.folderName !== 'Uncategorized' ? item.folderName : null,
    item.mediaCondition || item.sleeveCondition ? [grade(item.mediaCondition), grade(item.sleeveCondition)].filter(Boolean).join('/') : null,
    item.rating ? '★'.repeat(item.rating) : null,
  ].filter(Boolean);
  const onDisk = album
    ? `On disk: ${album.title ?? 'album'}${item.localAlbums.length > 1 ? ` and ${item.localAlbums.length - 1} more` : ''}`
    : null;

  const list = suggestions.data?.suggestions ?? [];

  return (
    <li className={styles.row} data-collection-row="">
      <div className={styles.rowMain}>
        <CoverArt src={item.thumbUrl} title={title} compact className={styles.thumb} />
        <div className={styles.itemInfo}>
          <div className={styles.itemTitle}>
            <span className={styles.itemArtist}>{artist}</span> – {title}{item.basicInfo?.year ? <span className={styles.itemYear}> ({item.basicInfo.year})</span> : null}
          </div>
          <div className={styles.details}>
            {mediaOf(item.format).map((m) => <Badge key={m} size="sm">{m}</Badge>)}
            {onDisk && <span className={styles.onDisk} role="img" aria-label={onDisk} title={onDisk}><OnDiskIcon /></span>}
            {copies.length > 1 && <Badge size="sm" tone={extra ? 'warning' : 'neutral'}>{copies.length} copies</Badge>}
            {facts.length > 0 && <span>{facts.join(' · ')}</span>}
            {copies.some((c) => c.pushState === 'pending') && <span className={styles.status}>adding to Discogs…</span>}
            {failed && <span title={failed.pushError ?? undefined}><Badge size="sm" tone="danger">{failed.pushError?.startsWith('Removing') ? 'Removing from Discogs failed' : 'Adding to Discogs failed'}</Badge></span>}
          </div>

          {isUnmapped && (
            <div className={styles.suggestions}>
              {suggestions.isLoading && <p className={styles.suggestHint}>Looking for this album in your library…</p>}
              {!suggestions.isLoading && list.length === 0 && <p className={styles.suggestHint}>No match in your library</p>}
              {list.map((s, idx) => (
                <div key={s.id} className={styles.suggestion}>
                  <CoverArt src={s.coverUrl} title={s.title ?? ''} compact className={styles.suggestThumb} />
                  <span className={styles.suggestText}>
                    This is <strong>{s.title}</strong>{s.artist ? <> by {s.artist}</> : null}
                    {(s.year || s.trackCount) ? <span className={styles.itemYear}> ({[s.year, s.trackCount ? `${s.trackCount} ${s.trackCount === 1 ? 'track' : 'tracks'}` : null].filter(Boolean).join(', ')})</span> : null}
                    {s.sameDiscogsRelease && <span className={styles.suggestWhy}> · same Discogs release</span>}
                  </span>
                  <Button size="sm" variant={idx === 0 ? 'primary' : 'secondary'} loading={linkItem.isPending && linkItem.variables?.localAlbumId === s.id}
                    disabled={linkItem.isPending} onClick={() => void link({ localAlbumId: s.id }, `Linked to ${s.title}`)}>Link</Button>
                </div>
              ))}
            </div>
          )}

          <Collapse open={linkOpen}>
            <form className={styles.linkForm} onSubmit={(e) => { e.preventDefault(); void linkByInput(); }}>
              <input type="text" aria-label="MusicBrainz or Discogs URL or ID" placeholder="Paste a MusicBrainz or Discogs URL / ID" value={linkInput}
                onChange={(e) => setLinkInput(e.target.value)} className={styles.formInput} />
              <Button size="sm" type="submit" loading={mapItem.isPending} disabled={!linkInput.trim()}>Link</Button>
              <Button size="sm" variant="quiet" onClick={() => { setLinkOpen(false); setLinkInput(''); }}>Cancel</Button>
            </form>
          </Collapse>
          {error && <p className={styles.formError} role="alert">{error}</p>}
        </div>
      </div>
      <div className={styles.rowActions}>
        {primary}
        <Menu label={`More for ${title}`} items={menu} />
      </div>
    </li>
  );
}
