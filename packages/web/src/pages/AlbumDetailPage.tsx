/**
 * Album detail (spec BRW-2): cover, canonical vs local metadata, tracklist
 * with duration comparison, file facts, match provenance — plus everything
 * needed to act without leaving: gaps with dismiss, missing tracks,
 * candidate accept/exclude, duplicate copies, art refetch, as-is/ignore.
 */
import { Fragment, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from '@tanstack/react-router';
import { useCurrentLibrary, useAlbumEditions, useRefreshEditions, useMatchAnyEdition, useClearAnyEdition, useAddCollectionItem } from '../hooks';
import { api } from '../services/api';
import { ReviewsSection } from '../components/ReviewsSection';
import { AlbumEditionsPanel } from './AlbumEditionsPanel';
import { AlbumMaintenanceActions } from '../components/AlbumMaintenanceActions';
import { BulkTagEditor, type EditScopeOption } from '../components/BulkTagEditor';
import { CompilationPanel, type MergeCandidateView } from '../components/CompilationPanel';
import { useFingerprintAlbum } from '../hooks/useFingerprint';
import { useAlbumsReturnSearch } from './albumSelection';
import styles from './AlbumDetailPage.module.css';
import { showsTrackArtists, uniqueGenres } from '../utils/albumPresentation';
import { describeQualityFlags } from '../utils/qualityFlags';
import { Button, EmptyState, LinkButton, CoverArt } from '../components/ui';
import { useScrollFade } from '../components/ui/useScrollFade';

interface DetailTrack {
  id: string;
  discNo: number | null;
  trackNo: number | null;
  title: string | null;
  /** the track's own artist tag; on a compilation it differs per track */
  artist?: string | null;
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
  /** built by "Treat as one album"; can be split back */
  merged?: boolean;
  /** other albums with this title that fit together with this one */
  mergeCandidates?: MergeCandidateView[];
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

export function AlbumDetailPage() {
  const { albumId } = useParams({ strict: false }) as { albumId: string };
  const { libraryId } = useCurrentLibrary();
  const queryClient = useQueryClient();
  const albumsReturnSearch = useAlbumsReturnSearch();
  const [showExcluded, setShowExcluded] = useState(false);
  const [mbidInput, setMbidInput] = useState('');
  // Album first; editions, reviews and the background story live on their own
  // faces and load only when opened, so a page visit costs one detail request.
  const [tab, setTab] = useState<'album' | 'care' | 'editions' | 'reviews' | 'activity'>('album');
  const tabStrip = useScrollFade<HTMLElement>(tab);
  const [editingTags, setEditingTags] = useState(false);
  // the split options live in "Manage this album"; the Library health row opens it
  const manageRef = useRef<HTMLDetailsElement>(null);
  const openManage = () => {
    const el = manageRef.current;
    if (!el) return;
    el.open = true;
    el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  const refresh = (delayMs = 0) =>
    setTimeout(() => {
      queryClient.invalidateQueries({ queryKey: ['album', albumId] });
      queryClient.invalidateQueries({ queryKey: ['albums'] });
    }, delayMs);

  const { data: album, isLoading, isError, refetch } = useQuery({
    queryKey: ['album', albumId],
    queryFn: () => api.get<AlbumDetail>(`/libraries/${libraryId}/albums/${albumId}`),
    enabled: !!libraryId && !!albumId,
  });

  const { data: editions } = useAlbumEditions(libraryId, albumId, { enabled: tab === 'editions' });
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

  // Switching edition is a manual identification request: it queues on the
  // worker and the detail carries pendingIdentify until the decision lands, so
  // the page refetches at once (the panel appears) instead of after a blind wait.
  const [switchingMbid, setSwitchingMbid] = useState<string | null>(null);
  const switchEdition = useMutation({
    mutationFn: (mbid: string) => {
      setSwitchingMbid(mbid);
      return api.post(`/libraries/${libraryId}/albums/${albumId}/match-mbid`, { input: mbid });
    },
    onSuccess: () => refresh(0),
    onSettled: () => setSwitchingMbid(null),
  });
  /** the API's problem+json `detail` is the message the owner should read, e.g. the 409 for a request already queued */
  const errorDetail = (m: { error: unknown }): string | null =>
    (m.error as { detail?: string } | null)?.detail ?? (m.error as Error | null)?.message ?? null;

  const addToCollection = useAddCollectionItem(libraryId);
  const fingerprint = useFingerprintAlbum(libraryId);

  const dismissGap = useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) =>
      api.post(`/gaps/${id}/dismiss`, { reason }),
    onSuccess: () => refresh(),
  });
  const reopenGap = useMutation({
    mutationFn: (id: string) => api.post(`/gaps/${id}/reopen`),
    onSuccess: () => refresh(),
  });

  if (isError) return <div className={styles.container} role="alert"><h1>Couldn’t load this album</h1><p>Try again, or return to your library.</p><Button onClick={() => void refetch()}>Try again</Button><Link to="/albums">Back to albums</Link></div>;

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
    (openGaps.find((g) => g.kind === 'quality')?.details as { flags?: Record<string, unknown> } | undefined)?.flags,
    { mixed: album.mixed },
  );
  // one number for the tab, the header link and the section heading: each
  // quality problem counts on its own, every other open gap counts once
  const otherGaps = openGaps.filter((g) => g.kind !== 'quality');
  const issueCount = qualityFlags.length + otherGaps.length;
  // A quality gap whose flags describe nothing we can show would render an
  // empty group; matched albums keep their candidates but do not show them.
  const shownOpenGaps = openGaps.filter((g) => g.kind !== 'quality' || qualityFlags.length > 0);
  const showCandidates = album.candidates.length > 0 && album.state !== 'matched';
  // A compilation (or any album whose tracks credit other artists) gets a
  // per-track Artist column.
  const trackArtists = showsTrackArtists(album.tracks, album.artistCredit);
  const careEmpty = shownOpenGaps.length === 0 && dismissedGaps.length === 0
    && album.missingTracks.length === 0 && album.duplicates.length === 0 && !showCandidates;
  const issueNoun = issueCount === 1 ? 'issue' : 'issues';

  const genreLabels = uniqueGenres(album.genres?.effective, album.genres?.styles, album.release?.genres, album.release?.styles);

  // The bulk editor covers this album, or everything in its folder (or the
  // folder above it, where a compilation filed one folder per track lives).
  const parentOf = (d: string) => (d.includes('/') ? d.slice(0, d.lastIndexOf('/')) : '');
  const editScopes: EditScopeOption[] = [
    { key: 'album', label: `This album (${album.trackCount ?? 0} track${album.trackCount === 1 ? '' : 's'})`, scope: { type: 'albumIds', albumIds: [album.id] } },
    ...(album.dirPaths?.length === 1 && album.dirPaths[0]
      ? [{ key: 'folder', label: `Every file in ${album.dirPaths[0]} (whichever album it is in)`, scope: { type: 'folder' as const, dirPath: album.dirPaths[0] } }]
      : []),
    ...(album.dirPaths?.length === 1 && parentOf(album.dirPaths[0] ?? '')
      ? [{ key: 'parent', label: `Every file in ${parentOf(album.dirPaths[0]!)} and its subfolders`, scope: { type: 'folder' as const, dirPath: parentOf(album.dirPaths[0]!) } }]
      : []),
  ];

  const describeGap = (g: Gap): string => {
    if (g.kind === 'incomplete_album') {
      const d = g.details as { have?: number; want?: number };
      return `${d.have}/${d.want} tracks`;
    }
    if (g.kind === 'duplicate') return `${(g.details as { count?: number }).count} copies of this release group`;
    return '';
  };

  return (
    <div className={styles.container}>
      <Link to="/albums" search={albumsReturnSearch as never} className={styles.backLink}>{albumsReturnSearch ? '← Back to your selection' : '← All albums'}</Link>
      <div className={styles.header}>
        <div className={styles.coverBox}>
          <CoverArt src={album.coverUrl} title={album.release?.title ?? album.title ?? 'Untitled'} loading="eager" className={styles.cover} />
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
              album.trackCount == null ? 'Track count unavailable' : album.isCueImage ? `${album.trackCount} audio ${(album.trackCount ?? 0) === 1 ? 'file' : 'files'} (CUE image)` : `${album.trackCount ?? 0} ${(album.trackCount ?? 0) === 1 ? 'track' : 'tracks'}`,
              dur(album.totalDurationMs),
              album.formats?.join(', '),
            ].filter(Boolean).join(' · ')}
          </div>
          {genreLabels.length > 0 && <p className={styles.genreText}>{genreLabels.slice(0, 5).join(' · ')}{genreLabels.length > 5 && <span className={styles.muted}> +{genreLabels.length - 5} more in album details</span>}</p>}
          <div className={styles.badgeRow}>
            <span className={`${styles.pill} ${styles[`state_${album.state}`] ?? ''}`}>
              {STATE_LABEL[album.state] ?? album.state}
            </span>
            {issueCount > 0 && <Button variant="quiet" size="sm" onClick={() => setTab('care')}>{issueCount} library {issueNoun} →</Button>}
            {album.match?.releaseGroupOnly && (
              <Button variant="secondary" size="sm" title="Matched to the release group, not one edition — click to clear" onClick={() => clearAnyEdition.mutate(albumId)}>
                any edition ✕
              </Button>
            )}
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
              <Button
                variant="secondary"
                size="sm"
                onClick={() => addToCollection.mutate({ input: String(album.release?.discogsReleaseId) }, { onSuccess: () => refresh(1500) })}
                disabled={addToCollection.isPending}
                title="Add this edition to your Discogs collection (folder Uncategorized)"
              >
                {addToCollection.isPending ? 'Adding…' : '+ I own this on vinyl/CD'}
              </Button>
            )}
          </div>
          {libraryId && <CompilationPanel libraryId={libraryId} album={album} onEditTags={() => setEditingTags(true)} />}
          <details className={styles.albumFacts}>
            <summary>Album details</summary>
            <dl>
              <div><dt>Genres & styles</dt><dd>{genreLabels.join(', ') || 'Not available'}</dd></div>
              <div><dt>Local folder</dt><dd>{album.dirPaths?.join(', ') || 'Not available'}</dd></div>
              <div><dt>Identification</dt><dd>{album.match ? `${album.match.decidedBy === 'system' ? 'Automatic match' : 'Matched by you'}${album.match.decidedAt ? ` on ${new Date(album.match.decidedAt).toLocaleDateString()}` : ''}` : 'No release matched'}</dd></div>
              {album.coverOrigin && <div><dt>Artwork source</dt><dd>{album.coverOrigin}</dd></div>}
              {album.isCueImage && <div><dt>CUE sheet</dt><dd>{album.cueRelPath || 'CUE image album'}</dd></div>}
            </dl>
          </details>
          <details ref={manageRef} className={styles.maintenance}><summary>Manage this album</summary>
          <div className={styles.actions}>
            <Button variant="secondary" size="sm" onClick={() => reidentify.mutate()} disabled={reidentify.isPending || !!pending} title={pending ? 'A request is already queued for this album' : 'Queue a fresh identification'}>
              {reidentify.isPending ? 'Queued…' : 'Re-identify'}
            </Button>
            {album.state !== 'matched' && (
              <Button
                variant="secondary"
                size="sm"
                onClick={() => fingerprint.mutate(albumId, { onSuccess: () => refresh(3000) })}
                disabled={fingerprint.isPending}
                title="Fingerprint the files (Chromaprint) and look them up on AcoustID — for albums whose tags are wrong or missing; needs an AcoustID key in Settings › Providers"
              >
                {fingerprint.isPending ? 'Queuing…' : fingerprint.isSuccess ? 'Fingerprint queued' : 'Fingerprint'}
              </Button>
            )}
            <Button variant="secondary" size="sm" onClick={() => fetchArt.mutate()} disabled={fetchArt.isPending}>
              {fetchArt.isPending ? 'Queued…' : album.coverUrl ? 'Refetch art' : 'Fetch art'}
            </Button>
            {album.state !== 'as_is' && (
              <Button variant="secondary" size="sm" onClick={() => keepAsIs.mutate()} disabled={keepAsIs.isPending} title="Keep the local tags; stop identifying">
                Keep as-is
              </Button>
            )}
            {album.state !== 'ignored' && (
              <Button variant="secondary" size="sm" onClick={() => ignore.mutate()} disabled={ignore.isPending} title="Hide from the queue and gap counts">
                Ignore
              </Button>
            )}
            <Button variant="secondary" size="sm" onClick={() => setEditingTags(true)} title="Set album artist, title, year, compilation or genre for every track at once; you preview before anything is written">
              Set album values…
            </Button>
            {libraryId && <AlbumMaintenanceActions libraryId={libraryId} album={album} />}
            {fingerprint.isError && <span className={styles.mbidError}>{errorDetail(fingerprint)}</span>}
          </div>
          {pending && (
            <div className={styles.pendingPanel} role="status">
              <span className={styles.pendingTitle}>{PENDING_KIND[pending.kind] ?? 'Identification'} queued</span>
              <span className={styles.pendingMeta}>
                {pending.pinned ? `${pending.pinned} · ` : ''}
                {pending.state === 'active' ? 'running now' : pending.state === 'retry' ? 'retrying' : pending.jobsAhead === 0 ? 'next in line' : `${pending.jobsAhead.toLocaleString()} ahead in the queue`}
                {' · '}since {new Date(pending.createdAt).toLocaleString()}
              </span>
              <Button variant="secondary" size="sm" onClick={() => cancelRequest.mutate()} disabled={cancelRequest.isPending || pending.state === 'active'} title={pending.state === 'active' ? 'Already running on the worker' : 'Remove this request from the queue'}>
                {cancelRequest.isPending ? 'Cancelling…' : 'Cancel'}
              </Button>
              {cancelRequest.isError && <span className={styles.mbidError}>Cancel failed</span>}
            </div>
          )}
          <div className={styles.mbidRow}>
            <input
              aria-label="Release URL or ID for manual matching"
              className={styles.mbidInput}
              placeholder={pending ? 'A request is queued — cancel it to submit another' : 'Paste a MusicBrainz or Discogs release URL / ID to match manually'}
              value={mbidInput}
              disabled={!!pending}
              onChange={(e) => setMbidInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && mbidInput.trim() && !pending) matchMbid.mutate();
              }}
            />
            <Button
              onClick={() => matchMbid.mutate()}
              disabled={!mbidInput.trim() || matchMbid.isPending || !!pending}
            >
              {matchMbid.isPending ? 'Queuing…' : 'Match'}
            </Button>
            {matchMbid.isError && (
              <span className={styles.mbidError}>
                {(matchMbid.error as { detail?: string; message?: string })?.detail ??
                  (matchMbid.error as Error)?.message ?? 'Failed'}
              </span>
            )}
            {matchMbid.isSuccess && !pending && <span className={styles.mbidOk}>Queued</span>}
          </div>
          </details>
        </div>
      </div>

      <nav ref={tabStrip} className={styles.tabs} aria-label="Album sections">
        {([
          ['album', 'Tracks'],
          ['care', `Library health${issueCount > 0 ? ` (${issueCount})` : ''}`],
          ['editions', 'Editions'],
          ['reviews', 'Reviews & listening'],
          ['activity', pending ? 'Activity ·' : 'Activity'],
        ] as const).map(([key, label]) => (
          <button key={key} className={`${styles.tab} ${tab === key ? styles.tabActive : ''}`} onClick={() => setTab(key)} aria-current={tab === key ? 'page' : undefined}>
            {label}
          </button>
        ))}
      </nav>

      {tab === 'care' && (<>
      {(shownOpenGaps.length > 0 || dismissedGaps.length > 0) && (
        <div className={styles.section}>
          <h2 className={styles.sectionTitle}>{issueCount > 0 ? `Needs attention (${issueCount})` : 'Hidden issues'}</h2>
          {shownOpenGaps.map((g) =>
            g.kind === 'quality' ? (
              <div key={g.id} className={styles.qualityGapGroup}>
                <div className={styles.qualityGapHeader}>
                  <div>
                    <h3 className={styles.qualityGapTitle}>Tags, artwork and files</h3>
                    <p className={styles.qualityGapNote}>Each row says what is wrong and what to do next. Hiding or marking as wrong applies to every row in this list.</p>
                  </div>
                  <span className={styles.gapActions}>
                    <Button variant="ghost" size="sm" onClick={() => dismissGap.mutate({ id: g.id, reason: 'not_interested' })} disabled={dismissGap.isPending} title="Stop showing these issues for this album. You can bring them back from the bottom of this list.">
                      {qualityFlags.length === 1 ? 'Hide this issue' : `Hide all ${qualityFlags.length} issues`}
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => dismissGap.mutate({ id: g.id, reason: 'wrong_data' })} disabled={dismissGap.isPending} title="Hide these issues and record that the checks got this album wrong, so they can be improved.">
                      {qualityFlags.length === 1 ? 'This is wrong' : 'These are wrong'}
                    </Button>
                  </span>
                </div>
                {qualityFlags.map((f) => (
                  <div key={f.key} className={styles.qualityFlag}>
                    <div className={styles.qualityFlagContent}>
                      <div className={styles.qualityFlagLabel}>
                        {f.title}
                        {f.count && <span className={styles.qualityFlagCount}> · {f.count}</span>}
                      </div>
                      <div className={styles.qualityFlagDetail}>{f.explain}</div>
                      {f.affected?.map((line) => <div key={line} className={styles.qualityFlagAffected}>{line}</div>)}
                    </div>
                    <div className={styles.qualityFlagAction}>
                      {f.action === 'art' && (
                        <Button variant="secondary" size="sm" onClick={() => fetchArt.mutate()} disabled={fetchArt.isPending || fetchArt.isSuccess} title={f.guidance}>
                          {fetchArt.isPending ? 'Queuing…' : fetchArt.isSuccess ? 'Art fetch queued' : 'Fetch art'}
                        </Button>
                      )}
                      {f.action === 'tags' && (
                        <LinkButton variant="secondary" size="sm" to="/plans" search={{ album: albumId }} title="Fix this album's tags in a new plan, or add it to a plan you have not applied yet">
                          Fix tags
                        </LinkButton>
                      )}
                      {f.action === 'split' && (
                        <Button variant="secondary" size="sm" onClick={openManage} title={f.guidance}>
                          Split by format
                        </Button>
                      )}
                      {!f.action && f.guidance && <span className={styles.qualityFlagHint}>{f.guidance}</span>}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              /* Other gaps: incomplete, duplicate, missing */
              <div key={g.id} className={styles.gapRow}>
                <span className={styles.gapKind}>{GAP_LABEL[g.kind] ?? g.kind}</span>
                <span className={styles.gapDetail}>{describeGap(g)}</span>
                <span className={styles.gapActions}>
                  <Button variant="ghost" size="sm" onClick={() => dismissGap.mutate({ id: g.id, reason: 'not_interested' })} disabled={dismissGap.isPending} title="Stop showing this issue for this album. You can bring it back below.">
                    Hide
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => dismissGap.mutate({ id: g.id, reason: 'wrong_data' })} disabled={dismissGap.isPending} title="Hide this issue and record that the check got this album wrong.">
                    This is wrong
                  </Button>
                </span>
              </div>
            ),
          )}
          {dismissedGaps.map((g) => (
            <div key={g.id} className={styles.gapRowDismissed}>
              <span className={styles.gapKind}>{g.kind === 'quality' ? 'Tags, artwork and files' : GAP_LABEL[g.kind] ?? g.kind}</span>
              <span className={styles.gapDetail}>
                {g.dismissReason === 'wrong_data' ? 'Hidden, marked as wrong' : 'Hidden by you'}
              </span>
              <span className={styles.gapActions}>
                <Button variant="ghost" size="sm" onClick={() => reopenGap.mutate(g.id)} disabled={reopenGap.isPending}>Show again</Button>
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

      {showCandidates && (
        <div className={styles.section}>
          <h2 className={styles.sectionTitle}>
            Match candidates ({visibleCandidates.length})
            {excludedCount > 0 && (
              <Button variant="quiet" size="sm" onClick={() => setShowExcluded((s) => !s)}>
                {showExcluded ? 'hide' : 'show'} {excludedCount} excluded
              </Button>
            )}
          </h2>
          <div className={styles.trackScroller}>
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
                        <Button
                          variant="secondary"
                          size="sm"
                          onClick={() => acceptCandidate.mutate(c.id)}
                          disabled={acceptCandidate.isPending}
                          title="Match this album to this release"
                        >
                          Accept
                        </Button>
                        <Button
                          variant="quiet"
                          size="sm"
                          onClick={() => excludeCandidate.mutate(c.id)}
                          disabled={excludeCandidate.isPending}
                          title="Never suggest this release again"
                        >
                          Exclude
                        </Button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        </div>
      )}

      {careEmpty && (
        <EmptyState
          title="Nothing needs attention"
          text="No missing tracks, no other copies of this album, and no problems found in its tags, artwork or files."
        />
      )}
      </>)}

      {tab === 'album' && (<>
      {album.tracks.length === 0 && <p className={styles.muted}>No track information is available for this album yet.</p>}
      <div className={styles.trackScroller}>
      <table className={styles.trackTable}>
        <thead>
          <tr>
            <th className={styles.num}>#</th>
            <th>Title</th>
            {trackArtists && <th>Artist</th>}
            <th className={styles.num}>Length</th>
            {album.release && <th className={styles.num}>Canonical</th>}
            <th>File</th>
          </tr>
        </thead>
        <tbody>
          {album.tracks.map((t, i) => (<Fragment key={t.id}>
            {/* multi-disc sets: one header row per disc (tracks arrive sorted by disc, then number) */}
            {(album.discCount ?? 1) > 1 && (i === 0 || (album.tracks[i - 1]?.discNo ?? 1) !== (t.discNo ?? 1)) && (
              <tr className={styles.discHeader}>
                <td colSpan={(album.release ? 5 : 4) + (trackArtists ? 1 : 0)}>Disc {t.discNo ?? 1}</td>
              </tr>
            )}
            <tr className={`${styles.trackRow} ${t.file.status === 'error' ? styles.trackError : ''}`}>
              <td className={`${styles.num} ${styles.trackNo}`}>
                {t.trackNo ?? '–'}
              </td>
              <td className={styles.trackTitle}>
                {t.title ?? '(untitled)'}
                {t.canonicalTitle && t.canonicalTitle !== t.title && (
                  <span className={styles.canonTitle}> → {t.canonicalTitle}</span>
                )}
              </td>
              {trackArtists && <td className={styles.trackArtist}>{t.artist?.trim() || album.artistCredit || '—'}</td>}
              <td className={`${durationDrift(t) ? styles.durDrift : styles.num} ${styles.trackLen}`}>
                {dur(t.durationMs)}
                {t.origin === 'cue' && t.cueStartMs !== null && (
                  <span> @ {dur(t.cueStartMs)}</span>
                )}
              </td>
              {album.release && (
                <td className={`${styles.num} ${styles.trackCanon}`} data-label="Canonical">{dur(t.canonicalDurationMs)}</td>
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
          </Fragment>))}
        </tbody>
      </table>
      </div>
      </>)}

      {tab === 'editions' && (
        <AlbumEditionsPanel
          hasReleaseGroup={!!album.releaseGroupId}
          editions={editions}
          onFetch={() => refreshEditions.mutate(albumId)}
          fetchPending={refreshEditions.isPending}
          tools={<>
            {album.match?.releaseGroupOnly && (
              <span className={`${styles.pill} ${styles.pillMuted}`}>any edition</span>
            )}
            {pending?.kind === 'mbid' && (
              <span className={styles.muted}>
                Switching edition — identification {pending.state === 'active' ? 'is running on the worker' : 'is queued'}; this page updates when it decides.
              </span>
            )}
            {switchEdition.isError && <span className={styles.mbidError}>{errorDetail(switchEdition)}</span>}
          </>}
          rowAction={(e) => (e.owned ? (
            <span className={styles.muted}>This copy</span>
          ) : (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => switchEdition.mutate(e.mbid)}
              disabled={switchEdition.isPending || !!pending}
              title={pending ? 'An identification request is already queued for this album — cancel it in the panel above first' : 'Re-match this album to this edition (queues a manual identification)'}
            >
              {switchingMbid === e.mbid ? 'Queuing…' : 'Use this edition'}
            </Button>
          ))}
          footer={album.match && (
            <div className={styles.sectionFoot}>
              <Button
                variant="quiet"
                size="sm"
                onClick={() => (album.match?.releaseGroupOnly ? clearAnyEdition.mutate(albumId) : matchAnyEdition.mutate(albumId))}
                disabled={matchAnyEdition.isPending || clearAnyEdition.isPending}
                title="Any edition: keep the release-group match without pinning one edition"
              >
                {album.match.releaseGroupOnly ? 'Clear' : 'Mark'} any edition
              </Button>
              {(matchAnyEdition.isError || clearAnyEdition.isError) && (
                <span className={styles.mbidError}> {errorDetail(matchAnyEdition.isError ? matchAnyEdition : clearAnyEdition)}</span>
              )}
            </div>
          )}
        />
      )}

      {tab === 'reviews' && (album.releaseGroupId ? (
        <ReviewsSection libraryId={libraryId} releaseGroupId={album.releaseGroupId} editions={editions?.editions} />
      ) : (
        <div className={styles.section}>
          <h2 className={styles.sectionTitle}>Reviews &amp; listening</h2>
          <p className={styles.muted}>
            Ratings, reviews and listens attach to a release group — match this album first.
          </p>
        </div>
      ))}

      {tab === 'activity' && (
        <div className={styles.section}>
          <h2 className={styles.sectionTitle}>What is going on with this album</h2>
          <dl className={styles.activity}>
            <dt>Identification</dt>
            <dd>
              {pending
                ? `${PENDING_KIND[pending.kind] ?? 'Identification'} ${pending.state === 'active' ? 'running on the worker now' : pending.state === 'retry' ? 'retrying' : pending.jobsAhead === 0 ? 'next in line' : `queued, ${pending.jobsAhead.toLocaleString()} ahead`} · since ${new Date(pending.createdAt).toLocaleString()}`
                : album.match
                  ? `${album.match.decidedBy === 'system' ? 'Auto-matched' : 'Matched by you'} at distance ${album.match.distance.toFixed(4)}${album.match.decidedAt ? ` on ${new Date(album.match.decidedAt).toLocaleString()}` : ''}${album.match.reason ? ` — ${album.match.reason}` : ''}`
                  : `${STATE_LABEL[album.state] ?? album.state}; nothing queued.`}
            </dd>
            <dt>Candidates</dt>
            <dd>{album.candidates.length} kept{excludedCount ? `, ${excludedCount} excluded` : ''} — see the Album face while unmatched.</dd>
            <dt>Cover art</dt>
            <dd>{album.coverUrl ? `present (${album.coverOrigin ?? 'unknown origin'})` : 'none yet — Fetch art queues a lookup'}</dd>
            <dt>Editions</dt>
            <dd>{editions ? (editions.fetchedAt ? `fetched ${new Date(editions.fetchedAt).toLocaleString()}` : editions.fetching ? 'fetching now' : 'not fetched') : 'open the Editions tab to see or fetch them'}</dd>
            <dt>Reviews</dt>
            <dd>fetched only on request from the Reviews tab (one call per source: CritiqueBrainz, MusicBrainz, Wikipedia, Discogs)</dd>
            <dt>Open gaps</dt>
            <dd>{openGaps.length ? openGaps.map((g) => GAP_LABEL[g.kind] ?? g.kind).join(', ') : 'none'}{dismissedGaps.length ? ` · ${dismissedGaps.length} dismissed` : ''}</dd>
            <dt>Folder</dt>
            <dd className={styles.dirPath}>{album.dirPaths?.join('\n')}</dd>
          </dl>
          <p className={styles.muted}>
            Library-wide progress: <Link to="/jobs">Jobs</Link> · <Link to="/identify">Identify</Link>.
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
      {editingTags && libraryId && (
        <BulkTagEditor
          libraryId={libraryId}
          scopes={editScopes}
          title={`Set album values · ${album.release?.title ?? album.title ?? 'this album'}`}
          onClose={() => setEditingTags(false)}
        />
      )}
    </div>
  );
}
