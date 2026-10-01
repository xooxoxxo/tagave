/**
 * Album page (spec BRW-2), shaped like a music app's album view (Roon,
 * Spotify, Qobuz): the album first — cover, title, artist, one quiet meta
 * line, a "⋯" menu — then the tracks. Upkeep stays out of sight unless
 * something needs a decision (see utils/albumAttention.ts); Maintenance
 * (maintenance.ts) reveals the state, provider links, every library issue,
 * the Manage menu and per-track marks.
 *
 * Faces: Tracks · Editions · About · Activity, kept in ?tab. The old
 * "Library health" face lives in the attention strip; its old links
 * (?tab=care) open the strip with Maintenance on.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { IdentifyRequestView } from '@liner/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams, useSearch } from '@tanstack/react-router';
import { useCurrentLibrary, useAlbumEditions, useRefreshEditions, useMatchAnyEdition, useClearAnyEdition, useAddAlbumToCollection, useInvalidatePhysical, isAlreadyOwned, type PreviousPhysicalLink } from '../hooks';
import { useMergeAlbums, useUnmergeAlbum } from '../hooks/useCompilations';
import { api } from '../services/api';
import { ReviewsSection } from '../components/ReviewsSection';
import { AlbumEditionsPanel } from './AlbumEditionsPanel';
import { useAlbumFolderActions } from '../components/AlbumMaintenanceActions';
import { BulkTagEditor, type EditScopeOption } from '../components/BulkTagEditor';
import { useFingerprintAlbum } from '../hooks/useFingerprint';
import { IdentifyRequestPanel, requestSummary } from '../components/IdentifyRequestPanel';
import { useMaintenance } from '../maintenance';
import { useBarTitle } from '../components/appBarTitle';
import { uniqueGenres } from '../utils/albumPresentation';
import { describeQualityFlag, type QualityIssue } from '../utils/qualityFlags';
import { GAP_KIND_LABEL, doneLabel, gapLine, qualityFlagOf, taskText, wrongFix, type WrongFix } from '../utils/gapTasks';
import { attentionItems, issuesTargetRow, requestKeyOf, trackDiscrepancies, type AlbumSearch, type AlbumTab, type AttentionItem } from '../utils/albumAttention';
import { GapChoices, ReopenGapButton } from '../components/GapChoices';
import { Button, Collapse, CoverArt, LinkButton, Menu, Tabs, tabIdFor, type MenuItem, confirmDialog, showToast, updateToast, dismissToast } from '../components/ui';
import { AlbumFolders } from './AlbumFolders';
import type { AlbumDetail, Gap } from './albumDetailTypes';
import { AlbumTracks } from './AlbumTracks';
import { AlbumAttention } from './AlbumAttention';
import { CandidateTable, TrackComparison } from './AlbumMatchTable';
import { STATE_LABEL, artPollMs, dur, totalLength } from './albumFormat';
import styles from './AlbumDetailPage.module.css';

const TABS: ReadonlyArray<readonly [AlbumTab, string]> = [
  ['tracks', 'Tracks'],
  ['editions', 'Editions'],
  ['about', 'About'],
  ['activity', 'Activity'],
];

const PANEL_MATCH_INPUT = 'manual-match-input';
/** the one panel the album's tab strip controls */
const TAB_PANEL_ID = 'album-section-panel';

const ROW_MATCH_INPUT = 'manual-match-input-row';

/** resolved tasks the owner already saw ("Got it"), per browser */
const ACK_KEY = 'tagave-acked-tasks';
function readAcked(): Set<string> {
  try {
    const raw = globalThis.localStorage?.getItem(ACK_KEY);
    const ids = raw ? (JSON.parse(raw) as unknown) : [];
    return new Set(Array.isArray(ids) ? ids.filter((x): x is string => typeof x === 'string') : []);
  } catch {
    return new Set();
  }
}
function writeAcked(ids: Set<string>) {
  try {
    globalThis.localStorage?.setItem(ACK_KEY, JSON.stringify([...ids].slice(-500)));
  } catch {
    // storage blocked: acknowledged for this visit only
  }
}

