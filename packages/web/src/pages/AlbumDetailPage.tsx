/**
 * Album detail (spec BRW-2): cover, canonical vs local metadata, tracklist
 * with duration comparison, file facts, match provenance — plus everything
 * needed to act without leaving: gaps with dismiss, missing tracks,
 * candidate accept/exclude, duplicate copies, art refetch, as-is/ignore.
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from '@tanstack/react-router';
import { useCurrentLibrary, useAlbumEditions, useRefreshEditions, useMatchAnyEdition, useClearAnyEdition, useAddCollectionItem } from '../hooks';
import { api } from '../services/api';
import { ReviewsSection } from '../components/ReviewsSection';
import { AlbumMaintenanceActions } from '../components/AlbumMaintenanceActions';
import styles from './AlbumDetailPage.module.css';

interface DetailTrack {
  id: string;
  discNo: number | null;
  trackNo: number | null;
  title: string | null;
  durationMs: number | null;
  origin: string;
  cueStartMs: number | null;
  canonicalTitle: string | null;
  canonicalDurationMs: number | null;
  file: {
    relPath: string;
    codec: string | null;
    lossless: boolean | null;
    bitrateKbps: number | null;
    sampleRate: number | null;
    bitDepth: number | null;
    sizeBytes: number | null;
    status: string;
  };
}
interface Candidate {
  id: string;
  releaseMbid: string | null;
  discogsReleaseId: number | null;
  title: string;
  artistCredit: string;
  date: string | null;
  country: string | null;
  status: string | null;
  trackCount: number | null;
  distance: number;
  source: string;
  provider: string;
  rgMbid: string | null;
  excluded: boolean;
  /** media summary and first label/catno — present once the detail handler ships them */
  format?: string | null;
  label?: string | null;
}
interface PendingIdentify {
  id: string;
  state: 'created' | 'retry' | 'active';
  kind: 'mbid' | 'discogs' | 'reidentify' | 'sweep';
  pinned: string | null;
  priority: number;
  createdAt: string;
  startedAt: string | null;
  jobsAhead: number;
}
interface Gap {
  id: string;
  kind: string;
  state: string;
  dismissReason: string | null;
  details: Record<string, unknown>;
}
interface DiscogsCollectionItem {
  id: string;
  folder: string;
  mediaCondition?: string;
  sleeveCondition?: string;
  rating?: number;
  pushState?: string;
  pushError?: string;
}

interface AlbumDetail {
  id: string;
  releaseGroupId: string | null;
  title: string | null;
  artistCredit: string | null;
  year: number | null;
  state: string;
  dirPaths: string[];
  formats: string[];
  discCount: number | null;
  trackCount: number | null;
  totalDurationMs: number | null;
  coverUrl: string | null;
  /** the one queued identify job for this album, if any (manual pin, re-identify or the sweep) */
  pendingIdentify?: PendingIdentify | null;
  coverOrigin: string | null;
  isCueImage: boolean;
  cueRelPath: string | null;
  /** the folder mixes lossless and lossy files (XO-364: can be split by format) */
  mixed: boolean;
  /** set on an album split off another one; "Merge back" returns the files */
  splitFrom: string | null;
  artists?: Array<{ id: string; name: string; position: number }>;
  genres?: {
    effective: string[];
    styles: string[];
    raw: Array<{ tag: string; kind: string; source: string; weight?: number | null }>;
  };
  release: {
    mbid: string | null;
    title: string;
    date: string | null;
    country: string | null;
    status: string | null;
    labels: { name: string; catno?: string }[] | null;
    trackCount: number | null;
    artistCredit: string[] | string | null;
    discogsReleaseId: number | null;
    discogsMasterId: number | null;
    sourceOfTruth: string;
    externalLinks: Array<{ title: string; url: string; source: string }>;
    genres?: string[];
    styles?: string[];
    fetchedAt: string | null;
  } | null;
  match: {
    status: string;
    decidedBy: string;
    distance: number;
    decidedAt: string | null;
    reason: string | null;
    releaseGroupOnly?: boolean;
  } | null;
  discogsCollectionItems?: DiscogsCollectionItem[];
  editions?: {
    fetchedAt: string | null;
    releaseGroupMbid: string;
    editions: Array<{
      releaseId: string;
      mbid: string;
      title: string;
      status?: string | null;
      date?: string | null;
      country?: string | null;
      barcode?: string | null;
      packaging?: string | null;
      labels: Array<{ name: string; catalogNumber?: string | null }>;
      media: Array<Record<string, unknown>>;
      trackCount: number;
      owned: boolean;
      ownedByOtherAlbums: number;
    }>;
  } | null;
  tracks: DetailTrack[];
  missingTracks: { disc: number; position: number; title: string; lengthMs: number | null }[];
  gaps: Gap[];
  candidates: Candidate[];
  duplicates: {
    id: string;
    title: string | null;
    artist: string | null;
    trackCount: number | null;
    formats: string[] | null;
    state: string;
    dirPaths: string[] | null;
  }[];
}

