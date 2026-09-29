/**
 * Physical collection (spec COL-1, GAP-3): the records and CDs in the owner's
 * Discogs collection next to the albums on disk.
 *
 * Views: Physical only · Both · Unmapped · Removed, plus Duplicates while any
 * Discogs release is in the collection twice. Each row is cover, artist –
 * title (year), format, and one primary action; the rest sit in its "⋯" menu.
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
  useRemoveCollectionItem,
  useRetryPush,
  useKeepBothCopies,
  useCurrentLibrary,
  useCollectionSuggestions,
  useLinkCollectionItem,
  isAlreadyOwned,
} from '../hooks';
import {
  Banner, Button, Collapse, CoverArt, EmptyState, LinkButton, Menu, PageShell, Tabs, confirmDialog, showToast, updateToast, type MenuItem,
} from '../components/ui';
import styles from './CollectionPage.module.css';

type View = 'physical_only' | 'both' | 'unmapped' | 'removed' | 'duplicates';

const VIEWS: Array<{ key: View; label: string; count: 'physicalOnly' | 'both' | 'unmapped' | 'removed' | 'duplicates'; help: string }> = [
  { key: 'physical_only', label: 'Physical only', count: 'physicalOnly', help: 'Records you own that are not on disk. Good candidates to rip or buy digitally.' },
  { key: 'both', label: 'Both', count: 'both', help: 'Records you own that are also in your library on disk.' },
  { key: 'unmapped', label: 'Unmapped', count: 'unmapped', help: 'tagave doesn’t know which album in your library these records are. Pick the match, or say the record isn’t in your library.' },
  { key: 'removed', label: 'Removed', count: 'removed', help: 'Records that were in your Discogs collection and are gone now.' },
  { key: 'duplicates', label: 'Duplicates', count: 'duplicates', help: 'The same Discogs release is in your collection more than once. Remove the extra copy, or say you own both.' },
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

const EMPTY_FORM = { input: '', folderId: 1, mediaCondition: '', sleeveCondition: '', notes: '', rating: 0 };

const detailOf = (err: unknown, fallback: string) => (err as { detail?: string } | null)?.detail ?? fallback;
const artistOf = (item: CollectionItem) => (item.basicInfo?.artists ?? []).map((a) => a.replace(/\s*\(\d+\)$/, '')).join(', ') || 'Unknown artist';
const titleOf = (item: CollectionItem) => item.basicInfo?.title ?? `Discogs release ${item.discogsReleaseId}`;

export function CollectionPage() {
  const { libraryId } = useCurrentLibrary();
  const [view, setView] = useState<View>('physical_only');
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

  const items = ((collection.data as { items?: CollectionItem[] } | undefined)?.items) ?? [];
  const optionsData = (options.data as CollectionOptions) ?? { folders: [], conditionGrades: [] };
  const counts = source?.counts ?? { total: 0, mapped: 0, unmapped: 0, removed: 0 };
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
    if (view === 'duplicates' && sources.data && duplicates === 0) setView('physical_only');
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
          message: 'Add another copy only if you really own two. Each copy is its own item in your Discogs collection.',
          confirmLabel: 'Add another copy',
        })) await addRecord(true);
        return;
      }
      setAddError(detailOf(err, 'The record could not be added.'));
    }
  };

  const subtitle = source
    ? <>The records and CDs in {source.username ? `${source.username}’s` : 'your'} Discogs collection, next to the albums on disk.{source.lastSyncAt && <span className={styles.meta}> Last synced {new Date(source.lastSyncAt).toLocaleString()}.</span>}</>
    : 'The records and CDs on your shelf, next to the albums on disk.';

  if (sources.isLoading) {
    return <PageShell title="Physical collection" subtitle={subtitle}><p className={styles.loading}>Loading…</p></PageShell>;
  }

  const visibleViews = VIEWS.filter((v) => v.key !== 'duplicates' || duplicates > 0 || view === 'duplicates');
  const current = VIEWS.find((v) => v.key === view)!;

  return (
    <PageShell
      title="Physical collection"
      subtitle={subtitle}
      actions={source && (
        <>
          {source.status === 'syncing' && <span className={styles.statusChip} role="status">Syncing…</span>}
          <Button variant="secondary" onClick={() => setShowAddForm(!showAddForm)} aria-expanded={showAddForm}>Add a record</Button>
          <Button variant="secondary" onClick={() => sync.mutate()} disabled={sync.isPending || source.status === 'syncing'}>Sync now</Button>
          <Menu label="More collection actions" items={[
            { key: 'remap', label: 'Re-run mapping', hint: 'Match unmapped records to albums again', disabled: remap.isPending || source.status === 'syncing', onSelect: () => remap.mutate() },
          ]} />
        </>
      )}
    >
      {!source ? (
        <EmptyState
          title="No collection connected yet"
          text="Connect your Discogs account and tagave lists the vinyl and CDs you own, shows which of them are also on disk, and which are only on the shelf."
          action={<LinkButton to="/settings/providers">Connect Discogs</LinkButton>}
        />
      ) : (
        <>
          <Collapse open={showAddForm}>
            <form className={styles.addForm} onSubmit={(e) => { e.preventDefault(); void addRecord(); }}>
              <h2 className={styles.formTitle}>Add a record</h2>
              <p className={styles.formHint}>To add an album you already have on disk, open it and choose “I own this on vinyl/CD”: tagave links it for you.</p>
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

          {duplicates > 0 && view !== 'duplicates' && (
            <Banner tone="warning">
              <span className={styles.bannerLine}>
                {duplicates === 1 ? 'One record is' : `${duplicates} records are`} in your collection twice.
                <Button size="sm" variant="secondary" onClick={() => setView('duplicates')}>Review duplicates</Button>
              </span>
            </Banner>
          )}

          <div className={styles.viewHead}>
            <Tabs
              label="Collection views"
              value={view}
              onChange={(v) => setView(v as View)}
              panelId="collection-panel"
              items={visibleViews.map((v) => ({ value: v.key, label: v.label, ...(counts[v.count] ? { count: counts[v.count] } : {}) }))}
            />
            <p className={styles.viewHelp}>{current.help}</p>
          </div>

          <div id="collection-panel" role="tabpanel" aria-label={current.label}>
            {collection.isLoading && <p className={styles.loading}>Loading…</p>}
            {!collection.isLoading && items.length === 0 && <p className={styles.empty}>Nothing here.</p>}
            <ul className={styles.list}>
              {items.map((item) => <CollectionRow key={item.id} item={item} view={view} libraryId={libraryId} />)}
            </ul>
          </div>

          <p className={styles.footer}>Data provided by <a href="https://www.discogs.com" target="_blank" rel="noopener noreferrer">Discogs</a></p>
        </>
      )}
    </PageShell>
  );
}

function CollectionRow({ item, view, libraryId }: { item: CollectionItem; view: View; libraryId: string | undefined }) {
  const [linkOpen, setLinkOpen] = useState(false);
  const [linkInput, setLinkInput] = useState('');
  const [error, setError] = useState<string | null>(null);
  const unmapItem = useUnmapCollectionItem(libraryId);
  const mapItem = useMapCollectionItem(libraryId);
  const linkItem = useLinkCollectionItem(libraryId);
  const removeItem = useRemoveCollectionItem(libraryId);
  const retryPush = useRetryPush(libraryId);
  const keepBoth = useKeepBothCopies(libraryId);
  const isUnmapped = view === 'unmapped';
  const suggestions = useCollectionSuggestions(item.id, isUnmapped);
  const title = titleOf(item);
  const artist = artistOf(item);
  const album = item.localAlbums[0];
  const removing = item.pushState === 'removing';
  const isExtraCopy = !!item.duplicateOf;

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
  const remove = async () => {
    const ok = await confirmDialog(isExtraCopy
      ? {
          title: 'Remove the duplicate copy?',
          message: <>This removes the extra copy of <strong>{artist} – {title}</strong> from tagave and from your Discogs collection. The other copy stays.</>,
          confirmLabel: 'Remove duplicate',
          tone: 'danger',
        }
      : {
          title: `Remove ${title} from your collection?`,
          message: 'It is removed from your Discogs collection too.',
          confirmLabel: 'Remove',
          tone: 'danger',
        });
    if (!ok) return;
    const t = showToast({ message: isExtraCopy ? 'Removing the duplicate from Discogs…' : 'Removing from Discogs…', durationMs: 0 });
    try {
      await removeItem.mutateAsync(item.id);
      updateToast(t, { message: isExtraCopy ? 'Duplicate removed; the other copy stays' : `Removed ${title}`, durationMs: 6000 });
    } catch (err) {
      updateToast(t, { message: `Could not remove it: ${detailOf(err, 'the server did not answer')}`, tone: 'danger', durationMs: 10000 });
    }
  };

  const ownBoth = async () => {
    try {
      await keepBoth.mutateAsync(item.id);
      showToast({ message: `Kept both copies of ${title}` });
    } catch (err) {
      showToast({ message: `Could not keep both: ${detailOf(err, 'the server did not answer')}`, tone: 'danger', durationMs: 10000 });
    }
  };

  const discogsLink = <a className={styles.textLink} href={item.discogsUrl} target="_blank" rel="noopener noreferrer">Open on Discogs ↗</a>;

  // one primary action per row
  let primary: React.ReactNode = null;
  if (removing) primary = <span className={styles.status}>Removing…</span>;
  else if (isExtraCopy) primary = <Button size="sm" variant="quiet-danger" onClick={() => void remove()}>Remove duplicate</Button>;
  else if (item.pushState === 'failed') primary = <Button size="sm" variant="secondary" loading={retryPush.isPending} onClick={() => retryPush.mutate(item.id)}>Retry</Button>;
  else if (album && view !== 'removed') primary = <LinkButton size="sm" variant="secondary" to="/albums/$albumId" params={{ albumId: album.id }}>Open album</LinkButton>;
  else if (isUnmapped) primary = <Button size="sm" variant="secondary" loading={linkItem.isPending && !!linkItem.variables?.notInLibrary} onClick={() => void link({ notInLibrary: true }, `${title} stays in Physical only`)}>Not in my library</Button>;
  else primary = discogsLink;

  const menu: MenuItem[] = [
    ...(isExtraCopy && !removing ? [{ key: 'keep-both', label: 'I own both', hint: 'Keep both copies; this is not a duplicate', disabled: keepBoth.isPending, onSelect: () => void ownBoth() }] : []),
    ...(isUnmapped ? [{ key: 'by-url', label: 'Link by URL or ID…', hint: 'Paste a MusicBrainz or Discogs address', onSelect: () => setLinkOpen(true) }] : []),
    { key: 'discogs', label: 'Open on Discogs', href: item.discogsUrl },
    ...(item.mappingState !== 'unmapped' && view !== 'removed'
      ? [{ key: 'unlink', label: 'Unlink from album', hint: 'Back to Unmapped', disabled: unmapItem.isPending, onSelect: () => unmapItem.mutate(item.id) }] : []),
    ...(view !== 'removed' && !removing
      ? [{ key: 'remove', label: isExtraCopy ? 'Remove duplicate' : 'Remove from collection', tone: 'danger' as const, separated: true, onSelect: () => void remove() }] : []),
  ];

  const facts = [
    item.format,
    item.folderName && item.folderName !== 'Uncategorized' ? item.folderName : null,
    item.mediaCondition ? `media ${item.mediaCondition}` : null,
    item.sleeveCondition ? `sleeve ${item.sleeveCondition}` : null,
    item.rating ? '★'.repeat(item.rating) : null,
  ].filter(Boolean);
  const onDisk = album && view !== 'removed'
    ? `On disk: ${album.title ?? 'album'}${item.localAlbums.length > 1 ? ` and ${item.localAlbums.length - 1} more` : ''}`
    : item.mappingSource === 'not_in_library' ? 'Not in your library' : null;

  const list = suggestions.data?.suggestions ?? [];

  return (
    <li className={styles.row}>
      <div className={styles.rowMain}>
        <CoverArt src={item.thumbUrl} title={title} compact className={styles.thumb} />
        <div className={styles.itemInfo}>
          <div className={styles.itemTitle}>
            <span className={styles.itemArtist}>{artist}</span> – {title}{item.basicInfo?.year ? <span className={styles.itemYear}> ({item.basicInfo.year})</span> : null}
          </div>
          <div className={styles.details}>
            {facts.length > 0 && <span>{facts.join(' · ')}</span>}
            {onDisk && <span>{onDisk}</span>}
            {isExtraCopy && <span className={styles.flag}>Duplicate · {item.copies} copies</span>}
            {isExtraCopy && !removing && (
              <Button size="sm" variant="quiet" loading={keepBoth.isPending} onClick={() => void ownBoth()}>I own both</Button>
            )}
            {isExtraCopy && isUnmapped && <span>Remove this copy, then link the one that stays</span>}
            {item.pushState === 'pending' && <span className={styles.status}>adding to Discogs…</span>}
            {item.pushState === 'failed' && <span className={styles.flagDanger} title={item.pushError ?? undefined}>{item.pushError?.startsWith('Removing') ? 'Removing from Discogs failed' : 'Adding to Discogs failed'}</span>}
          </div>

          {isUnmapped && !isExtraCopy && (
            <div className={styles.suggestions}>
              {suggestions.isLoading && <p className={styles.suggestHint}>Looking for this album in your library…</p>}
              {!suggestions.isLoading && list.length === 0 && <p className={styles.suggestHint}>No album in your library looks like this record.</p>}
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
