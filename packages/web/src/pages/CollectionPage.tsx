/**
 * Collection reconciliation (spec COL-1, GAP-3): Discogs collection items
 * with physical↔digital mapping, inline manual mapping for unmapped items.
 */
import { useState, useEffect } from 'react';
import { useNavigate } from '@tanstack/react-router';
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
  useCurrentLibrary,
} from '../hooks';
import styles from './CollectionPage.module.css';

const VIEW_LABELS: Record<string, string> = {
  physical_only: 'Physical only',
  both: 'Both',
  unmapped: 'Unmapped',
  removed: 'Removed',
};

interface AddCollectionItemInput {
  input: string;
  folderId?: number;
  mediaCondition?: string;
  sleeveCondition?: string;
  notes?: string;
  rating?: number;
}

interface CollectionItem {
  id: string;
  discogsReleaseId: number;
  discogsMasterId?: number;
  folderId: number;
  folderName: string;
  dateAdded?: string;
  rating?: number;
  mediaCondition?: string;
  sleeveCondition?: string;
  notes?: string;
  formats: unknown;
  mappingState: string;
  mappingSource?: string;
  releaseId?: string;
  releaseGroupId?: string;
  basicInfo: {
    title?: string;
    artists?: string[];
    year?: number;
    thumbUrl?: string;
    coverUrl?: string;
  };
  localAlbums: Array<{
    id: string;
    title: string;
    artist: string;
    state: string;
    formats: string[];
  }>;
  discogsUrl: string;
  pushState?: string;
  pushError?: string;
  localAlbumId?: string;
}

interface SourcesResponse {
  sources: Array<{
    id: string;
    provider: string;
    username: string;
    status: string;
    lastSyncAt: string | null;
    counts: {
      total: number;
      mapped: number;
      unmapped: number;
      removed: number;
    };
  }>;
}

interface CollectionResponse {
  items: CollectionItem[];
  nextCursor: string | null;
}

interface CollectionOptions {
  username: string;
  folders: Array<{ id: number; name: string }>;
  fields: Array<{ id: number; name: string; type: string; options?: string[] }>;
  conditionGrades: string[];
}

interface AddCollectionItemPayload extends AddCollectionItemInput {
  input: string;
}

