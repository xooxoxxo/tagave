/**
 * Album page (spec BRW-2), laid out as the album page flow (vault spec
 * "tagave - Album Page Flow"; changes 2026-10-16 evening: the conventions of
 * a music app's album page): the album first (cover, "Rock · 2012", title,
 * artist, "tracks · length · format", a two-line excerpt with More, then
 * the action row Shuffle | Play, raised icons) followed by one TRACKLIST label (it sticks
 * under the docked header) and the tracks. Back and ⋮ are embossed
 * icons that never move; the header docks around them (AlbumFlowHeader,
 * useAlbumFlow). ⋮ opens the album's drawer (a dropdown on a desktop) with
 * every album action, Album info, and the Maintenance switch; Play never
 * docks into the header. Upkeep stays out of
 * sight unless something needs a decision (see utils/albumAttention.ts);
 * Maintenance (maintenance.ts) reveals the state, provider links, every
 * library issue, the Manage menu and per-track marks.
 *
 * Maintenance is the inspector (MaintenanceInspector, owner 2026-11-05):
 * a full-height sidebar beside the album on a desktop (≥ 1024px), one
 * "To fix · 3" row that opens the same groups in a sheet below that. The
 * sections (Tracks, Editions, About, Activity, kept in ?tab) are picked
 * there and show in the main column in place of the tracks; without
 * Maintenance the page is the album and its tracks. A ?tab link to another
 * section turns Maintenance on, as the old "Library health" links
 * (?tab=care, ?issues) do, opening their row in the inspector.
 */