function dur(ms: number | null | undefined): string {
  if (!ms) return '–:––';
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
function mb(bytes: number | null): string {
  return bytes ? `${(bytes / 1048576).toFixed(1)} MB` : '';
}

const STATE_LABEL: Record<string, string> = {
  matched: 'Matched',
  needs_review: 'Needs review',
  pending: 'Awaiting identification',
  unidentified: 'Unidentified',
  as_is: 'Kept as-is',
  ignored: 'Ignored',
};

const GAP_LABEL: Record<string, string> = {
  incomplete_album: 'Incomplete',
  duplicate: 'Duplicate',
  quality: 'Quality',
  missing_album: 'Missing album',
};

interface FlagChip {
  key: string;
  label: string;
  detail?: string;
}

const FLAG_LABEL: Record<string, string> = {
  noCover: 'No cover art',
  noEmbeddedArt: 'No embedded art',
  mixedLossless: 'Mixed lossless and lossy',
  parseErrors: 'Unreadable files',
  lowBitrate: 'Low bitrate',
  missingMbIds: 'Missing MusicBrainz IDs',
  trackNumberIssues: 'Track numbers',
  emptyRequiredFields: 'Empty required fields',
  titleCaseAnomalies: 'Title case',
  inconsistentAlbumFields: 'Inconsistent album fields',
  discNumberGaps: 'Disc number gaps',
};

function humanize(key: string): string {
  return key.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, (c) => c.toUpperCase());
}

/**
 * One chip per quality flag. Audio flags are `true` or a count; the TAG-6 lint
 * rules store an object with one list (track indexes, issue strings, field
 * names), which becomes "<label> · n tracks" with the list in the tooltip.
 */
function describeQualityFlags(flags: Record<string, unknown>): FlagChip[] {
  return Object.entries(flags).map(([key, value]) => {
    const label = FLAG_LABEL[key] ?? humanize(key);
    if (value === true || value == null) return { key, label };
    if (typeof value === 'number') return { key, label: `${label} · ${value}` };
    if (typeof value !== 'object') return { key, label: `${label} · ${String(value)}` };
    const obj = value as Record<string, unknown>;
    const items = Object.values(obj).filter(Array.isArray).flat() as unknown[];
    const noun = 'issues' in obj ? 'issues' : 'fields' in obj ? 'fields' : 'gap' in obj ? 'gaps' : 'tracks';
    const shown = items.slice(0, 8).map((x) => (typeof x === 'number' ? `track ${x + 1}` : typeof x === 'string' ? x : JSON.stringify(x)));
    const detail = shown.join('\n') + (items.length > 8 ? `\n… ${items.length - 8} more` : '');
    return { key, label: items.length > 0 ? `${label} · ${items.length} ${noun}` : label, ...(detail ? { detail } : {}) };
  });
}