export function CollectionPage() {
  const { libraryId } = useCurrentLibrary();
  const navigate = useNavigate();
  const [view, setView] = useState<'physical_only' | 'both' | 'unmapped' | 'removed'>('physical_only');
  const [mapInputId, setMapInputId] = useState<string | null>(null);
  const [mapInputValue, setMapInputValue] = useState('');
  const [showAddForm, setShowAddForm] = useState(false);
  const [addFormData, setAddFormData] = useState({
    input: '',
    folderId: 1,
    mediaCondition: '',
    sleeveCondition: '',
    notes: '',
    rating: 0,
  });
  const [removeConfirmId, setRemoveConfirmId] = useState<string | null>(null);

  const sources = useCollectionSources(libraryId);
  const collection = useCollection(libraryId, { view });
  const sync = useSyncCollection(libraryId);
  const remap = useRemapCollection(libraryId);
  const mapItem = useMapCollectionItem(libraryId);
  const unmapItem = useUnmapCollectionItem(libraryId);
  const options = useCollectionOptions(libraryId);
  const addItem = useAddCollectionItem(libraryId);
  const removeItem = useRemoveCollectionItem(libraryId);
  const retryPush = useRetryPush(libraryId);

  const sourcesData = (sources.data as SourcesResponse) ?? { sources: [] };
  const collectionData = (collection.data as CollectionResponse) ?? { items: [] };
  const optionsData = (options.data as CollectionOptions) ?? { username: '', folders: [], fields: [], conditionGrades: [] };
  const source = sourcesData.sources[0];

  // Poll while syncing OR while any item has pending pushState
  const hasPendingPush = collectionData.items.some(item => item.pushState === 'pending');
  useEffect(() => {
    if (!source || (source.status !== 'syncing' && !hasPendingPush)) return;
    const interval = setInterval(() => {
      sources.refetch();
      collection.refetch();
    }, 3000);
    return () => clearInterval(interval);
  }, [source?.status, hasPendingPush, sources, collection]);

  const formatSummary = (formats: unknown): string => {
    if (!Array.isArray(formats)) return '';
    return formats
      .map((f: any) => {
        const qty = f.qty ? `${f.qty}×` : '';
        return `${qty}${f.name}`;
      })
      .join(', ');
  };

  const conditionSummary = (item: CollectionItem): string => {
    const parts = [];
    if (item.mediaCondition) parts.push(`Media: ${item.mediaCondition}`);
    if (item.sleeveCondition) parts.push(`Sleeve: ${item.sleeveCondition}`);
    return parts.join(' / ');
  };

  const renderStars = (rating?: number): string => {
    if (!rating) return '';
    return '★'.repeat(rating);
  };

  const handleMap = async (itemId: string) => {
    if (!mapInputValue.trim()) return;
    try {
      await mapItem.mutateAsync({ itemId, input: mapInputValue });
      setMapInputId(null);
      setMapInputValue('');
      collection.refetch();
    } catch (err) {
      console.error('Map failed:', err);
    }
  };

  const handleUnmap = async (itemId: string) => {
    try {
      await unmapItem.mutateAsync(itemId);
      collection.refetch();
    } catch (err) {
      console.error('Unmap failed:', err);
    }
  };

  const counts = source?.counts ?? { total: 0, mapped: 0, unmapped: 0, removed: 0 };

  return (
    <div className={styles.container}>
      {!source ? (
        <div className={styles.empty}>
          <p>No Discogs collection source configured.</p>
          <p>Go to <a href="/settings/providers">Settings › Providers</a> to set up a Discogs token.</p>
          <button onClick={() => navigate({ to: '/settings/providers' })}>
            Set up Discogs
          </button>
        </div>
      ) : (
        <>
          <div className={styles.header}>
            <div>
              <h1 className={styles.title}>{source.username}'s Collection</h1>
              {source.lastSyncAt && (
                <p className={styles.meta}>
                  Last synced: {new Date(source.lastSyncAt).toLocaleString()}
                </p>
              )}
            </div>

            <div className={styles.headerActions}>
              {source.status === 'syncing' && (
                <div className={styles.statusChip}>Syncing...</div>
              )}
              <button
                onClick={() => setShowAddForm(!showAddForm)}
                className={styles.primaryBtn}
              >
                Add physical item
              </button>
              <button
                onClick={() => sync.mutate()}
                disabled={sync.isPending || source.status === 'syncing'}
                className={styles.primaryBtn}
              >
                Sync now
              </button>
              <button
                onClick={() => remap.mutate()}
                disabled={remap.isPending || source.status === 'syncing'}
                className={styles.secondaryBtn}
              >
                Re-run mapping
              </button>
            </div>
          </div>

          {showAddForm && (
            <div className={styles.addForm}>
              <h2>Add Physical Item</h2>
              <div className={styles.formGroup}>
                <label>Discogs Release URL or ID *</label>
                <input
                  type="text"
                  placeholder="https://www.discogs.com/release/12345 or 12345"
                  value={addFormData.input}
                  onChange={(e) => setAddFormData({ ...addFormData, input: e.target.value })}
                  className={styles.formInput}
                />
              </div>

              <div className={styles.formRow}>
                <div className={styles.formGroup}>
                  <label>Folder</label>
                  <select
                    value={addFormData.folderId}
                    onChange={(e) => setAddFormData({ ...addFormData, folderId: parseInt(e.target.value, 10) })}
                    className={styles.formInput}
                  >
                    {optionsData.folders.map(f => (
                      <option key={f.id} value={f.id}>{f.name}</option>
                    ))}
                  </select>
                </div>

                <div className={styles.formGroup}>
                  <label>Media Condition</label>
                  <select
                    value={addFormData.mediaCondition}
                    onChange={(e) => setAddFormData({ ...addFormData, mediaCondition: e.target.value })}
                    className={styles.formInput}
                  >
                    <option value="">Select condition</option>
                    {optionsData.conditionGrades.map(grade => (
                      <option key={grade} value={grade}>{grade}</option>
                    ))}
                  </select>
                </div>

                <div className={styles.formGroup}>
                  <label>Sleeve Condition</label>
                  <select
                    value={addFormData.sleeveCondition}
                    onChange={(e) => setAddFormData({ ...addFormData, sleeveCondition: e.target.value })}
                    className={styles.formInput}
                  >
                    <option value="">Select condition</option>
                    {optionsData.conditionGrades.map(grade => (
                      <option key={grade} value={grade}>{grade}</option>
                    ))}
                  </select>
                </div>
              </div>

              <div className={styles.formGroup}>
                <label>Notes</label>
                <textarea
                  placeholder="Optional notes..."
                  value={addFormData.notes}
                  onChange={(e) => setAddFormData({ ...addFormData, notes: e.target.value })}
                  className={styles.formInput}
                  rows={2}
                />
              </div>

              <div className={styles.formGroup}>
                <label>Rating (0-5)</label>
                <input
                  type="number"
                  min="0"
                  max="5"
                  value={addFormData.rating}
                  onChange={(e) => setAddFormData({ ...addFormData, rating: parseInt(e.target.value, 10) || 0 })}
                  className={styles.formInput}
                />
              </div>

              <div className={styles.formActions}>
                <button
                  onClick={async () => {
                    try {
                      const payload: AddCollectionItemInput = {
                        input: addFormData.input,
                        folderId: addFormData.folderId,
                      };
                      if (addFormData.mediaCondition) payload.mediaCondition = addFormData.mediaCondition;
                      if (addFormData.sleeveCondition) payload.sleeveCondition = addFormData.sleeveCondition;
                      if (addFormData.notes) payload.notes = addFormData.notes;
                      if (addFormData.rating) payload.rating = addFormData.rating;
                      await addItem.mutateAsync(payload);
                      setShowAddForm(false);
                      setAddFormData({
                        input: '',
                        folderId: 1,
                        mediaCondition: '',
                        sleeveCondition: '',
                        notes: '',
                        rating: 0,
                      });
                    } catch (err: any) {
                      alert(`Error: ${err?.response?.data?.detail || 'Failed to add item'}`);
                    }
                  }}
                  disabled={!addFormData.input.trim() || addItem.isPending}
                  className={styles.primaryBtn}
                >
                  {addItem.isPending ? 'Adding...' : 'Add Item'}
                </button>
                <button
                  onClick={() => setShowAddForm(false)}
                  className={styles.secondaryBtn}
                >
                  Cancel
                </button>
              </div>
            </div>
          )}

          <div className={styles.tabs}>
            {Object.entries(VIEW_LABELS).map(([k, label]) => {
              const cnt = counts[k as keyof typeof counts];
              return (
                <button
                  key={k}
                  className={k === view ? styles.tabActive : styles.tab}
                  onClick={() => {
                    setView(k as typeof view);
                    setMapInputId(null);
                    setMapInputValue('');
                  }}
                >
                  {label} {cnt ? <span className={styles.count}>{cnt}</span> : null}
                </button>
              );
            })}
          </div>

          {collection.isLoading && <div className={styles.loading}>Loading...</div>}

          {!collection.isLoading && collectionData.items.length === 0 && (
            <div className={styles.empty}>
              No items in this view.
            </div>
          )}

          <div className={styles.list}>
            {collectionData.items.map((item) => (
              <div key={item.id} className={styles.row}>
                <div className={styles.rowContent}>
                  {item.basicInfo.thumbUrl && (
                    <img
                      src={item.basicInfo.thumbUrl}
                      alt={item.basicInfo.title || 'Album'}
                      className={styles.thumb}
                    />
                  )}

                  <div className={styles.itemInfo}>
                    <div className={styles.title}>
                      {item.basicInfo.artists?.join(', ')} – {item.basicInfo.title}
                      {item.basicInfo.year && ` (${item.basicInfo.year})`}
                    </div>

                    <div className={styles.details}>
                      <span className={styles.chip}>{item.folderName}</span>
                      {formatSummary(item.formats) && (
                        <span className={styles.chip}>{formatSummary(item.formats)}</span>
                      )}
                      {conditionSummary(item) && (
                        <span className={styles.chip}>{conditionSummary(item)}</span>
                      )}
                      {item.rating && (
                        <span className={styles.chip} title={`Rating: ${item.rating}`}>
                          {renderStars(item.rating)}
                        </span>
                      )}
                      {item.pushState === 'pending' && (
                        <span className={`${styles.chip} ${styles.chipPending}`}>adding to Discogs…</span>
                      )}
                      {item.pushState === 'failed' && (
                        <span className={`${styles.chip} ${styles.chipFailed}`} title={`Error: ${item.pushError}`}>
                          failed: {item.pushError?.substring(0, 20)}…
                        </span>
                      )}
                    </div>

                    {item.notes && (
                      <div className={styles.notes} title={`Notes: ${item.notes}`}>
                        Note: {item.notes.substring(0, 60)}
                        {item.notes.length > 60 ? '…' : ''}
                      </div>
                    )}

                    {view === 'unmapped' && (
                      <div className={styles.mapInput}>
                        {mapInputId === item.id ? (
                          <div className={styles.mapInputField}>
                            <input
                              type="text"
                              placeholder="Paste MusicBrainz or Discogs URL / ID"
                              value={mapInputValue}
                              onChange={(e) => setMapInputValue(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') {
                                  handleMap(item.id);
                                }
                              }}
                              autoFocus
                            />
                            <button
                              onClick={() => handleMap(item.id)}
                              disabled={!mapInputValue.trim() || mapItem.isPending}
                            >
                              Map
                            </button>
                            <button
                              onClick={() => {
                                setMapInputId(null);
                                setMapInputValue('');
                              }}
                            >
                              Cancel
                            </button>
                          </div>
                        ) : (
                          <button
                            onClick={() => setMapInputId(item.id)}
                            className={styles.mapBtn}
                          >
                            Map
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                </div>

                <div className={styles.rowActions}>
                  <a href={item.discogsUrl} target="_blank" rel="noopener noreferrer" className={styles.link}>
                    Discogs ↗
                  </a>

                  {item.releaseGroupId && view === 'both' && item.localAlbums.length > 0 && item.localAlbums[0] && (
                    <a
                      href={`/albums/${item.localAlbums[0]!.id}`}
                      className={styles.link}
                      onClick={(e) => {
                        e.preventDefault();
                        navigate({ to: '/albums/$albumId', params: { albumId: item.localAlbums[0]!.id } });
                      }}
                    >
                      Local album ↗
                    </a>
                  )}

                  {item.releaseGroupId && view === 'physical_only' && (
                    <span className={styles.unmappedLabel}>not on disk</span>
                  )}

                  {item.releaseGroupId && (
                    <button
                      onClick={() => handleUnmap(item.id)}
                      disabled={unmapItem.isPending}
                      className={styles.smallBtn}
                      title="Clear mapping and return to unmapped"
                    >
                      Unmap
                    </button>
                  )}

                  {item.pushState === 'failed' && (
                    <button
                      onClick={() => retryPush.mutate(item.id)}
                      disabled={retryPush.isPending}
                      className={styles.smallBtn}
                      title="Retry failed push"
                    >
                      Retry
                    </button>
                  )}

                  {removeConfirmId === item.id ? (
                    <div className={styles.removeConfirm}>
                      <span>Remove from Discogs?</span>
                      <button
                        onClick={async () => {
                          try {
                            await removeItem.mutateAsync(item.id);
                            setRemoveConfirmId(null);
                          } catch (err) {
                            console.error('Remove failed:', err);
                          }
                        }}
                        disabled={removeItem.isPending}
                        className={styles.smallBtn}
                      >
                        {removeItem.isPending ? 'Removing…' : 'Yes'}
                      </button>
                      <button
                        onClick={() => setRemoveConfirmId(null)}
                        className={styles.smallBtn}
                      >
                        No
                      </button>
                    </div>
                  ) : (
                    <button
                      onClick={() => setRemoveConfirmId(item.id)}
                      className={styles.smallBtn}
                      title="Remove from collection"
                    >
                      Remove
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>

          <div className={styles.footer}>
            <p>Data provided by <a href="https://www.discogs.com" target="_blank" rel="noopener noreferrer">Discogs</a></p>
          </div>
        </>
      )}
    </div>
  );
}