import { lazy, Suspense, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { IdentifyRequestView } from '@tagave/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useLocation, useNavigate, useParams, useSearch } from '@tanstack/react-router';
import { useFlacUpgrade } from '../hooks/useFlacUpgrade';
import { useCoverEmbed } from '../hooks/useCoverEmbed';
import { MaintenanceTaskStatus } from '../components/MaintenanceTaskStatus';
import { useCan, useCurrentLibrary, useAlbumEditions, useRefreshEditions, useMatchAnyEdition, useClearAnyEdition, useAddAlbumToCollection, useInvalidatePhysical, isAlreadyOwned, type PreviousPhysicalLink } from '../hooks';
import { useMergeAlbums, useUnmergeAlbum } from '../hooks/useCompilations';
import { invalidateAlbumCare } from '../hooks/useGaps';
import { api } from '../services/api';
// Reviews render markdown (react-markdown + micromark, ~100 KB) and show on
// the About tab only: their own chunk, fetched when that tab opens.
const ReviewsSection = lazy(() => import('../components/ReviewsSection').then((m) => ({ default: m.ReviewsSection })));
import { AlbumEditionsPanel } from './AlbumEditionsPanel';
import { useAlbumFolderActions } from '../components/AlbumMaintenanceActions';
import { BulkTagEditor, type EditScopeOption } from '../components/BulkTagEditor';
import { useFingerprintAlbum } from '../hooks/useFingerprint';
import { useEditionSwitch } from '../hooks/useEditionSwitch';
import { IdentifyRequestPanel, requestSummary } from '../components/IdentifyRequestPanel';
import { useMaintenance } from '../maintenance';
import { useMaintenanceAction } from '../hooks/useMaintenance';
import { useDisplayPrefs } from '../displayPrefs';
import { PageBackActionContext } from '../components/ui/PageShell';
import { isNotFound, NotFoundPage } from '../components/NotFound';
import { uniqueGenres } from '../utils/albumPresentation';
import { describeQualityFlag, type QualityIssue } from '../utils/qualityFlags';
import { GAP_KIND_LABEL, doneLabel, gapLine, qualityFlagOf, taskText, wrongFix, type WrongFix } from '../utils/gapTasks';
import { attentionItems, issuesTargetRow, requestKeyOf, trackDiscrepancies, type AlbumSearch, type AlbumTab, type AttentionItem } from '../utils/albumAttention';
import { GapChoices, ReopenGapButton } from '../components/GapChoices';
import { Button, Chip, CloseIcon, Collapse, CoverArt, KebabIcon, LinkButton, Menu, PageShell, embossClassName, confirmDialog, showToast, updateToast, dismissToast } from '../components/ui';
import { AlbumFolders } from './AlbumFolders';
import { AlbumFacts, showsDiscogsData } from './AlbumFacts';
import type { AlbumDetail, Gap } from './albumDetailTypes';
import { AlbumTracks } from './AlbumTracks';
import { AlbumAttention } from './AlbumAttention';
import { MaintenanceInspector, MaintenanceSummary, PickBar, type InspectorSelection, type InspectorStateModel, type InspectorTool, type MaintenanceInspectorProps } from './MaintenanceInspector';
import { EMPTY_TICKS, inspectorRows, reconcileTicks } from '../utils/maintenanceInspector';
import { useMediaQuery } from '../hooks/useMediaQuery';
import { CandidateTable, TrackComparison } from './AlbumMatchTable';
import { STATE_LABEL, artPollMs, dur, totalLength } from './albumFormat';
import { AlbumFlowHeader } from './AlbumFlowHeader';
import { AlbumActionRow } from './AlbumActionRow';
import { LikeKey } from '../components/LikeKey';
import { useLikesOn } from '../hooks/useLikes';
import { AlbumMoreButton, useAlbumDrawer, type AlbumInfoTab, type AlbumSummary } from './AlbumMenu';
// The drawers (Base UI Drawer) load when one first opens: their own chunk.
const AlbumActionsSheet = lazy(() => import('./AlbumSheets').then((m) => ({ default: m.AlbumActionsSheet })));
const AlbumInfoSheet = lazy(() => import('./AlbumSheets').then((m) => ({ default: m.AlbumInfoSheet })));
const SplitSheet = lazy(() => import('../components/SplitSheet').then((m) => ({ default: m.SplitSheet })));
const TagSheet = lazy(() => import('../components/TagSheet').then((m) => ({ default: m.TagSheet })));
const MoveSheet = lazy(() => import('../components/MoveSheet').then((m) => ({ default: m.MoveSheet })));
const MaintenanceSheet = lazy(() => import('./MaintenanceSheet').then((m) => ({ default: m.MaintenanceSheet })));
import { albumActionContext, albumMenu, type AlbumMenuAction, type AlbumPlayState } from './albumActions';
import { AlbumFiller } from './AlbumFiller';
import { aboutExcerpt, albumLines, caretPath, countryName, formatLine, formatReleased, releaseYear, shortFormat, wantsFiller } from './albumFlow';
import { ALBUM_WIDGETS, type AlbumWidgetId } from './albumWidgets';
import { useAlbumFlow } from './useAlbumFlow';
import { useAlbumListenLinks } from '../hooks/useListenLinks';
import { useReviews } from '../hooks/useReviews';
import { albumAvailabilityKey, playbackAvailable, useAlbumPlayability, useCapabilities } from '../hooks/usePlayer';
import { currentTrack, playAlbum, shuffleAlbum, toggle as togglePlayback, usePlayerStore } from '../player/engine';
import { TrackActions, enqueueWithToast } from '../components/player/TrackActions';
import { usePlaylistsOn } from '../hooks/usePlaylists';
import { useDeleteAction, useHiddenDeletions } from './deleteAction';
import { useLeaveDeleted } from '../hooks/useLeaveDeleted';
import { UNDO_MS } from './collectionRemoval';
import { invalidateAfterMove, useUndoMove } from '../hooks/useAlbumMove';
import type { AlbumMoveView } from '@tagave/shared';

const AddToPlaylistSheet = lazy(() => import('../components/player/TrackDrawer').then((m) => ({ default: m.AddToPlaylistSheet })));
import { scanWaitLine } from '../player/logic';
import styles from './AlbumDetailPage.module.css';

const SECTION_LABEL: Record<AlbumTab, string> = { tracks: 'Tracks', editions: 'Editions', about: 'About', activity: 'Activity' };

/** The inspector is a sidebar from this width; below it, a row and a sheet. */
export const INSPECTOR_SIDEBAR_QUERY = '(min-width: 1024px)';

const PANEL_MATCH_INPUT = 'manual-match-input';
/** the section shown in place of the tracks */
const SECTION_PANEL_ID = 'album-section-panel';

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
  const artistOrigin = useLocation({ select: (location) =>
    (location.state as { albumArtistOrigin?: { id: string; name: string } }).albumArtistOrigin });
  const { libraryId } = useCurrentLibrary();
  const queryClient = useQueryClient();
  const [maintenance, setMaintenance] = useMaintenance();
  // a listener's album page is the music: no Manage menu, decisions or Maintenance key
  const canCare = useCan('library.edit');
  const canSplit = useCan('system.manage');
  const upgrade = useFlacUpgrade(libraryId, albumId, canSplit);
  const [splitOpen, setSplitOpen] = useState(false);
  // Maintenance, the owner: songs picked to move to another album or delete
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [moveOpen, setMoveOpen] = useState(false);
  /** the songs the Move sheet moves: the picked ones, or every song from Tools › Move songs… */
  const [moveIds, setMoveIds] = useState<string[]>([]);
  // the inspector: a sidebar on a desktop, a row and a sheet below 1024px
  const wide = useMediaQuery(INSPECTOR_SIDEBAR_QUERY);
  const sidebar = maintenance && wide;
  const [fixOpen, setFixOpen] = useState(false);
  const fixOpener = useRef<HTMLElement | null>(null);
  const [fixWanted, setFixWanted] = useState(false);
  if (fixOpen && !fixWanted) setFixWanted(true);
  /** a row a deep link opened, brought into view in the inspector */
  const [reveal, setReveal] = useState<string | null>(null);
  const [ticks, setTicks] = useState(EMPTY_TICKS);
  const undoMove = useUndoMove(libraryId);
  // Play and Shuffle: every role has player.use today; the strip follows the permission
  const mayPlay = useCan('player.use');
  const [{ shortAlbumArt, shortAlbumWaves, albumWidgets }, setDisplayPrefs] = useDisplayPrefs();
  // the opt-in player: Play and per-track play exist only while one is installed
  // and answering; installed but silent, Play shows disabled with a word why
  const player = useCapabilities().data?.player;
  const likesOn = useLikesOn();
  const canPlay = playbackAvailable(player);
  const playerInstalled = !!player?.installed;
  const playability = useAlbumPlayability(albumId, canPlay);
  const playingHere = usePlayerStore((s) => currentTrack(s)?.albumId === albumId);
  const playingLocally = usePlayerStore((s) => s.status === 'playing' && !s.remoteDeviceId && currentTrack(s)?.albumId === albumId);
  const playlistsOn = usePlaylistsOn();
  // the owner's one delete item (Mark for deletion / Move to trash), and what waits out its Undo
  const del = useDeleteAction(libraryId);
  const hiddenDel = useHiddenDeletions();
  // after a delete: one step up the path taken (utils/backNav afterDelete)
  const leaveDeleted = useLeaveDeleted();
  const playStatus = usePlayerStore((s) => s.status);
  const playError = usePlayerStore((s) => s.status === 'error' && currentTrack(s)?.albumId === albumId ? s.message : null);
  const playingTrackId = usePlayerStore((s) => (currentTrack(s)?.albumId === albumId ? currentTrack(s)?.localTrackId ?? null : null));
  const queueLoading = usePlayerStore((s) => s.loadingAlbumId === albumId);
  // the sections switcher is a Maintenance tool: without it, the page is the tracks
  const sections = maintenance;
  const tab: AlbumTab = sections ? search.tab ?? 'tracks' : 'tracks';
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
  // a picked song belongs to this album and this Maintenance visit
  useEffect(() => { setPicked(new Set()); setTicks(EMPTY_TICKS); setFixOpen(false); }, [albumId, maintenance]);
  // the sheet belongs below 1024px: a window grown past it shows the sidebar instead
  useEffect(() => { if (wide) setFixOpen(false); }, [wide]);
  const togglePick = (id: string) => setPicked((cur) => {
    const next = new Set(cur);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const toggleRow = (id: string) => setOpenRows((cur) => {
    const next = new Set(cur);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const refresh = (delayMs = 0) =>
    setTimeout(() => {
      // the album, the grid, and Library care (a match or Ignore changes what is incomplete or a duplicate)
      void invalidateAlbumCare(queryClient);
    }, delayMs);

  const { data: album, isLoading, isError, error: albumError, refetch, dataUpdatedAt } = useQuery({
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
      if (art === 'unavailable' || q.state.data?.artFetch?.task?.workerAvailable === false && (art === 'failed' || art === 'interrupted')) return 5000;
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
  const coverAction = useMaintenanceAction(libraryId);
  const embed = useCoverEmbed(libraryId, albumId, canSplit && maintenance);
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

  // The flow (vault spec "tagave - Album Page Flow"): the album first, the
  // header docking around the back and Maintenance keys, then the tracks.
  const backAct = useContext(PageBackActionContext);
  const flowRefs = useMemo(() => ({
    root: { current: null as HTMLElement | null },
    hero: { current: null as HTMLElement | null },
    cover: { current: null as HTMLElement | null },
    names: { current: null as HTMLElement | null },
    nameA: { current: null as HTMLElement | null },
    nameB: { current: null as HTMLElement | null },
    tl: { current: null as HTMLElement | null },
    caret: { current: null as SVGPathElement | null },
    tracks: { current: null as HTMLElement | null },
  }), []);
  const footRef = useRef<HTMLDivElement>(null);
  const flow = useAlbumFlow(flowRefs, !!album);
  // ⋮: a bottom drawer on a phone or tablet, a dropdown on a desktop; the album info
  // is a drawer too (a side sheet on a desktop). Focus goes back to what opened it.
  const drawer = useAlbumDrawer();
  const [sheet, setSheet] = useState<'actions' | 'info' | 'playlist' | 'tag' | null>(null);
  const [infoTab, setInfoTab] = useState<string>('about');
  // the drawers' code loads on the first open and stays (so they can animate closed)
  const [sheetsWanted, setSheetsWanted] = useState(false);
  if (sheet && !sheetsWanted) setSheetsWanted(true);
  const opener = useRef<HTMLElement | null>(null);
  // the excerpt under the names: the album's Wikipedia text or a review, when one is stored
  const reviews = useReviews(libraryId, album?.releaseGroupId ?? null);
  // Listen elsewhere (the listen-links module): the person's platforms, in the ⋮
  const listenLinks = useAlbumListenLinks(libraryId, album?.releaseGroupId ?? null);
  // a section opened from elsewhere on the page (or a ?tab link) is brought into view;
  // the sections live in Maintenance, so opening one turns it on
  const openSection = (next: AlbumTab) => {
    if (next !== 'tracks' && !maintenance) setMaintenance(true);
    setTab(next);
    setFixOpen(false);
    // the section takes the tracks' place: back up to it when the page is scrolled past
    requestAnimationFrame(() => flow.revealTracklist());
  };
  // a link to another section (?tab=about…) opens it, in Maintenance
  useEffect(() => {
    if (search.tab && search.tab !== 'tracks' && !maintenance) setMaintenance(true);
  }, [search.tab]); // eslint-disable-line react-hooks/exhaustive-deps
  const sectionShown = useRef(false);
  useEffect(() => {
    if (!album || sectionShown.current) return;
    sectionShown.current = true;
    if (search.tab && search.tab !== 'tracks') requestAnimationFrame(() => flow.revealTracklist());
  }, [album]); // eslint-disable-line react-hooks/exhaustive-deps
  // a Play that found nothing to play may have asked the server to scan: look again
  const playFailedHere = usePlayerStore((s) => s.status === 'error' && s.queue?.context?.kind === 'album' && s.queue.context.id === albumId);
  useEffect(() => {
    if (playFailedHere) void queryClient.invalidateQueries({ queryKey: albumAvailabilityKey(albumId) });
  }, [playFailedHere, albumId, queryClient]);

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
  // Switching edition is a manual identification request (useEditionSwitch):
  // the clicked row spins from the click until the worker has decided and the
  // editions have been read again.
  const switchEdition = useEditionSwitch(libraryId, albumId, {
    live: requestLive,
    kind: request?.kind ?? null,
    pinned: request?.pinned ?? null,
  });

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
  }, { request, dismissedRequestKey: dismissedRequest, ackedTaskIds: acked, canSplit }) : []), [album, request, dismissedRequest, acked, canSplit]);
  const items = !canCare ? [] : maintenance ? allItems : allItems.filter((i) => i.interrupts);

  useEffect(() => {
    if (!pendingIssues || !album) return;
    const target = issuesTargetRow(allItems, pendingIssues);
    if (target) {
      setOpenRows((cur) => new Set(cur).add(target.id));
      setReveal(target.id);
      // below 1024px the inspector is a sheet: the link opens it at that row
      if (!globalThis.matchMedia?.(INSPECTOR_SIDEBAR_QUERY).matches) setFixOpen(true);
    }
    setPendingIssues(undefined);
  }, [pendingIssues, album, allItems]);

  // a row that leaves the list (fixed, dismissed) ticks off, and goes on the next read
  useEffect(() => {
    setTicks((t) => reconcileTicks(t, maintenance && canCare ? allItems : [], dataUpdatedAt));
  }, [allItems, dataUpdatedAt, maintenance, canCare]);

  /** the API's problem+json `detail` is the message the owner should read */
  const errorDetail = (m: { error: unknown }): string | null =>
    (m.error as { detail?: string } | null)?.detail ?? (m.error as Error | null)?.message ?? null;

  if (isError && isNotFound(albumError)) return <NotFoundPage title="Album not found" to="/albums" label="Back to albums" />;
  if (isError) return <PageShell back title="Couldn’t load this album" barTitle={null}><div className={styles.container} role="alert"><p>Try again, or return to your library.</p><Button onClick={() => void refetch()}>Try again</Button><Link to="/albums">Back to albums</Link></div></PageShell>;
  if (isLoading || !album) return <PageShell back title={<span className={styles.muted}>Loading album…</span>} barTitle={null}>{null}</PageShell>;

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
  // opened cold, a deleted album leaves for its artist, else Albums
  const firstArtistId = album.artists?.find((a) => a.id)?.id;
  const deletedFallback = firstArtistId ? `/artists/${firstArtistId}` : '/albums';
  const releaseCredit = Array.isArray(album.release?.artistCredit) ? album.release.artistCredit.join(', ') : album.release?.artistCredit;
  const sameCredit = !!album.artistCredit && album.artistCredit.toLowerCase() === releaseCredit?.toLowerCase();
  const origin = artistOrigin && artistOrigin.name.toLowerCase() === album.artistCredit?.toLowerCase() ? artistOrigin : null;
  const originMatches = !!origin && (sameCredit || !releaseCredit);
  const dockArtistId = album.artists?.length === 1 ? firstArtistId : !album.artists?.length && originMatches ? origin?.id : null;
  const albumArtist = album.artists?.length
    ? album.artists.map((a) => a.name).join(', ')
    : originMatches ? origin.name : sameCredit ? album.artistCredit : releaseCredit ?? album.artistCredit;
  const trackCountText = album.trackCount == null ? null : album.isCueImage
    ? `${album.trackCount} audio ${album.trackCount === 1 ? 'file' : 'files'} (CUE image)`
    : `${album.trackCount} ${album.trackCount === 1 ? 'track' : 'tracks'}`;
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
    // below 1024px the panel is in the inspector's sheet
    if (!sidebar) setFixOpen(true);
    const focus = (tries: number) => {
      const el = document.getElementById(PANEL_MATCH_INPUT);
      if (el) el.focus({ preventScroll: !sidebar });
      else if (tries > 0) setTimeout(() => focus(tries - 1), 60);
    };
    requestAnimationFrame(() => focus(8));
  };

  // Tag: the sheet with the defaults; focus goes back to what opened it (the Tag key, or ⋮ from the drawer)
  const openTag = () => {
    if (fixOpen) opener.current = fixOpener.current;
    else if (!drawer || sheet !== 'actions') opener.current = document.activeElement as HTMLElement | null;
    setFixOpen(false);
    setSheet('tag');
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
      case 'editions': openSection('editions'); break;
      case 'split-image': setFixOpen(false); setSplitOpen(true); break;
      case 'art': fetchArt.mutate(); break;
      case 'tags': openTag(); break;
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
    if (fix.action === 'editions') return <Button variant="quiet" size="sm" onClick={() => openSection('editions')}>{fix.actionLabel}</Button>;
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

  const duplicates = album.duplicates.filter((d) => !hiddenDel.album(d.id));
  const duplicatesList = duplicates.length > 0 && (
    <ul className={styles.plainList}>
      {duplicates.map((d) => (
        <li key={d.id} className={del && maintenance ? styles.copyRow : undefined}>
          <div>
            <Link to="/albums/$albumId" params={{ albumId: d.id }}>{d.title ?? 'Untitled'}</Link>
            <span className={styles.muted}> · {[d.formats?.join('/'), `${d.trackCount} tracks`, STATE_LABEL[d.state] ?? d.state].filter(Boolean).join(' · ')}</span>
            {d.dirPaths?.[0] && <span className={styles.pathLine}>{d.dirPaths[0]}</span>}
          </div>
          {del && maintenance && (
            <Menu
              label={`More for ${d.title ?? 'this copy'}${d.dirPaths?.[0] ? ` (${d.dirPaths[0]})` : ''}`}
              items={[{ key: 'delete', label: del.label, tone: 'danger', onSelect: () => del.album(d.id, d.title ?? 'Untitled') }]}
              triggerClassName={embossClassName('page', styles.copyMore)}
              icon={<KebabIcon />}
            />
          )}
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
            onPick={(mbid) => switchEdition.switchTo(mbid)}
            picking={switchEdition.isPending ? switchEdition.busyMbid : null}
            pickError={switchEdition.error}
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
            {f.key === 'noEmbeddedArt' && canSplit && (!embed.view.data?.task || embed.view.data.task.state === 'done') && (
              <>
                <Button variant="secondary" size="sm" disabled={embed.start.isPending} onClick={() => embed.start.mutate()}>
                  {embed.start.isPending ? 'Queuing cover embedding…' : 'Embed local cover'}
                </Button>
                {embed.start.isError && <p role="alert">{errorDetail(embed.start) ?? 'Couldn’t queue cover embedding.'}</p>}
              </>
            )}
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
                    {f?.action === 'tags' && <Button variant="quiet" size="sm" onClick={() => openTag()}>Fix tags</Button>}
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

  // ---- the Maintenance tools (in ⋮ while Maintenance is on) ----

  const upgradeTask = upgrade.view.data?.task;
  const startUpgrade = async () => {
    if (!await confirmDialog({
      title: 'Upgrade this album to FLAC?',
      message: 'Tagave will use Lidarr to download this edition, verify and tag the FLAC files, then replace the album. The original will go to Trash.',
      confirmLabel: 'Upgrade to FLAC',
    })) return;
    upgrade.request.mutate(undefined, {
      onError: (err) => showToast({ message: (err as { detail?: string }).detail ?? 'Couldn’t queue the upgrade.', tone: 'danger' }),
    });
  };
  const tool = (a: Omit<AlbumMenuAction, 'icon'>): AlbumMenuAction => ({ ...a, icon: 'tool' });
  const tools: AlbumMenuAction[] = [
    tool({ key: 'reidentify', label: reidentify.isPending ? 'Queuing…' : 'Re-identify', hint: requestLive ? 'A request is already queued' : 'Look this album up again', disabled: requestLive || reidentify.isPending, onSelect: () => reidentify.mutate() }),
    tool({ key: 'manual', label: 'Match to a release…', hint: 'Paste a MusicBrainz or Discogs link', disabled: requestLive, onSelect: openManual }),
    ...(album.state !== 'matched' ? [tool({ key: 'fp', label: 'Fingerprint', hint: 'Identify by sound (AcoustID)', disabled: fingerprint.isPending, onSelect: () => fingerprint.mutate(albumId, { onSuccess: () => { setNote('Fingerprinting queued.'); refresh(3000); } }) })] : []),
    tool({ key: 'art', label: album.coverUrl ? 'Refetch cover art' : 'Fetch cover art', disabled: fetchArt.isPending, onSelect: () => fetchArt.mutate() }),
    tool({ key: 'values', label: 'Set album values…', hint: 'Artist, title, year, genre for every track', onSelect: () => setEditingTags(true) }),
    ...(album.match ? [tool({ key: 'any', label: album.match.releaseGroupOnly ? 'Pin one edition again' : 'Accept any edition', hint: 'Keep the release group without one edition', onSelect: () => (album.match?.releaseGroupOnly ? clearAnyEdition.mutate(albumId) : matchAnyEdition.mutate(albumId)) })] : []),
    tool({ key: 'rescan', label: 'Rescan folder', separated: true, disabled: !folder.canRescan || folder.busy, onSelect: () => void folder.rescan() }),
    ...(folder.canSplit ? [
      tool({ key: 'split-lossy', label: 'Split off lossy copies', hint: 'Lossless stays here', disabled: folder.busy, onSelect: () => void folder.split('lossless') }),
      tool({ key: 'split-lossless', label: 'Split off lossless copies', hint: 'Lossy stays here', disabled: folder.busy, onSelect: () => void folder.split('lossy') }),
    ] : []),
    ...(folder.canMergeBack ? [tool({ key: 'merge-back', label: 'Merge back', hint: 'Return these files to the album they came from', disabled: folder.busy, onSelect: () => void folder.mergeBack() })] : []),
    ...(ownsPhysical && canOwnPhysical ? [tool({ key: 'own-more', label: 'Add another physical copy', hint: 'Only if you own two', disabled: addPhysical.isPending, onSelect: () => void ownPhysical(true) })] : []),
    ...(album.state !== 'as_is' ? [tool({ key: 'asis', label: 'Keep as-is', hint: 'Keep your tags; stop identifying', separated: true, disabled: keepAsIs.isPending, onSelect: () => keepAsIs.mutate() })] : []),
    ...(album.state !== 'ignored' ? [tool({ key: 'ignore', label: 'Ignore', hint: 'Leave out of the queue and gap counts', separated: album.state === 'as_is', disabled: ignore.isPending, onSelect: () => ignore.mutate() })] : []),
  ];

  // The cover-art lookup as it really stands (not a fixed "queued" line):
  // live while the job is queued or running, then gone when the art lands,
  // or a plain "none found" when the lookup came back empty.
  const artState = album.artFetch?.state;
  const coverTask = album.artFetch?.task;
  const artLive = artState === 'queued' || artState === 'running';
  const retryCover = coverTask?.actions.includes('retry') ? (
    <Button variant="quiet" size="sm" disabled={coverAction.isPending} onClick={() => coverAction.mutate({ id: coverTask.id, action: 'retry' })}>Retry</Button>
  ) : null;
  const artNote: { text: string; live: boolean; action?: ReactNode } | null =
    (artAsked || maintenance) && artState === 'unavailable' ? { text: 'Cover art is waiting for the file worker.', live: false }
      : artLive && (artAsked || maintenance) ? { text: artState === 'running' ? 'Looking for cover art…' : 'Cover art lookup queued…', live: true }
        : (artAsked || (maintenance && !!coverTask)) && !album.coverUrl && artState === 'done'
          ? { text: 'No cover art found.', live: false }
          : (artAsked || maintenance) && (artState === 'failed' || artState === 'interrupted')
            ? { text: coverAction.isError ? 'Couldn’t retry the cover art lookup.' : artState === 'interrupted' ? 'The cover art lookup stopped.' : 'The cover art lookup failed.', live: false, action: retryCover }
            : null;
  const plainNote = note ?? folder.note ?? (fingerprint.isError ? errorDetail(fingerprint) : null)
    ?? (reidentify.isError ? errorDetail(reidentify) : null) ?? (fetchArt.isError ? errorDetail(fetchArt) : null);
  const statusNote: { text: string; live: boolean } | null = artNote ?? (plainNote ? { text: plainNote, live: false } : null);
  const dismissNote = () => { setNote(null); setArtAsked(false); };

  const facts: Array<[string, ReactNode]> = [
    ['Released', formatReleased(album.release?.date, album.year)],
    ['Label', album.release?.labels?.length ? album.release.labels.map((l) => (l.catno ? `${l.name} · ${l.catno}` : l.name)).join(', ') : null],
    ['Country', countryName(album.release?.country)],
    ['Tracks', [trackCountText, album.discCount && album.discCount > 1 ? `${album.discCount} discs` : null, dur(album.totalDurationMs)].filter(Boolean).join(' · ')],
    ['Format', formatLine(album.tracks, album.formats) || album.formats?.join(', ') || null],
    ['Genres & styles', genreLabels.join(', ') || null],
    ['Physical copy', ownsPhysical ? album.discogsCollectionItems!.map((i) => [i.format, i.folder, i.mediaCondition && `media ${i.mediaCondition}`, i.sleeveCondition && `sleeve ${i.sleeveCondition}`, i.pushState === 'pending' ? 'adding to Discogs…' : i.pushState === 'failed' ? `failed: ${i.pushError}` : null].filter(Boolean).join(' · ')).join('; ') : null],
    ['Local folder', album.dirPaths?.length ? <AlbumFolders folders={album.folders ?? album.dirPaths.map((path) => ({ path, scanRootId: null, link: null }))} /> : null],
    ...(maintenance ? [
      ['Identification', album.match ? `${album.match.decidedBy === 'system' ? 'Automatic match' : 'Matched by you'}${album.match.decidedAt ? ` on ${new Date(album.match.decidedAt).toLocaleDateString()}` : ''}` : 'No release matched'] as [string, ReactNode],
      ['Artwork source', album.coverOrigin ?? null] as [string, ReactNode],
    ] : []),
    ['CUE sheet', album.isCueImage ? album.cueRelPath || 'CUE image album' : null],
  ];

  // two short centred lines around the names: "Rock · 2012" above, "22 tracks · 1 hr 58 min · MP3 320 kbps" below
  const lines = albumLines({
    date: album.release?.date,
    year: album.year,
    genres: genreLabels,
    totalDurationMs: album.totalDurationMs,
    trackCount: album.trackCount,
    discCount: album.discCount,
    isCueImage: album.isCueImage,
    formats: album.formats,
    tracks: album.tracks,
  });
  const artistLine = albumArtist ?? 'Unknown artist';
  const albumRef = { albumId, title: title ?? 'Untitled', artist: artistLine, coverUrl: album.coverUrl };
  const excerpt = aboutExcerpt(reviews.data?.external ?? []);
  // Play: on as soon as the player can stream something here; disabled, with
  // a quiet line, while it cannot (not answering, its scan has not reached
  // the album, the files are missing). An album the player simply has not
  // seen keeps Play: pressing it asks the player to look for the files.
  const avail = playability.availability;
  const playNote: string | null = !playerInstalled ? null
    : !canPlay ? 'The player is not answering right now'
      : avail && avail.playable === 0
        ? scanWaitLine(playability.scan)
          ?? (avail.reason === 'no_file' ? 'The files are missing or could not be read'
            : avail.reason === 'cue' ? 'Tracks inside a CUE image cannot be played yet'
              : avail.reason === 'not_scanned' ? 'Not on the player yet' : null)
        : null;
  const playDisabled = !canPlay || (!!avail && avail.playable === 0 && (!!playability.scan?.scanning || avail.reason === 'no_file' || avail.reason === 'cue'));
  const playState: AlbumPlayState | null = !playerInstalled || !mayPlay ? null : {
    mode: playingHere && (playStatus === 'playing' || playStatus === 'buffering' || playStatus === 'loading') ? 'pause'
      : playingHere && playStatus === 'paused' ? 'resume' : 'play',
    loading: queueLoading,
    disabled: playDisabled,
    note: playError ?? playNote,
    onPlay: () => void playAlbum(albumRef),
    onToggle: togglePlayback,
    onShuffle: () => void shuffleAlbum(albumRef),
  };
  // the action row's slots: what this role can do here, from its capabilities
  const actionContext = albumActionContext({ canPlay: mayPlay, playerInstalled });

  // ⋮: everything for this album, for this role (albumMenu); the info drawer from "Album info" and "More"
  const openInfo = (tabName: string) => { setInfoTab(tabName); setSheet('info'); };
  const menuModel = albumMenu({
    canCare,
    maintenance,
    shuffle: playState && !playState.disabled && playState.onShuffle ? playState.onShuffle : null,
    artists: (album.artists?.length ? album.artists : originMatches ? [origin] : [])
      .map((a) => ({ id: a.id, name: a.name, go: () => void navigate({ to: '/artists/$artistId', params: { artistId: a.id } }) })),
    ownPhysical: !ownsPhysical && canOwnPhysical ? { pending: addPhysical.isPending, onSelect: () => void ownPhysical() } : null,
    // from the drawer, focus goes back to the ⋮ that opened it; the dropdown has just put it back on its own ⋮
    onInfo: () => { if (!drawer) opener.current = document.activeElement as HTMLElement | null; openInfo('about'); },
    tools,
    upgrade: upgrade.view.data?.eligible
      ? tool({ key: 'flac-upgrade', label: 'Upgrade to FLAC', disabled: upgrade.request.isPending, onSelect: () => void startUpgrade() })
      : null,
    artwork: wantsFiller(album.tracks.length) ? {
      key: 'album-waves', icon: 'disc',
      label: shortAlbumArt && shortAlbumWaves ? 'Use still artwork' : 'Animate album artwork',
      onSelect: () => setDisplayPrefs({ shortAlbumArt: true, shortAlbumWaves: !shortAlbumArt || !shortAlbumWaves }),
    } : null,
    customize: () => void navigate({ to: '/settings/$section', params: { section: 'appearance' }, hash: 'album-widgets' }),
    onToggleMaintenance: () => setMaintenance(!maintenance),
    listen: listenLinks.data?.available ? listenLinks.data.links : [],
    queue: playState && !playState.disabled ? {
      next: () => void enqueueWithToast({ albumId }, 'next'),
      end: () => void enqueueWithToast({ albumId }, 'end'),
    } : null,
    tag: canCare && libraryId ? openTag : null,
    addToPlaylist: playlistsOn ? () => { if (!drawer) opener.current = document.activeElement as HTMLElement | null; setSheet('playlist'); } : null,
    // the album leaves the library at once: back to the albums, with Undo on the toast
    remove: del ? { label: del.label, onSelect: () => { del.album(albumId, title ?? 'Untitled'); leaveDeleted(deletedFallback); } } : null,
  });
  const openActions = (button: HTMLElement) => { opener.current = button; setSheet('actions'); };
  // the one ⋮ (owner, 2026-10-17: "only single ... is enough"): in the header
  const moreButton = <AlbumMoreButton place="header" model={menuModel} drawer={drawer} open={sheet === 'actions'} onOpen={openActions} />;
  const sheetSummary: AlbumSummary = {
    coverUrl: album.coverUrl,
    title: title ?? 'Untitled',
    artist: artistLine,
    kicker: lines.kicker,
    format: shortFormat(album.tracks, album.formats),
  };
  // About for everyone (the folder and CUE paths with library care); reviews once the album has a release group
  const aboutFacts = facts.filter(([k, v]) => v !== null && v !== '' && v !== undefined && (canCare || (k !== 'Local folder' && k !== 'CUE sheet' && k !== 'Physical copy')));
  // "Your CD": the owner's physical copy, for library care (a listener's page is the music)
  const showOwnChip = ownsPhysical && canCare;
  // Discogs' terms: its attribution wherever its data shows (the About tab's last line)
  const usesDiscogs = showsDiscogsData(album.release);
  const infoTabs: AlbumInfoTab[] = [
    {
      value: 'about',
      label: 'About',
      content: (
        <AlbumFacts facts={aboutFacts} source={{ discogs: usesDiscogs, mbid: album.release?.mbid }} />
      ),
    },
    ...(album.releaseGroupId ? [{
      value: 'reviews',
      label: 'Reviews',
      content: (
        <Suspense fallback={null}>
          <ReviewsSection libraryId={libraryId} releaseGroupId={album.releaseGroupId} editions={editions?.editions} />
        </Suspense>
      ),
    }] : []),
  ];
  // Settings › Appearance can turn the short-album artwork off
  const showFiller = shortAlbumArt && wantsFiller(album.tracks.length);
  const tracksPanel = tab === 'tracks';
  // The header's plain lines: "Rock · 2014" over the title, "5 tracks · 48 min ·
  // FLAC 16-bit/44.1 kHz" under the artist. Settings › Appearance can move a
  // value to the other line or hide it; each value is one unbreakable piece.
  const trackCount = album.trackCount == null ? null : album.isCueImage
    ? `${album.trackCount} audio ${album.trackCount === 1 ? 'file' : 'files'}`
    : `${album.trackCount} ${album.trackCount === 1 ? 'track' : 'tracks'}`;
  const headerValues: Record<Exclude<AlbumWidgetId, 'ownership'>, (string | null | undefined)[]> = {
    genre: [genreLabels[0]],
    year: [releaseYear(album.release?.date, album.year)],
    tracks: [trackCount, (album.discCount ?? 1) > 1 ? `${album.discCount} discs` : null],
    duration: [totalLength(album.totalDurationMs)],
    format: [shortFormat(album.tracks, album.formats)],
  };
  const headerLine = (placement: 'above' | 'below') => ALBUM_WIDGETS
    .flatMap(({ id }) => (id !== 'ownership' && albumWidgets[id] === placement ? headerValues[id] : []))
    .filter((v): v is string => !!v);
  const kickerParts = headerLine('above');
  const factParts = headerLine('below');
  const ownChip = showOwnChip && albumWidgets.ownership !== 'hidden' ? (
    <Link to="/collection" title="In your physical collection" className={styles.ownChip}>
      <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><circle cx="10" cy="10" r="7" /><circle cx="10" cy="10" r="2" /></svg>
      {`Your ${physicalFormats || 'copy'}`}{physicalPending ? ' (adding to Discogs…)' : ''}
    </Link>
  ) : null;
  const dotted = (parts: ReactNode[]) => parts.flatMap((part, i) => [
    ...(i > 0 ? [<span key={`dot${i}`} className={styles.dot} aria-hidden="true"> · </span>] : []),
    <span key={`part${i}`} className={styles.part}>{part}</span>,
  ]);

  // ---- Maintenance, the owner: the songs picked, Move to album… and Delete ----
  const visibleTracks = album.tracks.filter((t) => !hiddenDel.track(t.id));
  const pickedIds = visibleTracks.filter((t) => picked.has(t.id)).map((t) => t.id);
  const allPicked = visibleTracks.length > 0 && pickedIds.length === visibleTracks.length;
  const pickedTitle = pickedIds.length === 1 ? visibleTracks.find((t) => t.id === pickedIds[0])?.title ?? 'Untitled' : `${pickedIds.length} songs`;
  const deletePicked = () => {
    if (!del || pickedIds.length === 0) return;
    // the whole album: the album goes, with its Undo
    if (allPicked) { del.album(albumId, title ?? 'Untitled'); leaveDeleted(deletedFallback); return; }
    del.tracks(pickedIds, pickedTitle);
    setPicked(new Set());
  };
  const onMoved = (view: AlbumMoveView) => {
    const n = view.moved ?? 0;
    const whole = visibleTracks.length > 0 && visibleTracks.every((t) => moveIds.includes(t.id));
    setPicked(new Set());
    const again = () => void invalidateAfterMove(queryClient, libraryId);
    again();
    // the folders are scanned again just after the move: look once more
    setTimeout(again, 4000);
    showToast({
      message: `${n === 1 ? '1 song' : `${n} songs`} · Moved`,
      durationMs: UNDO_MS,
      action: {
        label: 'Undo',
        onClick: () => undoMove.mutate(view.id, {
          onSuccess: () => {
            const id = showToast({ message: 'Undoing', durationMs: 60_000 });
            const poll = async (left: number): Promise<void> => {
              const v = await api.get<AlbumMoveView>(`/libraries/${libraryId}/moves/${view.id}`).catch(() => null);
              if (v && (v.state === 'undoing' || v.state === 'moving') && left > 0) { setTimeout(() => void poll(left - 1), 1000); return; }
              updateToast(id, { message: v?.state === 'undone' ? 'Undone' : v?.error ?? 'Not undone', ...(v?.state === 'undone' ? {} : { tone: 'danger' as const }), durationMs: 5000 });
              await invalidateAfterMove(queryClient, libraryId);
              setTimeout(again, 4000);
            };
            void poll(60);
          },
          onError: () => showToast({ message: 'Not undone. Try again.', tone: 'danger' }),
        }),
      },
    });
    if (whole && view.targetAlbumId) void navigate({ to: '/albums/$albumId', params: { albumId: view.targetAlbumId } });
  };
  const moveSongs = (ids: string[]) => {
    if (ids.length === 0) return;
    setMoveIds(ids);
    setFixOpen(false);
    setMoveOpen(true);
  };
  // the songs picked: the inspector's Selection group, and the phone's floating bar
  const selection: InspectorSelection | null = maintenance && canSplit && visibleTracks.length > 0 ? {
    count: pickedIds.length,
    all: allPicked,
    onAll: () => setPicked(new Set(visibleTracks.map((t) => t.id))),
    onMove: () => moveSongs(pickedIds),
    deleteLabel: del?.label ?? null,
    onDelete: () => { setFixOpen(false); deletePicked(); },
    onClear: () => setPicked(new Set()),
  } : null;

  // ---- the inspector (Maintenance): the same groups in the sidebar and the phone's sheet ----
  const inspectorState: InspectorStateModel = {
    state: album.state,
    label: STATE_LABEL[album.state] ?? album.state,
    onClearAnyEdition: album.match?.releaseGroupOnly ? () => clearAnyEdition.mutate(albumId) : null,
    discogsOnly: album.release?.sourceOfTruth === 'discogs' && !album.release?.mbid,
    links: [
      ...(album.release?.mbid ? [{ label: 'MusicBrainz', href: `https://musicbrainz.org/release/${album.release.mbid}` }] : []),
      ...(album.release?.discogsReleaseId ? [{ label: 'Discogs', href: `https://www.discogs.com/release/${album.release.discogsReleaseId}` }] : []),
      ...(album.release?.discogsMasterId ? [{ label: 'Master', href: `https://www.discogs.com/master/${album.release.discogsMasterId}` }] : []),
    ],
  };
  // Tools: the album's everyday fixes (the ⋮ keeps every tool too)
  const inspectorTools: InspectorTool[] = [
    ...(upgrade.view.data?.eligible ? [{ key: 'flac-upgrade', label: 'Upgrade to FLAC', disabled: upgrade.request.isPending, onSelect: () => void startUpgrade() }] : []),
    ...(canCare && libraryId ? [{ key: 'tag', label: 'Tag…', onSelect: openTag }] : []),
    ...(canSplit && visibleTracks.length > 0 ? [{ key: 'move', label: 'Move songs…', onSelect: () => moveSongs(pickedIds.length > 0 ? pickedIds : visibleTracks.map((t) => t.id)) }] : []),
    { key: 'manual', label: 'Match to a release', disabled: requestLive, onSelect: openManual },
    ...(folder.canRescan ? [{ key: 'rescan', label: 'Rescan folder', disabled: folder.busy, onSelect: () => void folder.rescan() }] : []),
    ...(folder.canSplit ? [{ key: 'split', label: 'Split by format', disabled: folder.busy, onSelect: () => { setFixOpen(false); void folder.split('lossless'); } }] : []),
    ...(folder.canMergeBack ? [{ key: 'merge-back', label: 'Merge back', disabled: folder.busy, onSelect: () => { setFixOpen(false); void folder.mergeBack(); } }] : []),
  ];
  const fix = inspectorRows(items, ticks);
  // an action that opens another sheet or a section closes the phone's sheet first
  const inspectorAction = (item: AttentionItem) => {
    const d = item.action?.do;
    if (d === 'tags' || d === 'split-image' || d === 'editions') setFixOpen(false);
    onAction(item);
  };
  const inspectorProps: Omit<MaintenanceInspectorProps, 'variant'> = {
    state: inspectorState,
    rows: fix.rows,
    meter: fix.meter,
    openRows,
    onToggle: toggleRow,
    onAction: inspectorAction,
    body: rowBody,
    busy,
    note: statusNote ? { ...statusNote, onDismiss: dismissNote } : null,
    manual: manualOpen && !matchRowOpen ? (
      <div className={styles.manualInspector}>
        <div className={styles.manualHead}>
          <span className={styles.manualTitle}>Match to a release</span>
          <Button variant="quiet" size="sm" onClick={() => setManualOpen(false)}>Close</Button>
        </div>
        {manualMatch(PANEL_MATCH_INPUT)}
      </div>
    ) : null,
    selection,
    tools: inspectorTools,
    upgrade: upgradeTask && libraryId ? <MaintenanceTaskStatus task={upgradeTask} libraryId={libraryId} /> : null,
    embedCover: embed.view.data?.task && libraryId ? <MaintenanceTaskStatus task={embed.view.data.task} libraryId={libraryId} /> : null,
    sections: { value: tab, onChange: (next) => openSection(next), live: requestLive },
    reveal,
  };
  const statusSlot = (
    <div className={styles.statusSlot} role="status" aria-live="polite">
      {!maintenance && upgradeTask && libraryId && <MaintenanceTaskStatus task={upgradeTask} libraryId={libraryId} />}
      {statusNote && (
        <p className={styles.statusNote}>
          {statusNote.live && <span className={styles.statusSpinner} aria-hidden="true" />}
          <span>{statusNote.text}</span>
          {!statusNote.live && (
            <button type="button" className={styles.statusDismiss} onClick={dismissNote} aria-label="Dismiss"><CloseIcon /></button>
          )}
        </p>
      )}
    </div>
  );

  return (
    <PageShell bare>
      {/* with the sidebar, the album and the inspector side by side; otherwise this box is not there (display: contents) */}
      <InspectorLayout on={sidebar}>
      <div ref={(el) => { flowRefs.root.current = el; }} className={styles.flow} data-album-flow="" data-album-tab={tab} data-sections={sections ? '' : undefined}>
        <AlbumFlowHeader
          docked={flow.docked}
          artist={artistLine}
          artistId={dockArtistId}
          title={title ?? 'Untitled'}
          glide={flow.glide}
          backLabel={backAct?.label ?? null}
          onBack={() => backAct?.go()}
          onTop={flow.toTop}
          end={moreButton}
        />

        <section
          ref={(el) => { flowRefs.hero.current = el; }}
          className={styles.hero}
          aria-label="Album"
        >
          {/* The cover's own colours behind the album, fading into the page. */}
          <div className={styles.backdropFrame} aria-hidden="true">
            <div className={album.coverUrl ? styles.backdrop : styles.backdropPlain} style={album.coverUrl ? { backgroundImage: `url("${album.coverUrl}")` } : undefined} />
          </div>
          <div ref={(el) => { flowRefs.cover.current = el; }} className={styles.coverBox}>
            <CoverArt src={album.coverUrl} title={title ?? 'Untitled'} loading="eager" className={styles.cover} />
          </div>
          <div className={styles.headInfo}>
            {/* "Rock · 2012" */}
            {(kickerParts.length > 0 || (ownChip && albumWidgets.ownership === 'above')) && (
              <p className={styles.kicker} data-album-kicker="">
                {dotted(kickerParts)}
                {albumWidgets.ownership === 'above' && ownChip}
              </p>
            )}
            {/* the title over the artist; they move only with the page and shrink into the header title */}
            <div ref={(el) => { flowRefs.names.current = el; }} className={styles.names}>
              <h1 ref={(el) => { flowRefs.nameB.current = el; }} className={styles.nameB} dir="auto">{title}</h1>
              <span ref={(el) => { flowRefs.nameA.current = el; }} className={styles.nameA}>
                {album.artists && album.artists.length > 0
                  ? album.artists.map((artist, idx) => (
                    <span key={artist.id}>
                      <Link to="/artists/$artistId" params={{ artistId: artist.id }}>{artist.name}</Link>
                      {idx < album.artists!.length - 1 && ', '}
                    </span>
                  ))
                  : originMatches
                    ? <Link to="/artists/$artistId" params={{ artistId: origin.id }}>{artistLine}</Link>
                    : artistLine}
              </span>
            </div>
            {/* what it is: tracks · length · format, and your copy (everything else is in Album info) */}
            {(factParts.length > 0 || (ownChip && albumWidgets.ownership === 'below')) && (
              <p className={styles.factsLine} data-album-facts="">
                {dotted(factParts)}
                {albumWidgets.ownership === 'below' && ownChip}
              </p>
            )}
            {/* the album's text, two lines; More opens the album info */}
            {excerpt && (
              <div className={styles.excerpt} data-album-excerpt="">
                <p className={styles.excerptText} dir="auto">{excerpt}</p>
                <button
                  type="button"
                  className={styles.more}
                  aria-haspopup="dialog"
                  aria-label="More about this album"
                  onClick={(e) => { opener.current = e.currentTarget; openInfo('reviews'); }}
                >
                  More
                </button>
              </div>
            )}
            {/* Shuffle | Play (the one ⋮ is in the header) */}
            <AlbumActionRow context={actionContext} play={playState} like={likesOn ? <LikeKey kind="album" id={albumId} /> : null} />
          </div>

          {/* Upkeep: only what needs a decision. In Maintenance the inspector holds it all:
              the sidebar on a desktop, one "To fix · 3" row here below 1024px */}
          <div className={styles.upkeep} hidden={maintenance ? sidebar : !(statusNote || upgradeTask || (manualOpen && !matchRowOpen) || items.length > 0)}>
            {maintenance ? (<>
              <MaintenanceSummary meter={fix.meter} open={fixOpen} onOpen={(b) => { fixOpener.current = b; setFixOpen(true); }} />
              {statusSlot}
            </>) : (<>
              {/* a passing status: quiet, inline, gone when the thing it is about is done */}
              {statusSlot}
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
                label="Needs your decision"
                items={items}
                open={openRows}
                onToggle={toggleRow}
                onAction={onAction}
                body={rowBody}
                busy={busy}
              />
            </>)}
          </div>
        </section>

        {/* one TRACKLIST label: follows the album directly (owner, 2026-10-19), sticks under the header
            (with a section open in Maintenance, it goes back to the tracks) */}
        <button ref={(el) => { flowRefs.tl.current = el; }} type="button" className={styles.tl} onClick={() => { if (!tracksPanel) setTab('tracks'); flow.toTracklist(); }} aria-label="Go to the tracklist">
          <span className={styles.tlLabel}>Tracklist</span>
          <svg className={styles.caret} viewBox="0 0 346 16" preserveAspectRatio="none" aria-hidden="true">
            <path ref={(el) => { flowRefs.caret.current = el; }} d={caretPath(0)} fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
          </svg>
        </button>

        <div
          ref={(el) => { flowRefs.tracks.current = el; }}
          className={styles.tracksArea}
        >
          <AlbumTracks
            tracks={visibleTracks}
            missingTracks={album.missingTracks}
            discCount={album.discCount}
            albumArtists={[album.artistCredit, albumArtist, Array.isArray(album.release?.artistCredit) ? album.release.artistCredit.join(', ') : album.release?.artistCredit]}
            artistNames={album.artists?.map((a) => a.name) ?? []}
            maintenance={maintenance}
            pick={canSplit ? { selected: picked, onToggle: togglePick } : null}
            player={canPlay && !playDisabled ? { currentTrackId: playingTrackId, onPlay: (trackId) => void playAlbum(albumRef, trackId) } : null}
            trackLike={likesOn ? (t) => <LikeKey kind="song" id={t.id} /> : null}
            trackMenu={(canPlay && !playDisabled) || playlistsOn || likesOn ? (t) => (
              <TrackActions
                label={`More for ${t.title ?? 'this track'}`}
                summary={{ title: t.title ?? 'Untitled', subtitle: [t.artist || artistLine, title].filter(Boolean).join(' · '), coverUrl: album.coverUrl }}
                source={{ trackIds: [t.id] }}
                artist={album.artists?.[0] ? { id: album.artists[0].id, name: album.artists[0].name } : null}
              />
            ) : null}
          />
        </div>
        {/* short albums: a generative piece under the tracklist, seeded by the title */}
        {showFiller && (
          <AlbumFiller title={title ?? 'Untitled'} waves={shortAlbumWaves} coverUrl={album.coverUrl} playing={playingLocally} />
        )}

        {/* the album's other sections (Maintenance): picked in the inspector, shown here in the tracks' place */}
        <div ref={footRef} className={styles.foot}>
          {sections && !tracksPanel && (
          <div id={SECTION_PANEL_ID} role="region" aria-label={SECTION_LABEL[tab]} className={styles.tabPanel}>
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
              </>}
              rowAction={(e) => (e.owned ? (
                <Chip dot="ok" className={styles.yourCopyChip}>Your copy</Chip>
              ) : (
                <Button
                  variant="quiet"
                  size="sm"
                  className={styles.editionButton}
                  onClick={() => switchEdition.switchTo(e.mbid)}
                  loading={switchEdition.busyMbid === e.mbid}
                  disabled={switchEdition.busy || !!pending}
                  title={switchEdition.busyMbid === e.mbid
                    ? 'Switching to this edition — the page updates when identification decides'
                    : pending ? 'An identification request is already queued for this album — cancel it first' : 'Re-match this album to this edition (queues a manual identification)'}
                >
                  {switchEdition.busyMbid === e.mbid ? 'Switching…' : 'Use this edition'}
                </Button>
              ))}
              rowNote={(e) => (switchEdition.errorMbid === e.mbid && switchEdition.error ? (
                <span className={styles.mbidError} role="alert">Couldn’t switch to this edition: {switchEdition.error}</span>
              ) : null)}
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
              <AlbumFacts facts={facts.filter(([, v]) => v !== null && v !== '' && v !== undefined)} source={{ discogs: usesDiscogs, mbid: album.release?.mbid }} />
            </section>
            {album.releaseGroupId ? (
              <Suspense fallback={null}>
                <ReviewsSection libraryId={libraryId} releaseGroupId={album.releaseGroupId} editions={editions?.editions} />
              </Suspense>
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
                <dd>{album.coverUrl ? `present (${album.coverOrigin ?? 'unknown origin'})` : 'none yet — Fetch cover art in the ⋮ menu'}</dd>
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
          )}

        </div>
        {/* the songs picked, below 1024px: "2 · Move… · Delete · ✕" floats over the tracks */}
        {selection && !sidebar && <PickBar selection={selection} />}
        {editingTags && libraryId && (
          <BulkTagEditor
            libraryId={libraryId}
            scopes={editScopes}
            title={`Set album values · ${title ?? 'this album'}`}
            onClose={() => setEditingTags(false)}
          />
        )}
        {/* Whole album in one file: the cut points and Split (owner) */}
        {canSplit && splitOpen && (
          <Suspense fallback={null}>
            <SplitSheet
              open={splitOpen}
              onOpenChange={setSplitOpen}
              libraryId={libraryId}
              albumId={albumId}
              title={title ?? 'This album'}
              artist={artistLine}
              coverUrl={album.coverUrl}
              side={drawer ? 'bottom' : 'right'}
            />
          </Suspense>
        )}
        {/* Maintenance: the picked songs into another album's folder (owner) */}
        {canSplit && moveOpen && (
          <Suspense fallback={null}>
            <MoveSheet
              open={moveOpen}
              onOpenChange={setMoveOpen}
              libraryId={libraryId}
              albumId={albumId}
              trackIds={moveIds}
              artist={artistLine}
              side={drawer ? 'bottom' : 'right'}
              onMoved={onMoved}
            />
          </Suspense>
        )}
        {/* the drawers, loaded the first time one opens */}
        {sheetsWanted && (
          <Suspense fallback={null}>
            {/* ⋮ on a phone or tablet: the album's drawer */}
            {drawer && (
              <AlbumActionsSheet
                open={sheet === 'actions'}
                onOpenChange={(open) => setSheet(open ? 'actions' : null)}
                returnFocus={opener}
                summary={sheetSummary}
                model={menuModel}
              />
            )}
            {/* Add to playlist… from the album's ⋮ */}
            {playlistsOn && (
              <AddToPlaylistSheet
                open={sheet === 'playlist'}
                onOpenChange={(open) => setSheet(open ? 'playlist' : null)}
                returnFocus={opener}
                source={{ albumId }}
                side={drawer ? 'bottom' : 'right'}
              />
            )}
            {/* Tag: a new plan with the defaults, from "Tag…" in ⋮ and Fix tags */}
            {canCare && libraryId && sheet === 'tag' && (
              <TagSheet
                open
                onOpenChange={(open) => setSheet(open ? 'tag' : null)}
                returnFocus={opener}
                libraryId={libraryId}
                albums={{ ids: [albumId], labels: { [albumId]: `${artistLine} — ${title ?? 'Untitled'}` } }}
                side={drawer ? 'bottom' : 'right'}
              />
            )}
            {/* Album info (About, Reviews): from "Album info" in ⋮ and from More */}
            <AlbumInfoSheet
              open={sheet === 'info'}
              onOpenChange={(open) => setSheet(open ? 'info' : null)}
              returnFocus={opener}
              summary={sheetSummary}
              tabs={infoTabs}
              initialTab={infoTab}
              side={drawer ? 'bottom' : 'right'}
            />
          </Suspense>
        )}
        {/* Maintenance below 1024px: the inspector's groups in a sheet, from the "To fix" row */}
        {maintenance && !sidebar && fixWanted && (
          <Suspense fallback={null}>
            <MaintenanceSheet {...inspectorProps} open={fixOpen} onOpenChange={setFixOpen} returnFocus={fixOpener} />
          </Suspense>
        )}
      </div>
      {sidebar && (
        <aside className={styles.inspectorSide} aria-label="Maintenance">
          <MaintenanceInspector variant="side" {...inspectorProps} />
        </aside>
      )}
      </InspectorLayout>
    </PageShell>
  );
}

/**
 * The album and the inspector side by side (Maintenance on a desktop). The
 * sidebar sticks to the pane and scrolls on its own; --pane-h is the scroll
 * pane's visible height. Off, the box lays out nothing (display: contents).
 */
function InspectorLayout({ on, children }: { on: boolean; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const box = ref.current;
    const pane = box?.closest<HTMLElement>('main') ?? document.getElementById('main-content');
    if (!on || !box || !pane) return;
    const update = () => box.style.setProperty('--pane-h', `${pane.clientHeight}px`);
    update();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(update);
    ro.observe(pane);
    return () => ro.disconnect();
  }, [on]);
  return <div ref={ref} className={styles.inspectorLayout} data-inspector={on ? '' : undefined}>{children}</div>;
}