export function AlbumDetailPage() {
  const { albumId } = useParams({ strict: false }) as { albumId: string };
  const search = useSearch({ strict: false }) as AlbumSearch;
  const navigate = useNavigate();
  const { libraryId } = useCurrentLibrary();
  const queryClient = useQueryClient();
  const [maintenance, setMaintenance] = useMaintenance();
  const tab: AlbumTab = search.tab ?? 'tracks';
  const setTab = (next: AlbumTab) =>
    void navigate({ to: '/albums/$albumId', params: { albumId }, search: next === 'tracks' ? {} : { tab: next }, replace: true, resetScroll: false });

  const [showExcluded, setShowExcluded] = useState(false);
  const [mbidInput, setMbidInput] = useState('');
  const [manualOpen, setManualOpen] = useState(false);
  const [editingTags, setEditingTags] = useState(false);
  const [openRows, setOpenRows] = useState<Set<string>>(new Set());
  const [acked, setAcked] = useState<Set<string>>(readAcked);
  const [note, setNote] = useState<string | null>(null);
  // A note is a passing status ("3 tracks are now one album."): it goes by itself.
  useEffect(() => {
    if (!note) return;
    const t = setTimeout(() => setNote(null), 12000);
    return () => clearTimeout(t);
  }, [note]);
  /** the owner asked for cover art on this visit: say how the lookup ends */
  const [artAsked, setArtAsked] = useState(false);
  // read inside the query's refetchInterval, which is not re-created per render
  const artAskedRef = useRef(artAsked);
  artAskedRef.current = artAsked;
  const maintenanceRef = useRef(maintenance);
  maintenanceRef.current = maintenance;
  const toggleRow = (id: string) => setOpenRows((cur) => {
    const next = new Set(cur);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const refresh = (delayMs = 0) =>
    setTimeout(() => {
      queryClient.invalidateQueries({ queryKey: ['album', albumId] });
      queryClient.invalidateQueries({ queryKey: ['albums'] });
    }, delayMs);

  const { data: album, isLoading, isError, refetch } = useQuery({
    queryKey: ['album', albumId],
    queryFn: () => api.get<AlbumDetail>(`/libraries/${libraryId}/albums/${albumId}`),
    enabled: !!libraryId && !!albumId,
    // While a request is queued or running, ask again every few seconds: the
    // job can end without changing the album (a release group, an unknown
    // id), and then no queue event arrives to refresh the page.
    refetchInterval: (q) => {
      const r = (q.state.data as AlbumDetail | undefined)?.identifyRequest;
      const live = r ? r.status !== 'done' : !!(q.state.data as AlbumDetail | undefined)?.pendingIdentify;
      if (live) return 2500;
      // a cover-art lookup on its way: the page shows the art (or says none
      // was found) when it ends. Quickly when the owner is watching for it
      // (asked on this visit, or Maintenance shows the note); slowly for a
      // background sweep's job, which can sit in the queue for a long time.
      const art = (q.state.data as AlbumDetail | undefined)?.artFetch?.state;
      if (art === 'queued' || art === 'running') return artPollMs(artAskedRef.current, maintenanceRef.current);
      // a physical copy on its way to Discogs: "adding to Discogs…" clears itself
      return (q.state.data as AlbumDetail | undefined)?.discogsCollectionItems?.some((i) => i.pushState === 'pending') ? 5000 : false;
    },
  });
  // A finished request's note can be hidden; keyed by job so the next one shows.
  const [dismissedRequest, setDismissedRequest] = useState<string | null>(null);

  const { data: editions } = useAlbumEditions(libraryId, albumId, { enabled: tab === 'editions' || tab === 'about' });
  const refreshEditions = useRefreshEditions(libraryId);
  const matchAnyEdition = useMatchAnyEdition(libraryId);
  const clearAnyEdition = useClearAnyEdition(libraryId);
  const merge = useMergeAlbums(libraryId);
  const unmerge = useUnmergeAlbum(libraryId);
  const folder = useAlbumFolderActions(libraryId, album);

  const reidentify = useMutation({
    mutationFn: () => api.post(`/libraries/${libraryId}/albums/${albumId}/identify`),
    onSuccess: () => refresh(0),
  });
  const fetchArt = useMutation({
    mutationFn: () => api.post(`/libraries/${libraryId}/albums/${albumId}/fetch-art`),
    onSuccess: () => { setArtAsked(true); refresh(0); },
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
      setManualOpen(false);
      refresh(0); // the detail now carries pendingIdentify; SSE clears it when the job decides
    },
  });
  const cancelRequest = useMutation({
    mutationFn: () => api.post(`/libraries/${libraryId}/albums/${albumId}/identify-request/cancel`, {}),
    onSuccess: () => refresh(0),
  });
  // Switching edition is a manual identification request: it queues on the
  // worker and the detail carries pendingIdentify until the decision lands.
  const [switchingMbid, setSwitchingMbid] = useState<string | null>(null);
  const switchEdition = useMutation({
    mutationFn: (mbid: string) => {
      setSwitchingMbid(mbid);
      return api.post(`/libraries/${libraryId}/albums/${albumId}/match-mbid`, { input: mbid });
    },
    onSuccess: () => refresh(0),
    onSettled: () => setSwitchingMbid(null),
  });
  const addPhysical = useAddAlbumToCollection(libraryId, albumId);
  const invalidatePhysical = useInvalidatePhysical(libraryId);
  // a second click while the first is on its way does nothing (the server
  // also answers a repeat with the same item)
  const addingPhysical = useRef(false);
  const fingerprint = useFingerprintAlbum(libraryId);

  // ?issues links (tasks, the attention list, old "Library health" links):
  // Maintenance on, the strip open at the row the link is about.
  const [pendingIssues, setPendingIssues] = useState<true | string | undefined>(search.issues);
  useEffect(() => {
    if (!search.issues) return;
    setMaintenance(true);
    setPendingIssues(search.issues);
    void navigate({ to: '/albums/$albumId', params: { albumId }, search: search.tab ? { tab: search.tab } : {}, replace: true, resetScroll: false });
  }, [search.issues]); // eslint-disable-line react-hooks/exhaustive-deps

  const title = album ? album.release?.title ?? album.title ?? 'Untitled' : null;
  const titleRef = useBarTitle(title);

  const pending = album?.pendingIdentify ?? null;
  // The request as it really stands (API ≥ 0.4.2); an older API sends only
  // the live job, which is shaped into the same view.
  const request: IdentifyRequestView | null = album?.identifyRequest !== undefined
    ? album.identifyRequest ?? null
    : pending
      ? {
          status: pending.state === 'active' ? 'running' : pending.state === 'retry' ? 'retrying' : 'queued',
          jobId: pending.id, kind: pending.kind, pinned: pending.pinned, createdAt: pending.createdAt,
          startedAt: pending.startedAt, jobsAhead: pending.jobsAhead, outcome: null,
        }
      : null;
  const requestLive = !!request && request.status !== 'done';

  const allItems = useMemo(() => (album ? attentionItems({
    state: album.state,
    merged: album.merged,
    mixed: album.mixed,
    mergeCandidates: album.mergeCandidates,
    candidates: album.candidates,
    gaps: album.gaps,
    missingTracks: album.missingTracks,
    duplicates: album.duplicates,
    tracks: album.tracks,
    hasRelease: !!album.release,
    match: album.match,
  }, { request, dismissedRequestKey: dismissedRequest, ackedTaskIds: acked }) : []), [album, request, dismissedRequest, acked]);
  const items = maintenance ? allItems : allItems.filter((i) => i.interrupts);

  useEffect(() => {
    if (!pendingIssues || !album) return;
    const target = issuesTargetRow(allItems, pendingIssues);
    if (target) setOpenRows((cur) => new Set(cur).add(target.id));
    setPendingIssues(undefined);
  }, [pendingIssues, album, allItems]);

  /** the API's problem+json `detail` is the message the owner should read */
  const errorDetail = (m: { error: unknown }): string | null =>
    (m.error as { detail?: string } | null)?.detail ?? (m.error as Error | null)?.message ?? null;

  if (isError) return <div className={styles.container} role="alert"><h1>Couldn’t load this album</h1><p>Try again, or return to your library.</p><Button onClick={() => void refetch()}>Try again</Button><Link to="/albums">Back to albums</Link></div>;
  if (isLoading || !album) return <div className={styles.container}><p className={styles.muted}>Loading album…</p></div>;

  const openGaps = album.gaps.filter((g) => g.state === 'open');
  const excludedCount = album.candidates.filter((c) => c.excluded).length;
  const openFlags: Record<string, unknown> = {};
  for (const g of openGaps) {
    const f = g.kind === 'quality' ? qualityFlagOf(g) : null;
    if (f) openFlags[f.key] = f.value;
  }
  const qualityIssue = (g: Gap): QualityIssue | null => {
    const f = qualityFlagOf(g);
    return f ? describeQualityFlag(f.key, f.value, openFlags, { mixed: album.mixed }) : null;
  };
  const gapById = new Map(album.gaps.map((g) => [g.id, g]));
  const taskSubject = { title: album.release?.title ?? album.title, folder: album.dirPaths?.[0] ?? null };
  const shortDate = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '');
  const genreLabels = uniqueGenres(album.genres?.effective, album.genres?.styles, album.release?.genres, album.release?.styles);
  const albumArtist = album.artists?.length
    ? album.artists.map((a) => a.name).join(', ')
    : Array.isArray(album.release?.artistCredit) ? album.release.artistCredit.join(', ') : album.release?.artistCredit ?? album.artistCredit;
  const year = (album.release?.date ?? '').slice(0, 4) || (album.year ? String(album.year) : '');
  const trackCountText = album.trackCount == null ? null : album.isCueImage
    ? `${album.trackCount} audio ${album.trackCount === 1 ? 'file' : 'files'} (CUE image)`
    : `${album.trackCount} ${album.trackCount === 1 ? 'track' : 'tracks'}`;
  const meta = [year, trackCountText, totalLength(album.totalDurationMs)].filter(Boolean).join(' · ');
  const discrepancies = trackDiscrepancies(album.tracks);
  const showCandidates = album.candidates.length > 0 && album.state !== 'matched';
  const ownsPhysical = (album.discogsCollectionItems?.length ?? 0) > 0;
  const physicalFormats = [...new Set((album.discogsCollectionItems ?? []).map((i) => i.format).filter(Boolean))].join(' and ');
  const physicalPending = (album.discogsCollectionItems ?? []).some((i) => i.pushState === 'pending');
  const canOwnPhysical = !!(album.release?.discogsReleaseId || album.releaseGroupId);

  // "I own this on vinyl/CD": the album shows the copy at once (optimistic),
  // a toast says what happened and offers Undo, and a copy already in the
  // collection asks before adding a second one.
  // Undo takes the copy off the album at once; the server agrees (a copy on
  // its way out of Discogs no longer counts), so the refetch keeps it off.
  // A copy that was already in the collection is unlinked, not removed.
  const undoPhysical = async (itemId: string, previous?: PreviousPhysicalLink) => {
    const key = ['album', albumId];
    const before = queryClient.getQueryData<AlbumDetail>(key);
    if (before) {
      queryClient.setQueryData<AlbumDetail>(key, {
        ...before,
        discogsCollectionItems: (before.discogsCollectionItems ?? []).filter((i) => i.id !== itemId),
      });
    }
    const t = showToast({ message: previous ? 'Unlinking it again…' : 'Removing it again…', durationMs: 0 });
    try {
      if (previous) await api.post(`/collection-items/${itemId}/restore-link`, previous);
      else await api.delete(`/collection-items/${itemId}`);
      updateToast(t, { message: previous ? 'Unlinked: the copy stays in your collection' : 'Removed from your physical collection', durationMs: 5000 });
    } catch (err) {
      if (before) queryClient.setQueryData(key, before);
      updateToast(t, { message: `Could not undo: ${(err as { detail?: string })?.detail ?? 'the server did not answer'}`, tone: 'danger', durationMs: 10000 });
    } finally {
      invalidatePhysical();
    }
  };
  const ownPhysical = async (anotherCopy = false) => {
    if (addingPhysical.current) return;
    addingPhysical.current = true;
    const key = ['album', albumId];
    const prev = queryClient.getQueryData<AlbumDetail>(key);
    if (prev) {
      queryClient.setQueryData<AlbumDetail>(key, {
        ...prev,
        discogsCollectionItems: [...(prev.discogsCollectionItems ?? []), { id: `pending-${Date.now()}`, folder: 'Uncategorized', pushState: 'pending' }],
      });
    }
    const t = showToast({ message: anotherCopy ? 'Adding another copy…' : 'Adding to your physical collection…', durationMs: 0 });
    try {
      const discogsReleaseId = album.release?.discogsReleaseId;
      const res = await addPhysical.mutateAsync({ ...(discogsReleaseId ? { discogsReleaseId } : {}), ...(anotherCopy ? { anotherCopy: true } : {}) });
      updateToast(t, {
        message: res.linkedExisting
          ? 'Linked the copy already in your collection'
          : res.created ? 'Added to your physical collection' : 'Already added: it is in your physical collection',
        action: { label: 'Undo', onClick: () => void undoPhysical(res.itemId, res.linkedExisting ? res.previous : undefined) },
        durationMs: 10000,
      });
    } catch (err) {
      if (prev) queryClient.setQueryData(key, prev);
      if (isAlreadyOwned(err)) {
        dismissToast(t);
        addingPhysical.current = false;
        const formats = [...new Set(err.existing.map((e) => e.format).filter(Boolean))].join(' and ');
        const ok = await confirmDialog({
          title: `You already have this${formats ? ` on ${formats}` : ''}. Add another copy?`,
          message: 'Add another copy only if you really own two. Each copy is its own item in your Discogs collection.',
          confirmLabel: 'Add another copy',
        });
        if (ok) await ownPhysical(true);
        return;
      }
      updateToast(t, { message: `Could not add it: ${(err as { detail?: string })?.detail ?? 'the server did not answer'}`, tone: 'danger', durationMs: 12000 });
    } finally {
      addingPhysical.current = false;
    }
  };
  const physicalMenuItem: MenuItem[] = !ownsPhysical && canOwnPhysical
    ? [{ key: 'own', label: addPhysical.isPending ? 'Adding…' : 'I own this on vinyl/CD', hint: 'Adds it to your physical collection and Discogs', disabled: addPhysical.isPending, onSelect: () => void ownPhysical() }]
    : [];

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

  // ---- actions ----

  const onMerge = async () => {
    const candidates = album.mergeCandidates ?? [];
    setNote(null);
    try {
      const r = await merge.mutateAsync({ albumIds: [album.id, ...candidates.map((c) => c.id)], targetId: album.id });
      setNote(`${r.files} tracks are now one album.${r.identifyQueued ? ' Identification is queued with every track in view.' : ''}`);
    } catch (e) {
      setNote((e as { detail?: string })?.detail ?? 'The albums could not be merged.');
    }
  };
  const onUnmerge = async () => {
    if (!(await confirmDialog({ title: 'Split this album back?', message: 'It goes back to the albums it was made from. Nothing on disk changes.', confirmLabel: 'Split back' }))) return;
    setNote(null);
    try {
      const r = await unmerge.mutateAsync(album.id);
      setNote(`Splitting back: ${r.folders} folder${r.folders === 1 ? '' : 's'} regroup in a few seconds.`);
    } catch (e) {
      setNote((e as { detail?: string })?.detail ?? 'The album could not be split back.');
    }
  };
  // The manual match input lives in two places: the panel under the header,
  // and inside an open "Choose a match" row. Each has its own id; when that
  // row is already open, "Match to a release…" goes to its input instead of
  // opening a second one.
  const matchRowOpen = items.some((i) => (i.kind === 'review' || i.kind === 'unmatched') && openRows.has(i.id));
  const openManual = () => {
    if (matchRowOpen) {
      requestAnimationFrame(() => document.getElementById(ROW_MATCH_INPUT)?.focus());
      return;
    }
    setManualOpen(true);
    requestAnimationFrame(() => document.getElementById(PANEL_MATCH_INPUT)?.focus({ preventScroll: true }));
  };

  const onAction = (item: AttentionItem) => {
    const a = item.action;
    if (!a) return;
    switch (a.do) {
      case 'merge': void onMerge(); break;
      case 'unmerge': void onUnmerge(); break;
      case 'cancel-request': cancelRequest.mutate(); break;
      case 'dismiss-request': setDismissedRequest(requestKeyOf(request)); break;
      case 'ack-tasks': {
        const next = new Set(acked);
        for (const id of item.gapIds ?? []) next.add(id);
        writeAcked(next);
        setAcked(next);
        break;
      }
      case 'editions': setTab('editions'); break;
      case 'art': fetchArt.mutate(); break;
      case 'tags': void navigate({ to: '/plans', search: { album: albumId } }); break;
      case 'split': if (item.id) setOpenRows((cur) => new Set(cur).add(item.id)); break;
      case 'expand': toggleRow(item.id); break;
    }
  };
  const busy = (item: AttentionItem) =>
    (item.action?.do === 'merge' && merge.isPending)
    || (item.action?.do === 'unmerge' && unmerge.isPending)
    || (item.action?.do === 'cancel-request' && cancelRequest.isPending)
    || (item.action?.do === 'art' && fetchArt.isPending);

  const missingList = album.missingTracks.length > 0 && (
    <table className={styles.missingTable}>
      <tbody>
        {album.missingTracks.map((m, i) => (
          <tr key={i}>
            <td className={`${styles.num} ${styles.missingNo}`}>
              {(album.discCount ?? 1) > 1 ? `${m.disc}-` : ''}
              {m.position}
            </td>
            <td className={styles.missingTitle}>{m.title}</td>
            <td className={`${styles.num} ${styles.missingLen}`}>{dur(m.lengthMs)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );

  const manualMatch = (inputId: string) => (
    <div className={styles.mbidRow}>
      <input
        id={inputId}
        aria-label="Release URL or ID for manual matching"
        className={styles.mbidInput}
        placeholder={requestLive ? 'A request is queued — cancel it to submit another' : 'MusicBrainz release or release-group link / ID, or a Discogs release link'}
        value={mbidInput}
        disabled={requestLive}
        onChange={(e) => setMbidInput(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && mbidInput.trim() && !requestLive) matchMbid.mutate();
          if (e.key === 'Escape') setManualOpen(false);
        }}
      />
      <Button variant="secondary" onClick={() => matchMbid.mutate()} disabled={!mbidInput.trim() || matchMbid.isPending || requestLive}>
        {matchMbid.isPending ? 'Queuing…' : 'Match'}
      </Button>
      {matchMbid.isError && <span className={styles.mbidError}>{errorDetail(matchMbid) ?? 'Failed'}</span>}
    </div>
  );

  /** The way to put right a gap marked as wrong. */
  const wrongFixAction = (fix: WrongFix) => {
    if (fix.action === 'editions') return <Button variant="quiet" size="sm" onClick={() => setTab('editions')}>{fix.actionLabel}</Button>;
    if (fix.action === 'reidentify') {
      return (
        <Button variant="quiet" size="sm" onClick={() => reidentify.mutate()} disabled={reidentify.isPending || requestLive}>
          {reidentify.isPending ? 'Queued…' : fix.actionLabel}
        </Button>
      );
    }
    if (fix.action === 'follow-rules') return <LinkButton variant="quiet" size="sm" to="/settings/$section" params={{ section: 'following' }}>{fix.actionLabel}</LinkButton>;
    return null;
  };

  const duplicatesList = album.duplicates.length > 0 && (
    <ul className={styles.plainList}>
      {album.duplicates.map((d) => (
        <li key={d.id}>
          <Link to="/albums/$albumId" params={{ albumId: d.id }}>{d.title ?? 'Untitled'}</Link>
          <span className={styles.muted}> · {[d.formats?.join('/'), `${d.trackCount} tracks`, STATE_LABEL[d.state] ?? d.state].filter(Boolean).join(' · ')}</span>
          {d.dirPaths?.[0] && <span className={styles.pathLine}>{d.dirPaths[0]}</span>}
        </li>
      ))}
    </ul>
  );

  const rowBody = (item: AttentionItem): ReactNode => {
    const gaps = (item.gapIds ?? []).map((id) => gapById.get(id)).filter((g): g is Gap => !!g);
    const g = gaps[0];
    switch (item.kind) {
      case 'request':
        return request ? (
          <IdentifyRequestPanel
            request={request}
            onCancel={() => cancelRequest.mutate()}
            cancelling={cancelRequest.isPending}
            cancelError={cancelRequest.isError ? (errorDetail(cancelRequest) ?? 'Cancel failed') : null}
            onPick={(mbid) => switchEdition.mutate(mbid)}
            picking={switchingMbid}
            pickError={switchEdition.isError ? errorDetail(switchEdition) : null}
            {...(requestLive ? {} : { onDismiss: () => setDismissedRequest(requestKeyOf(request)) })}
          />
        ) : null;
      case 'review':
      case 'unmatched':
        return (
          <div className={styles.stack}>
            <CandidateTable
              candidates={album.candidates}
              localTrackCount={album.trackCount}
              localTracks={album.tracks}
              showExcluded={showExcluded}
              onToggleExcluded={() => setShowExcluded((s) => !s)}
              onAccept={(id) => acceptCandidate.mutate(id)}
              onExclude={(id) => excludeCandidate.mutate(id)}
              busy={acceptCandidate.isPending || excludeCandidate.isPending}
            />
            <div>
              <p className={styles.hint}>Not listed? Paste the release you have.</p>
              {manualMatch(ROW_MATCH_INPUT)}
            </div>
          </div>
        );
      case 'merge':
        return (
          <div className={styles.stack}>
            <p className={styles.bodyText}>
              {(album.mergeCandidates?.length ?? 0) === 1 ? 'Another album is' : 'Other albums are'} called “{album.title}” with tracks that fit this one: no track number twice.
              Treating them as one album moves nothing on disk, survives rescans and can be split back.
            </p>
            <ul className={styles.plainList}>
              {(album.mergeCandidates ?? []).map((c) => (
                <li key={c.id}>
                  <Link to="/albums/$albumId" params={{ albumId: c.id }}>{c.artist ?? 'Unknown artist'}</Link>
                  <span className={styles.muted}> · {c.trackCount ?? 0} track{c.trackCount === 1 ? '' : 's'}</span>
                  {c.dirPaths[0] && <span className={styles.pathLine}>{c.dirPaths[0]}</span>}
                </li>
              ))}
            </ul>
            <div className={styles.inlineActions}>
              <Button variant="quiet" size="sm" onClick={() => setEditingTags(true)}>Set album values instead</Button>
            </div>
          </div>
        );
      case 'merged':
        return (
          <div className={styles.stack}>
            <p className={styles.bodyText}>These tracks were treated as one album; the files stay where they are.</p>
            <div className={styles.inlineActions}><Button variant="quiet" size="sm" onClick={() => setEditingTags(true)}>Set album values</Button></div>
          </div>
        );
      case 'task-done':
        return (
          <ul className={styles.plainList}>
            {gaps.map((t) => (
              <li key={t.id}>
                <span className={styles.taskDoneText}>{taskText(t, taskSubject)}</span>
                <span className={styles.muted}> · {doneLabel({ resolvedAt: t.resolvedAt ?? null, subjectGone: false })}</span>
              </li>
            ))}
          </ul>
        );
      case 'gap':
        if (!g) return null;
        return (
          <div className={`${styles.stack} ${styles.gapBody}`}>
            <p className={styles.bodyText}>{gapLine(g, { all: openFlags, mixed: album.mixed })}.</p>
            {g.kind === 'incomplete_album' && missingList}
            {g.kind === 'duplicate' && duplicatesList}
            <GapChoices compact gapId={g.id} subject={GAP_KIND_LABEL[g.kind] ?? g.kind} onDecided={() => refresh()} />
          </div>
        );
      case 'missing':
        return (
          <div className={`${styles.stack} ${styles.gapBody}`}>
            <p className={styles.bodyText}>The choices appear after the next gap check, which runs after a scan finds new files and every night.</p>
            {missingList}
          </div>
        );
      case 'quality': {
        if (!g) return null;
        const f = qualityIssue(g);
        if (!f) return null;
        return (
          <div className={`${styles.stack} ${styles.gapBody}`}>
            <p className={styles.bodyText}>{f.explain}{f.guidance && <> {f.guidance}</>}</p>
            {f.affected?.map((line) => <div key={line} className={styles.affected}>{line}</div>)}
            {f.action === 'split' && (
              <div className={styles.inlineActions}>
                <Button variant="secondary" size="sm" onClick={() => void folder.split('lossless')} disabled={folder.busy}>Split off lossy copies</Button>
                <Button variant="quiet" size="sm" onClick={() => void folder.split('lossy')} disabled={folder.busy}>…or split off lossless</Button>
              </div>
            )}
            <GapChoices compact gapId={g.id} subject={f.title} onDecided={() => refresh()} />
          </div>
        );
      }
      case 'duplicates':
        return duplicatesList;
      case 'lengths':
        return <TrackComparison tracks={album.tracks} onlyDifferences />;
      case 'tasks':
        return (
          <ul className={styles.taskList}>
            {gaps.map((t) => {
              const f = t.kind === 'quality' ? qualityIssue(t) : null;
              return (
                <li key={t.id}>
                  <div>
                    <span className={styles.taskText}>{taskText(t, taskSubject)}</span>
                    <span className={styles.muted}> · added {shortDate(t.acceptedAt)}{t.note ? ` · ${t.note}` : ''}</span>
                  </div>
                  <div className={styles.inlineActions}>
                    {f?.action === 'tags' && <LinkButton variant="quiet" size="sm" to="/plans" search={{ album: albumId }}>Fix tags</LinkButton>}
                    {f?.action === 'art' && <Button variant="quiet" size="sm" onClick={() => fetchArt.mutate()} disabled={fetchArt.isPending}>Fetch art</Button>}
                    <ReopenGapButton gapId={t.id} onDecided={() => refresh()} title="Take it off your task list; it shows as an issue again">Remove from tasks</ReopenGapButton>
                  </div>
                </li>
              );
            })}
            <li className={styles.taskFoot}><LinkButton variant="quiet" size="sm" to="/work" search={{ tab: 'tasks' }}>All tasks</LinkButton></li>
          </ul>
        );
      case 'hidden':
        return (
          <ul className={styles.taskList}>
            {gaps.map((h) => {
              const wrong = h.dismissReason === 'wrong_data';
              const fix = wrong ? wrongFix(h) : null;
              const f = h.kind === 'quality' ? qualityFlagOf(h) : null;
              const label = f ? describeQualityFlag(f.key, f.value).title : GAP_KIND_LABEL[h.kind] ?? h.kind;
              return (
                <li key={h.id}>
                  <div>
                    <span className={styles.taskText}>{label}</span>
                    <span className={styles.muted}> · {wrong ? 'you marked this as wrong' : 'not a problem, hidden by you'}</span>
                    {fix && <p className={styles.hint}>{fix.text}</p>}
                  </div>
                  <div className={styles.inlineActions}>
                    {fix && wrongFixAction(fix)}
                    <ReopenGapButton gapId={h.id} onDecided={() => refresh()}>Show again</ReopenGapButton>
                  </div>
                </li>
              );
            })}
          </ul>
        );
      default:
        return null;
    }
  };

  // ---- the "⋯" menu ----

  const menuItems: MenuItem[] = maintenance ? [
    { key: 'reidentify', label: reidentify.isPending ? 'Queuing…' : 'Re-identify', hint: requestLive ? 'A request is already queued' : 'Look this album up again', disabled: requestLive || reidentify.isPending, onSelect: () => reidentify.mutate() },
    { key: 'manual', label: 'Match to a release…', hint: 'Paste a MusicBrainz or Discogs link', disabled: requestLive, onSelect: openManual },
    ...(album.state !== 'matched' ? [{ key: 'fp', label: 'Fingerprint', hint: 'Identify by sound (AcoustID)', disabled: fingerprint.isPending, onSelect: () => fingerprint.mutate(albumId, { onSuccess: () => { setNote('Fingerprinting queued.'); refresh(3000); } }) }] : []),
    { key: 'art', label: album.coverUrl ? 'Refetch cover art' : 'Fetch cover art', disabled: fetchArt.isPending, onSelect: () => fetchArt.mutate() },
    { key: 'values', label: 'Set album values…', hint: 'Artist, title, year, genre for every track', onSelect: () => setEditingTags(true) },
    ...(album.match ? [{ key: 'any', label: album.match.releaseGroupOnly ? 'Pin one edition again' : 'Accept any edition', hint: 'Keep the release group without one edition', onSelect: () => (album.match?.releaseGroupOnly ? clearAnyEdition.mutate(albumId) : matchAnyEdition.mutate(albumId)) }] : []),
    { key: 'rescan', label: 'Rescan folder', separated: true, disabled: !folder.canRescan || folder.busy, onSelect: () => void folder.rescan() },
    ...(folder.canSplit ? [
      { key: 'split-lossy', label: 'Split off lossy copies', hint: 'Lossless stays here', disabled: folder.busy, onSelect: () => void folder.split('lossless') },
      { key: 'split-lossless', label: 'Split off lossless copies', hint: 'Lossy stays here', disabled: folder.busy, onSelect: () => void folder.split('lossy') },
    ] : []),
    ...(folder.canMergeBack ? [{ key: 'merge-back', label: 'Merge back', hint: 'Return these files to the album they came from', disabled: folder.busy, onSelect: () => void folder.mergeBack() }] : []),
    ...physicalMenuItem,
    ...(ownsPhysical && canOwnPhysical ? [{ key: 'own-more', label: 'Add another physical copy', hint: 'Only if you own two', disabled: addPhysical.isPending, onSelect: () => void ownPhysical(true) }] : []),
    ...(album.state !== 'as_is' ? [{ key: 'asis', label: 'Keep as-is', hint: 'Keep your tags; stop identifying', separated: true, disabled: keepAsIs.isPending, onSelect: () => keepAsIs.mutate() }] : []),
    ...(album.state !== 'ignored' ? [{ key: 'ignore', label: 'Ignore', hint: 'Leave out of the queue and gap counts', separated: album.state === 'as_is', disabled: ignore.isPending, onSelect: () => ignore.mutate() }] : []),
    { key: 'mode', label: 'Turn off Maintenance', separated: true, onSelect: () => setMaintenance(false) },
  ] : [
    ...physicalMenuItem,
    { key: 'mode', label: 'Turn on Maintenance', separated: physicalMenuItem.length > 0, hint: 'Show match state, library issues and tools', onSelect: () => setMaintenance(true) },
  ];

  // The cover-art lookup as it really stands (not a fixed "queued" line):
  // live while the job is queued or running, then gone when the art lands,
  // or a plain "none found" when the lookup came back empty.
  const artState = album.artFetch?.state;
  const artLive = artState === 'queued' || artState === 'running';
  const artNote: { text: string; live: boolean } | null =
    artLive && (artAsked || maintenance) ? { text: artState === 'running' ? 'Looking for cover art…' : 'Cover art lookup queued…', live: true }
      : artAsked && !album.coverUrl && artState === 'done' ? { text: 'No cover art found: none in the files or the folder, and none on Cover Art Archive or Discogs.', live: false }
        : artAsked && artState === 'failed' ? { text: 'The cover art lookup failed. Try again from the ⋯ menu.', live: false }
          : null;
  const plainNote = note ?? folder.note ?? (fingerprint.isError ? errorDetail(fingerprint) : null)
    ?? (reidentify.isError ? errorDetail(reidentify) : null) ?? (fetchArt.isError ? errorDetail(fetchArt) : null);
  const statusNote: { text: string; live: boolean } | null = artNote ?? (plainNote ? { text: plainNote, live: false } : null);
  const dismissNote = () => { setNote(null); setArtAsked(false); };

  const facts: Array<[string, ReactNode]> = [
    ['Released', album.release?.date ?? (album.year ? String(album.year) : null)],
    ['Label', album.release?.labels?.length ? album.release.labels.map((l) => (l.catno ? `${l.name} · ${l.catno}` : l.name)).join(', ') : null],
    ['Country', album.release?.country ?? null],
    ['Tracks', [trackCountText, album.discCount && album.discCount > 1 ? `${album.discCount} discs` : null, dur(album.totalDurationMs)].filter(Boolean).join(' · ')],
    ['Format', album.formats?.join(', ') || null],
    ['Genres & styles', genreLabels.join(', ') || null],
    ['Physical copy', ownsPhysical ? album.discogsCollectionItems!.map((i) => [i.format, i.folder, i.mediaCondition && `media ${i.mediaCondition}`, i.sleeveCondition && `sleeve ${i.sleeveCondition}`, i.pushState === 'pending' ? 'adding to Discogs…' : i.pushState === 'failed' ? `failed: ${i.pushError}` : null].filter(Boolean).join(' · ')).join('; ') : null],
    ['Local folder', album.dirPaths?.length ? <AlbumFolders folders={album.folders ?? album.dirPaths.map((path) => ({ path, scanRootId: null, link: null }))} /> : null],
    ...(maintenance ? [
      ['Identification', album.match ? `${album.match.decidedBy === 'system' ? 'Automatic match' : 'Matched by you'}${album.match.decidedAt ? ` on ${new Date(album.match.decidedAt).toLocaleDateString()}` : ''}` : 'No release matched'] as [string, ReactNode],
      ['Artwork source', album.coverOrigin ?? null] as [string, ReactNode],
    ] : []),
    ['CUE sheet', album.isCueImage ? album.cueRelPath || 'CUE image album' : null],
  ];

  return (
    <div className={styles.page}>
      <header className={styles.heroBand}>
        {/* The cover's own colours behind the whole header, edge to edge of
            the pane and up behind the back button, fading into the page. */}
        <div className={styles.backdropFrame} aria-hidden="true">
          <div className={album.coverUrl ? styles.backdrop : styles.backdropPlain} style={album.coverUrl ? { backgroundImage: `url("${album.coverUrl}")` } : undefined} />
        </div>
        <div className={styles.hero}>
          <div className={styles.coverBox}>
            <CoverArt src={album.coverUrl} title={title ?? 'Untitled'} loading="eager" className={styles.cover} />
          </div>
          <div className={styles.headInfo}>
            <h1 ref={titleRef} className={styles.title}>{title}</h1>
            <div className={styles.artist}>
              {album.artists && album.artists.length > 0
                ? album.artists.map((artist, idx) => (
                  <span key={artist.id}>
                    <Link to="/artists/$artistId" params={{ artistId: artist.id }}>{artist.name}</Link>
                    {idx < album.artists!.length - 1 && ', '}
                  </span>
                ))
                : albumArtist ?? 'Unknown artist'}
            </div>
            {meta && <p className={styles.metaRow}>{meta}</p>}
            {/* One line: what the album is (a physical copy; in Maintenance
                its state, then its provider pages), and "⋯" trailing it. */}
            <div className={styles.headTools}>
              {(ownsPhysical || maintenance) && (
                <div className={styles.statusLine}>
                  {ownsPhysical && (
                    <Link className={styles.physicalChip} to="/collection" title="In your physical collection">
                      <span className={styles.physicalDot} aria-hidden="true" />
                      Physical{physicalFormats ? ` · ${physicalFormats}` : ''}
                    </Link>
                  )}
                  {physicalPending && <span className={styles.physicalNote}>adding to Discogs…</span>}
                  {maintenance && (<>
                    <span className={`${styles.pill} ${styles[`state_${album.state}`] ?? ''}`}>{STATE_LABEL[album.state] ?? album.state}</span>
                    {album.match?.releaseGroupOnly && (
                      <Button variant="quiet" size="sm" title="Matched to the release group, not one edition — click to pin one again" onClick={() => clearAnyEdition.mutate(albumId)}>Any edition ✕</Button>
                    )}
                    {album.release?.sourceOfTruth === 'discogs' && !album.release?.mbid && <span className={`${styles.pill} ${styles.pillMuted}`}>Discogs only</span>}
                    {album.release?.mbid && <a className={styles.pillLink} href={`https://musicbrainz.org/release/${album.release.mbid}`} target="_blank" rel="noreferrer">MusicBrainz ↗</a>}
                    {album.release?.discogsReleaseId && <a className={styles.pillLink} href={`https://www.discogs.com/release/${album.release.discogsReleaseId}`} target="_blank" rel="noreferrer">Discogs ↗</a>}
                    {album.release?.discogsMasterId && <a className={styles.pillLink} href={`https://www.discogs.com/master/${album.release.discogsMasterId}`} target="_blank" rel="noreferrer">Master ↗</a>}
                  </>)}
                </div>
              )}
              {/* the primary slot is for Play once a player exists; nothing pretends to play until then */}
              <div className={styles.actionRow}>
                <Menu label={maintenance ? 'Manage this album' : 'More for this album'} heading={maintenance ? 'Manage' : undefined} items={menuItems} />
              </div>
            </div>
            {/* a passing status: quiet, inline, gone when the thing it is about is done */}
            <div className={styles.statusSlot} role="status" aria-live="polite">
              {statusNote && (
                <p className={styles.statusNote}>
                  {statusNote.live && <span className={styles.statusSpinner} aria-hidden="true" />}
                  <span>{statusNote.text}</span>
                  {!statusNote.live && (
                    <button type="button" className={styles.statusDismiss} onClick={dismissNote} aria-label="Dismiss">✕</button>
                  )}
                </p>
              )}
            </div>
          </div>
        </div>
      </header>

      <div className={styles.container}>

      <Collapse open={manualOpen && !matchRowOpen}>
        <div className={styles.manualPanel}>
          <div className={styles.manualHead}>
            <span className={styles.manualTitle}>Match to a release</span>
            <Button variant="quiet" size="sm" onClick={() => setManualOpen(false)}>Close</Button>
          </div>
          {manualMatch(PANEL_MATCH_INPUT)}
        </div>
      </Collapse>

      <AlbumAttention
        label={maintenance ? 'Library issues for this album' : 'Needs your decision'}
        items={items}
        open={openRows}
        onToggle={toggleRow}
        onAction={onAction}
        body={rowBody}
        busy={busy}
      />

      <Tabs
        label="Album sections"
        panelId={TAB_PANEL_ID}
        value={tab}
        onChange={(next) => setTab(next as AlbumTab)}
        items={TABS.map(([key, label]) => ({
          value: key,
          label: key === 'activity' && requestLive ? <>{label}<span className={styles.liveDot} aria-label=" (a request is running)" /></> : label,
        }))}
      />

      <div id={TAB_PANEL_ID} role="tabpanel" aria-labelledby={tabIdFor(TAB_PANEL_ID, tab)} className={styles.tabPanel}>
      {tab === 'tracks' && (
        <AlbumTracks
          tracks={album.tracks}
          missingTracks={album.missingTracks}
          discCount={album.discCount}
          albumArtists={[album.artistCredit, albumArtist, Array.isArray(album.release?.artistCredit) ? album.release.artistCredit.join(', ') : album.release?.artistCredit]}
          artistNames={album.artists?.map((a) => a.name) ?? []}
          maintenance={maintenance}
        />
      )}

      {tab === 'editions' && (<>
        {showCandidates && (
          <section className={styles.plainSection}>
            <h2 className={styles.sectionTitle}>Possible releases</h2>
            <CandidateTable
              candidates={album.candidates}
              localTrackCount={album.trackCount}
              localTracks={album.tracks}
              showExcluded={showExcluded}
              onToggleExcluded={() => setShowExcluded((s) => !s)}
              onAccept={(id) => acceptCandidate.mutate(id)}
              onExclude={(id) => excludeCandidate.mutate(id)}
              busy={acceptCandidate.isPending || excludeCandidate.isPending}
            />
          </section>
        )}
        {album.release && (
          <section className={styles.plainSection}>
            <h2 className={styles.sectionTitle}>Your files and this edition</h2>
            {discrepancies.lengths.length > 0 || discrepancies.titles.length > 0 ? (
              <>
                <p className={styles.muted}>
                  {[
                    discrepancies.lengths.length > 0 && `${discrepancies.lengths.length === 1 ? '1 track is' : `${discrepancies.lengths.length} tracks are`} more than 3 seconds off`,
                    discrepancies.titles.length > 0 && `${discrepancies.titles.length === 1 ? '1 title differs' : `${discrepancies.titles.length} titles differ`}`,
                  ].filter(Boolean).join(' · ')}. If this is the wrong edition, pick yours below.
                </p>
                <TrackComparison tracks={album.tracks} />
              </>
            ) : (
              <p className={styles.muted}>Every track matches this edition within 3 seconds.</p>
            )}
          </section>
        )}
        <AlbumEditionsPanel
          hasReleaseGroup={!!album.releaseGroupId}
          editions={editions}
          onFetch={() => refreshEditions.mutate(albumId)}
          fetchPending={refreshEditions.isPending}
          tools={<>
            {album.match?.releaseGroupOnly && <span className={`${styles.pill} ${styles.pillMuted}`}>any edition</span>}
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
              title={pending ? 'An identification request is already queued for this album — cancel it first' : 'Re-match this album to this edition (queues a manual identification)'}
            >
              {switchingMbid === e.mbid ? 'Queuing…' : 'Use this edition'}
            </Button>
          ))}
          footer={album.match && maintenance && (
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
      </>)}

      {tab === 'about' && (<>
        <section className={styles.plainSection}>
          <h2 className={styles.sectionTitle}>About this album</h2>
          <dl className={styles.facts}>
            {facts.filter(([, v]) => v !== null && v !== '' && v !== undefined).map(([k, v]) => (
              <div key={k}><dt>{k}</dt><dd>{v}</dd></div>
            ))}
          </dl>
        </section>
        {album.releaseGroupId ? (
          <ReviewsSection libraryId={libraryId} releaseGroupId={album.releaseGroupId} editions={editions?.editions} />
        ) : (
          <section className={styles.plainSection}>
            <h2 className={styles.sectionTitle}>Reviews &amp; listening</h2>
            <p className={styles.muted}>Ratings, reviews and listens attach to a release group — match this album first.</p>
          </section>
        )}
      </>)}

      {tab === 'activity' && (
        <section className={styles.plainSection}>
          <h2 className={styles.sectionTitle}>What is going on with this album</h2>
          <dl className={styles.activity}>
            <dt>Identification</dt>
            <dd>
              {requestLive && request
                ? requestSummary(request)
                : album.match
                  ? `${album.match.decidedBy === 'system' ? 'Auto-matched' : 'Matched by you'} at distance ${album.match.distance.toFixed(4)}${album.match.decidedAt ? ` on ${new Date(album.match.decidedAt).toLocaleString()}` : ''}${album.match.reason ? ` — ${album.match.reason}` : ''}`
                  : `${STATE_LABEL[album.state] ?? album.state}; nothing queued.`}
            </dd>
            {request && !requestLive && (
              <>
                <dt>Last request</dt>
                <dd>{requestSummary(request)}</dd>
              </>
            )}
            <dt>Candidates</dt>
            <dd>{album.candidates.length} kept{excludedCount ? `, ${excludedCount} excluded` : ''} — compare them under Editions.</dd>
            <dt>Cover art</dt>
            <dd>{album.coverUrl ? `present (${album.coverOrigin ?? 'unknown origin'})` : 'none yet — Fetch cover art in the Manage menu queues a lookup'}</dd>
            <dt>Editions</dt>
            <dd>{editions ? (editions.fetchedAt ? `fetched ${new Date(editions.fetchedAt).toLocaleString()}` : editions.fetching ? 'fetching now' : 'not fetched') : 'open the Editions tab to see or fetch them'}</dd>
            <dt>Reviews</dt>
            <dd>fetched only on request from About (one call per source: CritiqueBrainz, MusicBrainz, Wikipedia, Discogs)</dd>
            <dt>Open gaps</dt>
            <dd>{openGaps.length ? [...new Set(openGaps.map((g) => GAP_KIND_LABEL[g.kind] ?? g.kind))].join(', ') : 'none'}</dd>
            <dt>Folder</dt>
            <dd className={styles.dirPath}>{album.dirPaths?.join('\n')}</dd>
          </dl>
          <p className={styles.muted}>
            Library-wide progress: <Link to="/settings/$section" params={{ section: 'activity' }}>Background activity</Link> · <Link to="/work" search={{ tab: 'identify' }}>Identify</Link>.
          </p>
        </section>
      )}
      </div>


      {(album.release?.discogsReleaseId || album.release?.discogsMasterId || album.candidates.some((c) => c.discogsReleaseId)) && (
        <div className={styles.attribution}>
          <span>
            Data provided by{' '}
            <a href="https://www.discogs.com" target="_blank" rel="noreferrer">Discogs</a>
          </span>
        </div>
      )}
      {editingTags && libraryId && (
        <BulkTagEditor
          libraryId={libraryId}
          scopes={editScopes}
          title={`Set album values · ${title ?? 'this album'}`}
          onClose={() => setEditingTags(false)}
        />
      )}
      </div>
    </div>
  );
}