export function AlbumDetailPage() {
  const { albumId } = useParams({ strict: false }) as { albumId: string };
  const { libraryId } = useCurrentLibrary();
  const queryClient = useQueryClient();
  const [showExcluded, setShowExcluded] = useState(false);
  const [mbidInput, setMbidInput] = useState('');

  const refresh = (delayMs = 0) =>
    setTimeout(() => {
      queryClient.invalidateQueries({ queryKey: ['album', albumId] });
      queryClient.invalidateQueries({ queryKey: ['albums'] });
    }, delayMs);

  const { data: album, isLoading } = useQuery({
    queryKey: ['album', albumId],
    queryFn: () => api.get<AlbumDetail>(`/libraries/${libraryId}/albums/${albumId}`),
    enabled: !!libraryId && !!albumId,
  });

  const { data: editions } = useAlbumEditions(libraryId, albumId);
  const refreshEditions = useRefreshEditions(libraryId);
  const matchAnyEdition = useMatchAnyEdition(libraryId);
  const clearAnyEdition = useClearAnyEdition(libraryId);

  const reidentify = useMutation({
    mutationFn: () => api.post(`/libraries/${libraryId}/albums/${albumId}/identify`),
    onSuccess: () => refresh(4000),
  });
  const fetchArt = useMutation({
    mutationFn: () => api.post(`/libraries/${libraryId}/albums/${albumId}/fetch-art`),
    onSuccess: () => refresh(5000),
  });
  const keepAsIs = useMutation({
    mutationFn: () => api.post(`/albums/${albumId}/as-is`),
    onSuccess: () => refresh(),
  });
  const ignore = useMutation({
    mutationFn: () => api.post(`/albums/${albumId}/ignore`),
    onSuccess: () => refresh(),
  });
  const acceptCandidate = useMutation({
    mutationFn: (candidateId: string) => api.post(`/albums/${albumId}/match`, { candidateId }),
    onSuccess: () => refresh(),
  });
  const excludeCandidate = useMutation({
    mutationFn: (candidateId: string) => api.post(`/albums/${albumId}/exclude-candidate`, { candidateId }),
    onSuccess: () => refresh(),
  });
  const matchMbid = useMutation({
    mutationFn: () =>
      api.post<{ ok: boolean }>(`/libraries/${libraryId}/albums/${albumId}/match-mbid`, {
        input: mbidInput,
      }),
    onSuccess: () => {
      setMbidInput('');
      refresh(0); // the detail now carries pendingIdentify; SSE clears it when the job decides
    },
  });
  const cancelRequest = useMutation({
    mutationFn: () => api.post(`/libraries/${libraryId}/albums/${albumId}/identify-request/cancel`, {}),
    onSuccess: () => refresh(0),
  });
  const pending = album?.pendingIdentify ?? null;
  const PENDING_KIND: Record<string, string> = {
    mbid: 'Manual match (MusicBrainz release)',
    discogs: 'Manual match (Discogs)',
    reidentify: 'Re-identify',
    sweep: 'Identification sweep',
  };

  const switchEdition = useMutation({
    mutationFn: (mbid: string) =>
      api.post(`/libraries/${libraryId}/albums/${albumId}/match-mbid`, { input: mbid }),
    onSuccess: () => refresh(6000),
  });

  const addToCollection = useAddCollectionItem(libraryId);

  const dismissGap = useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) =>
      api.post(`/gaps/${id}/dismiss`, { reason }),
    onSuccess: () => refresh(),
  });
  const reopenGap = useMutation({
    mutationFn: (id: string) => api.post(`/gaps/${id}/reopen`),
    onSuccess: () => refresh(),
  });

  if (isLoading || !album) return <div className={styles.container}>Loading album...</div>;

  const durationDrift = (t: DetailTrack) =>
    t.canonicalDurationMs && t.durationMs
      ? Math.abs(t.canonicalDurationMs - t.durationMs) > 5000
      : false;

  const openGaps = album.gaps.filter((g) => g.state === 'open');
  const dismissedGaps = album.gaps.filter((g) => g.state === 'dismissed');
  const visibleCandidates = album.candidates
    .filter((c) => showExcluded || !c.excluded)
    .sort((a, b) => a.distance - b.distance);
  const excludedCount = album.candidates.filter((c) => c.excluded).length;
  const qualityFlags = describeQualityFlags(
    (openGaps.find((g) => g.kind === 'quality')?.details as { flags?: Record<string, unknown> } | undefined)?.flags ?? {},
  );

  const describeGap = (g: Gap): string => {
    if (g.kind === 'incomplete_album') {
      const d = g.details as { have?: number; want?: number };
      return `${d.have}/${d.want} tracks`;
    }
    if (g.kind === 'duplicate') return `${(g.details as { count?: number }).count} copies of this release group`;
    if (g.kind === 'quality') return qualityFlags.map((f) => f.label).join(' · ');
    return '';
  };

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <div className={styles.coverBox}>
          {album.coverUrl ? (
            <img className={styles.cover} src={album.coverUrl} alt="" />
          ) : (
            <div className={styles.coverPlaceholder}>{album.trackCount}</div>
          )}
        </div>
        <div className={styles.headInfo}>
          <h1 className={styles.title}>{album.release?.title ?? album.title ?? 'Untitled'}</h1>
          <div className={styles.artist}>
            {album.artists && album.artists.length > 0 ? (
              <>
                {album.artists.map((artist, idx) => (
                  <span key={artist.id}>
                    <Link to="/artists/$artistId" params={{ artistId: artist.id }}>
                      {artist.name}
                    </Link>
                    {idx < album.artists!.length - 1 && ', '}
                  </span>
                ))}
              </>
            ) : Array.isArray(album.release?.artistCredit) ? (
              album.release?.artistCredit.join(', ')
            ) : (
              album.release?.artistCredit ?? album.artistCredit ?? 'Unknown artist'
            )}
          </div>
          <div className={styles.metaRow}>
            {[
              album.release?.date ?? album.year,
              album.release?.country,
              album.release?.labels?.[0]?.name,
              `${album.trackCount} tracks`,
              dur(album.totalDurationMs),
              album.formats?.join(', '),
            ].filter(Boolean).join(' · ')}
          </div>
          {album.genres && (album.genres.effective.length > 0 || album.genres.styles.length > 0) && (
            <div className={styles.genresRow} title={album.genres.raw.map((r) => `${r.tag} — ${r.source} ${r.kind}`).join('; ')}>
              {album.genres.effective.map((g) => (
                <span key={`g-${g}`} className={styles.genreChip}>{g}</span>
              ))}
              {album.genres.styles.length > 0 && album.genres.effective.length > 0 && (
                <span className={styles.genreSeparator}>·</span>
              )}
              {album.genres.styles.map((s) => (
                <span key={`s-${s}`} className={styles.styleChip}>{s}</span>
              ))}
            </div>
          )}
          <div className={styles.badgeRow}>
            <span className={`${styles.pill} ${styles[`state_${album.state}`] ?? ''}`}>
              {STATE_LABEL[album.state] ?? album.state}
            </span>
            {openGaps.map((g) => (
              <span key={g.id} className={`${styles.pill} ${styles.pillGap}`} title={describeGap(g)}>
                {GAP_LABEL[g.kind] ?? g.kind}
              </span>
            ))}
            {album.match?.releaseGroupOnly && (
              <button className={styles.pillButton} title="Matched to the release group, not one edition — click to clear" onClick={() => clearAnyEdition.mutate(albumId)}>
                any edition ✕
              </button>
            )}
            {album.match && (
              <span className={`${styles.pill} ${styles.pillMuted}`} title={album.match.reason ?? ''}>
                {album.match.decidedBy === 'system' ? 'auto-matched' : 'matched by you'} · {album.match.distance.toFixed(4)}
                {album.match.decidedAt ? ` · ${new Date(album.match.decidedAt).toLocaleDateString()}` : ''}
              </span>
            )}
            {album.coverOrigin && <span className={`${styles.pill} ${styles.pillMuted}`}>cover: {album.coverOrigin}</span>}
            {album.isCueImage && <span className={`${styles.pill} ${styles.pillMuted}`} title={album.cueRelPath ?? ''}>Cue image</span>}
            {album.release?.sourceOfTruth === 'discogs' && !album.release?.mbid && (
              <span className={`${styles.pill} ${styles.pillMuted}`}>Discogs-only</span>
            )}
            {album.release?.mbid && (
              <a className={styles.pillLink} href={`https://musicbrainz.org/release/${album.release.mbid}`} target="_blank" rel="noreferrer">
                MusicBrainz ↗
              </a>
            )}
            {album.release?.discogsReleaseId && (
              <a className={styles.pillLink} href={`https://www.discogs.com/release/${album.release.discogsReleaseId}`} target="_blank" rel="noreferrer">
                Discogs ↗
              </a>
            )}
            {album.release?.discogsMasterId && (
              <a className={styles.pillLink} href={`https://www.discogs.com/master/${album.release.discogsMasterId}`} target="_blank" rel="noreferrer">
                Master ↗
              </a>
            )}
            {album.discogsCollectionItems && album.discogsCollectionItems.length > 0 && (
              <a
                className={`${styles.pill} ${styles.pillAccent}`}
                href="/collection?view=both"
                title={album.discogsCollectionItems
                  .map((item) => {
                    const conds = [];
                    if (item.mediaCondition) conds.push(`Media: ${item.mediaCondition}`);
                    if (item.sleeveCondition) conds.push(`Sleeve: ${item.sleeveCondition}`);
                    const state = item.pushState === 'pending' ? ' (Adding to Discogs...)' :
                      item.pushState === 'failed' ? ` (Failed: ${item.pushError})` : '';
                    return `${item.folder}${conds.length > 0 ? ' (' + conds.join(', ') + ')' : ''}${state}`;
                  })
                  .join(' · ')}
              >
                {album.discogsCollectionItems[0]?.pushState === 'pending' ? 'Adding to Discogs…' : 'On vinyl/CD'}
              </a>
            )}
            {(!album.discogsCollectionItems || album.discogsCollectionItems.length === 0) && album.release?.discogsReleaseId && (
              <button
                className={styles.pillButton}
                onClick={() => addToCollection.mutate({ input: String(album.release?.discogsReleaseId) }, { onSuccess: () => refresh(1500) })}
                disabled={addToCollection.isPending}
                title="Add this edition to your Discogs collection (folder Uncategorized)"
              >
                {addToCollection.isPending ? 'Adding…' : '+ I own this on vinyl/CD'}
              </button>
            )}
          </div>
          <div className={styles.dirPath} title={album.dirPaths?.join('\n')}>{album.dirPaths?.[0]}</div>
          {((album.release?.genres?.length ?? 0) + (album.release?.styles?.length ?? 0)) > 0 && (
            <div className={styles.genresRow} title="Genres and styles (Discogs, CC0)">
              {album.release?.genres?.map((g) => (
                <span key={`g-${g}`} className={styles.genreChip}>{g}</span>
              ))}
              {album.release?.styles?.map((st) => (
                <span key={`s-${st}`} className={styles.styleChip}>{st}</span>
              ))}
            </div>
          )}
          <div className={styles.actions}>
            <button className="secondary" onClick={() => reidentify.mutate()} disabled={reidentify.isPending || !!pending} title={pending ? 'A request is already queued for this album' : 'Queue a fresh identification'}>
              {reidentify.isPending ? 'Queued…' : 'Re-identify'}
            </button>
            <button className="secondary" onClick={() => fetchArt.mutate()} disabled={fetchArt.isPending}>
              {fetchArt.isPending ? 'Queued…' : album.coverUrl ? 'Refetch art' : 'Fetch art'}
            </button>
            {album.state !== 'as_is' && (
              <button className="secondary" onClick={() => keepAsIs.mutate()} disabled={keepAsIs.isPending} title="Keep the local tags; stop identifying">
                Keep as-is
              </button>
            )}
            {album.state !== 'ignored' && (
              <button className="secondary" onClick={() => ignore.mutate()} disabled={ignore.isPending} title="Hide from the queue and gap counts">
                Ignore
              </button>
            )}
            {libraryId && <AlbumMaintenanceActions libraryId={libraryId} album={album} />}
          </div>
          {pending && (
            <div className={styles.pendingPanel} role="status">
              <span className={styles.pendingTitle}>{PENDING_KIND[pending.kind] ?? 'Identification'} queued</span>
              <span className={styles.pendingMeta}>
                {pending.pinned ? `${pending.pinned} · ` : ''}
                {pending.state === 'active' ? 'running now' : pending.state === 'retry' ? 'retrying' : pending.jobsAhead === 0 ? 'next in line' : `${pending.jobsAhead.toLocaleString()} ahead in the queue`}
                {' · '}since {new Date(pending.createdAt).toLocaleString()}
              </span>
              <button className="secondary" onClick={() => cancelRequest.mutate()} disabled={cancelRequest.isPending || pending.state === 'active'} title={pending.state === 'active' ? 'Already running on the worker' : 'Remove this request from the queue'}>
                {cancelRequest.isPending ? 'Cancelling…' : 'Cancel'}
              </button>
              {cancelRequest.isError && <span className={styles.mbidError}>Cancel failed</span>}
            </div>
          )}
          <div className={styles.mbidRow}>
            <input
              className={styles.mbidInput}
              placeholder={pending ? 'A request is queued — cancel it to submit another' : 'Paste a MusicBrainz or Discogs release URL / ID to match manually'}
              value={mbidInput}
              disabled={!!pending}
              onChange={(e) => setMbidInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && mbidInput.trim() && !pending) matchMbid.mutate();
              }}
            />
            <button
              onClick={() => matchMbid.mutate()}
              disabled={!mbidInput.trim() || matchMbid.isPending || !!pending}
            >
              {matchMbid.isPending ? 'Queuing…' : 'Match'}
            </button>
            {matchMbid.isError && (
              <span className={styles.mbidError}>
                {(matchMbid.error as { detail?: string; message?: string })?.detail ??
                  (matchMbid.error as Error)?.message ?? 'Failed'}
              </span>
            )}
            {matchMbid.isSuccess && !pending && <span className={styles.mbidOk}>Queued</span>}
          </div>
        </div>
      </div>

      {openGaps.length > 0 && (
        <div className={styles.section}>
          <h2 className={styles.sectionTitle}>Needs attention</h2>
          {openGaps.map((g) => (
            <div key={g.id} className={styles.gapRow}>
              <span className={styles.gapKind}>{GAP_LABEL[g.kind] ?? g.kind}</span>
              {g.kind === 'quality' ? (
                <span className={styles.flagList}>
                  {qualityFlags.map((f) => (
                    <span key={f.key} className={styles.flagChip} title={f.detail}>{f.label}</span>
                  ))}
                </span>
              ) : (
                <span className={styles.gapDetail}>{describeGap(g)}</span>
              )}
              <span className={styles.gapActions}>
                <button className="secondary" onClick={() => dismissGap.mutate({ id: g.id, reason: 'not_interested' })} title="Hide this; it will not count as a gap">
                  Dismiss
                </button>
                <button
                  className="secondary"
                  title="The data is wrong (feeds the false-positive metric)"
                  onClick={() => dismissGap.mutate({ id: g.id, reason: 'wrong_data' })}
                >
                  Wrong data
                </button>
              </span>
            </div>
          ))}
          {dismissedGaps.map((g) => (
            <div key={g.id} className={styles.gapRowDismissed}>
              <span className={styles.gapKind}>{GAP_LABEL[g.kind] ?? g.kind}</span>
              <span className={styles.gapDetail}>
                dismissed ({g.dismissReason?.replace('_', ' ') ?? 'no reason'})
              </span>
              <span className={styles.gapActions}>
                <button className="secondary" onClick={() => reopenGap.mutate(g.id)}>Reopen</button>
              </span>
            </div>
          ))}
        </div>
      )}

      {album.missingTracks.length > 0 && (
        <div className={styles.section}>
          <h2 className={styles.sectionTitle}>
            Missing tracks ({album.missingTracks.length})
          </h2>
          <table className={styles.missingTable}>
            <tbody>
              {album.missingTracks.map((m, i) => (
                <tr key={i}>
                  <td className={styles.num}>
                    {(album.discCount ?? 1) > 1 ? `${m.disc}-` : ''}
                    {m.position}
                  </td>
                  <td>{m.title}</td>
                  <td className={styles.num}>{dur(m.lengthMs)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {album.duplicates.length > 0 && (
        <div className={styles.section}>
          <h2 className={styles.sectionTitle}>Other copies ({album.duplicates.length})</h2>
          {album.duplicates.map((d) => (
            <div key={d.id} className={styles.dupRow}>
              <Link to="/albums/$albumId" params={{ albumId: d.id } as never} className={styles.dupLink}>
                {d.title ?? 'Untitled'}
              </Link>
              <span className={styles.gapDetail}>
                {[d.formats?.join('/'), `${d.trackCount} tracks`, STATE_LABEL[d.state] ?? d.state]
                  .filter(Boolean).join(' · ')}
              </span>
              <span className={styles.dupPath}>{d.dirPaths?.[0]}</span>
            </div>
          ))}
        </div>
      )}

      {album.candidates.length > 0 && album.state !== 'matched' && (
        <div className={styles.section}>
          <h2 className={styles.sectionTitle}>
            Match candidates ({visibleCandidates.length})
            {excludedCount > 0 && (
              <button className={styles.linkButton} onClick={() => setShowExcluded((s) => !s)}>
                {showExcluded ? 'hide' : 'show'} {excludedCount} excluded
              </button>
            )}
          </h2>
          <table className={styles.candTable}>
            <thead>
              <tr>
                <th className={styles.num}>Distance</th>
                <th>Release</th>
                <th>Date</th>
                <th>Country</th>
                <th className={styles.num}>Tracks</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {visibleCandidates.map((c) => (
                <tr key={c.id} className={c.excluded ? styles.candExcluded : ''}>
                  <td className={styles.num} title="0 = identical to the local tags and durations">{c.distance.toFixed(4)}</td>
                  <td className={styles.candRelease}>
                    <div className={styles.candTitleRow}>
                      <span className={`${styles.pill} ${styles.pillMuted}`} title={`Found via ${c.source.replace(/_/g, ' ')}`}>
                        {c.provider === 'discogs' ? 'Discogs' : 'MusicBrainz'}
                      </span>
                      <span className={styles.candTitle}>{c.title}</span>
                      <span className={styles.candArtist}>{c.artistCredit}</span>
                    </div>
                    <div className={styles.candSub}>
                      {[c.format, c.label, c.status].filter(Boolean).join(' · ')}
                      {c.releaseMbid && (
                        <a className={styles.pillLink} href={`https://musicbrainz.org/release/${c.releaseMbid}`} target="_blank" rel="noreferrer">
                          MusicBrainz ↗
                        </a>
                      )}
                      {c.discogsReleaseId && (
                        <a className={styles.pillLink} href={`https://www.discogs.com/release/${c.discogsReleaseId}`} target="_blank" rel="noreferrer">
                          Discogs #{c.discogsReleaseId} ↗
                        </a>
                      )}
                    </div>
                  </td>
                  <td className={styles.num}>{c.date ?? '–'}</td>
                  <td>{c.country ?? '–'}</td>
                  <td className={styles.num}>{c.trackCount ?? '–'}</td>
                  <td className={styles.gapActions}>
                    {!c.excluded && (
                      <>
                        <button
                          onClick={() => acceptCandidate.mutate(c.id)}
                          disabled={acceptCandidate.isPending}
                          title="Match this album to this release"
                        >
                          Accept
                        </button>
                        <button
                          className="secondary"
                          onClick={() => excludeCandidate.mutate(c.id)}
                          disabled={excludeCandidate.isPending}
                          title="Never suggest this release again"
                        >
                          Exclude
                        </button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <table className={styles.trackTable}>
        <thead>
          <tr>
            <th>#</th>
            <th>Title</th>
            <th>Length</th>
            {album.release && <th>Canonical</th>}
            <th>File</th>
          </tr>
        </thead>
        <tbody>
          {album.tracks.map((t) => (
            <tr key={t.id} className={t.file.status === 'error' ? styles.trackError : ''}>
              <td className={styles.num}>
                {t.discNo && (album.discCount ?? 1) > 1 ? `${t.discNo}-` : ''}
                {t.trackNo ?? '–'}
              </td>
              <td>
                {t.title ?? '(untitled)'}
                {t.canonicalTitle && t.canonicalTitle !== t.title && (
                  <span className={styles.canonTitle}> → {t.canonicalTitle}</span>
                )}
              </td>
              <td className={durationDrift(t) ? styles.durDrift : styles.num}>
                {dur(t.durationMs)}
                {t.origin === 'cue' && t.cueStartMs !== null && (
                  <span> @ {dur(t.cueStartMs)}</span>
                )}
              </td>
              {album.release && (
                <td className={styles.num}>{dur(t.canonicalDurationMs)}</td>
              )}
              <td className={styles.fileCell}>
                {[
                  t.file.codec,
                  t.file.lossless
                    ? `${t.file.bitDepth ?? '?'}bit/${((t.file.sampleRate ?? 0) / 1000).toFixed(1)}kHz`
                    : t.file.bitrateKbps
                      ? `${t.file.bitrateKbps}kbps`
                      : null,
                  mb(t.file.sizeBytes),
                ].filter(Boolean).join(' · ')}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {editions && editions.editions.length > 0 && (
        <div className={styles.section}>
          <div className={styles.sectionHead}>
            <h2 className={styles.sectionTitle}>Editions ({editions.editions.length})</h2>
            <div className={styles.sectionTools}>
              {album.match?.releaseGroupOnly && (
                <span className={`${styles.pill} ${styles.pillMuted}`}>any edition</span>
              )}
              {!editions.fetchedAt && (
                <span className={styles.muted}>Fetching editions from MusicBrainz…</span>
              )}
              {editions.fetchedAt && (
                <button
                  className={styles.linkButton}
                  onClick={() => refreshEditions.mutate(albumId)}
                  disabled={refreshEditions.isPending}
                >
                  Refresh
                </button>
              )}
            </div>
          </div>
          <table className={styles.candTable}>
            <thead>
              <tr>
                <th>Date</th>
                <th>Country</th>
                <th>Label / Catno</th>
                <th>Format</th>
                <th className={styles.num}>Tracks</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {editions.editions.map((e) => (
                <tr key={e.releaseId} className={e.owned ? styles.ownedRow : ''}>
                  <td className={styles.num}>{e.date ?? '–'}</td>
                  <td>{e.country ?? '–'}</td>
                  <td>
                    {e.labels.length > 0
                      ? e.labels.map((l) => (
                        <span key={l.name} className={styles.cellLine}>
                          {l.name}
                          {l.catalogNumber && ` / ${l.catalogNumber}`}
                        </span>
                      ))
                      : '–'}
                  </td>
                  <td>
                    {e.media.map((m, i) => (
                      <span key={i} className={styles.cellLine}>
                        {(m as any).format}
                        {(m as any).trackCount ? ` × ${(m as any).trackCount}` : ''}
                      </span>
                    ))}
                  </td>
                  <td className={styles.num}>{e.trackCount}</td>
                  <td className={styles.gapActions}>
                    {e.owned ? (
                      <span className={styles.muted}>This copy</span>
                    ) : (
                      <button
                        className="secondary"
                        onClick={() => switchEdition.mutate(e.mbid)}
                        disabled={switchEdition.isPending}
                      >
                        {switchEdition.isPending ? 'Queued…' : 'Use this edition'}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {album.match && (
            <div className={styles.sectionFoot}>
              <button
                onClick={() => (album.match?.releaseGroupOnly ? clearAnyEdition.mutate(albumId) : matchAnyEdition.mutate(albumId))}
                disabled={matchAnyEdition.isPending || clearAnyEdition.isPending}
                className={styles.linkButton}
                title="Any edition: keep the release-group match without pinning one edition"
              >
                {album.match.releaseGroupOnly ? 'Clear' : 'Mark'} any edition
              </button>
            </div>
          )}
        </div>
      )}

      {album.releaseGroupId ? (
        <ReviewsSection libraryId={libraryId} releaseGroupId={album.releaseGroupId} editions={editions?.editions} />
      ) : (
        <div className={styles.section}>
          <h2 className={styles.sectionTitle}>Reviews &amp; listening</h2>
          <p className={styles.muted}>
            Ratings, reviews and listens attach to a release group — match this album first.
          </p>
        </div>
      )}

      {(album.release?.discogsReleaseId || album.release?.discogsMasterId || album.candidates.some(c => c.discogsReleaseId)) && (
        <div className={styles.attribution}>
          <span>
            Data provided by{' '}
            <a href="https://www.discogs.com" target="_blank" rel="noreferrer">
              Discogs
            </a>
          </span>
        </div>
      )}
    </div>
  );
}
