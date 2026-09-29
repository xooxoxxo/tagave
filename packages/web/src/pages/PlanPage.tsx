import { Input, Select } from '../components/ui/FormControl';
/**
 * One tag plan, full page. Reads top-down the way a large batch has to be
 * read: what the plan is, how far it got, which fields it changes (and how
 * many files each), then one collapsed row per file that opens into the
 * per-field diff. Actions for the current state sit in the header. Nothing
 * is written until Apply.
 */
import { Fragment, useEffect, useMemo, useState, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import type { TagDiffEntry, TagPlanItem } from '@liner/shared';
import { PageShell, Button, Badge, Banner, StatCard, Card, confirmDialog, type ConfirmOptions } from '../components/ui';
import { useCurrentLibrary } from '../hooks';
import { useLibrarySettings, useScanRoots } from '../hooks/useLibrary';
import {
  useApplyTagPlan,
  useCancelTagPlan,
  usePauseTagPlan,
  usePreviewTagPlan,
  useResumeTagPlan,
  useRevertTagPlan,
  useDeleteTagPlan,
  useRenameTagPlan,
  useTagPlan,
  useTagPlanResults,
  useTagPlanItems,
  useTagPlanSummary,
  usePlanAppears,
  previewGuardKey,
} from '../hooks/usePlanWizard';
import { formatDateTime, formatRelativeTime } from '../utils';
import { planStatusView, planUsesId3, diffRowKind, diffValueText } from '../utils/planStatus';
import styles from './PlanPage.module.css';
import { awaitAfterPreview, canPreview, derivePreviewState, progressSignature, shouldPollPlan } from './planPreviewState';
import { explainPreview, plural, verb, type PreviewOutcome } from './planOutcome';
import { BulkTagEditor, type EditScopeOption } from '../components/BulkTagEditor';
import { useIdentifyAlbums } from '../hooks/useCompilations';
import { InlineRename } from '../components/InlineRename';
import { PlanResults, PlanReverted } from './PlanResults';
import { KEPT_PLAN_NOTE, RESULT_STATUSES } from './planResultsText';

const PAGE_SIZE = 100;
const BUSY = new Set(['applying', 'paused']);
/** How long the page keeps polling after an action while it waits for the worker to flip the status. */
const AWAIT_MS = 120_000;
/** How long to wait for a draft preview job to report progress before showing timeout state. */
const PREVIEW_TIMEOUT_MS = 30_000;
/** How long a running preview may go without new progress before the page says it looks stuck. */
const PREVIEW_STALE_MS = 90_000;

type ItemStatus = NonNullable<TagPlanItem['status']>;
const ITEM_TONE: Record<ItemStatus, 'neutral' | 'info' | 'success' | 'danger' | 'warning'> = {
  pending: 'neutral', applying: 'info', applied: 'success', failed: 'danger', skipped: 'warning',
};


const PRESET_LABEL: Record<string, string> = {
  canonical_ids_and_fill: 'Canonical IDs + fill',
  fill_blanks_only: 'Fill blanks only',
  overwrite_all: 'Overwrite all',
  custom: 'Custom',
  manual: 'Your values',
  revert: 'Revert',
};

/** [label, value] per value a manual plan writes, for the Details list. */
function manualValues(values: Record<string, string | string[] | undefined> | undefined): Array<[string, string]> {
  if (!values) return [];
  return Object.entries(values)
    .filter((e): e is [string, string | string[]] => e[1] !== undefined)
    .map(([k, v]) => [
      FIELD_LABELS[k] ?? k,
      k === 'compilation' ? (v === '1' ? 'Yes' : 'No') : Array.isArray(v) ? v.join('; ') : v,
    ]);
}

/**
 * Why the preview changes nothing (or leaves files out), one line per reason
 * with what can be done about it: identify the albums, set the values by
 * hand, look at locks. Hidden when the stats name no reason.
 */
function PreviewOutcomeNotice({
  outcome, manual, onIdentify, identifying, identifyNote, onSetValues,
}: {
  outcome: PreviewOutcome;
  manual: boolean;
  onIdentify: (albumIds: string[]) => void;
  identifying: boolean;
  identifyNote: string | null;
  onSetValues: (() => void) | null;
}) {
  const { notIdentified, releaseMissing } = outcome;
  const toIdentify = [...new Set([...notIdentified.albumIds, ...releaseMissing.albumIds])];
  return (
    <Banner tone={outcome.nothing ? 'info' : 'warning'}>
      <strong>{outcome.nothing ? 'This plan changes nothing. Here is why:' : 'Some files are left out of this plan:'}</strong>
      <ul className={styles.reasons}>
        {notIdentified.files > 0 && (
          <li>
            {plural(notIdentified.files, 'file')} {verb(notIdentified.files, 'belongs', 'belong')} to {notIdentified.albumIds.length > 0 ? plural(notIdentified.albumIds.length, 'album') : 'albums'} that
            {notIdentified.albumIds.length === 1 ? ' is' : ' are'} not identified yet, so there is no release to take canonical values from.
            <span className={styles.reasonActions}>
              {toIdentify.length > 0 && (
                <Button variant="secondary" size="sm" loading={identifying} onClick={() => onIdentify(toIdentify)}>
                  Identify {toIdentify.length === 1 ? 'the album' : `${toIdentify.length.toLocaleString()} albums`}
                </Button>
              )}
              {onSetValues && <Button variant="primary" size="sm" onClick={onSetValues}>Set the values yourself</Button>}
            </span>
            {identifyNote && <span className={styles.reasonNote} role="status">{identifyNote}</span>}
          </li>
        )}
        {releaseMissing.files > 0 && (
          <li>{plural(releaseMissing.files, 'file')} {verb(releaseMissing.files, 'belongs', 'belong')} to albums whose matched release is no longer cached; identifying them again restores it.</li>
        )}
        {outcome.notInAlbum > 0 && <li>{plural(outcome.notInAlbum, 'file')} {verb(outcome.notInAlbum, 'is', 'are')} not part of any album.</li>}
        {outcome.notWritable > 0 && (
          <li>{plural(outcome.notWritable, 'file')} {verb(outcome.notWritable, 'sits', 'sit')} on a scan root that does not allow writes — <Link to="/settings/library">Settings › Music folders</Link>.</li>
        )}
        {outcome.errors.files > 0 && (
          <li>{plural(outcome.errors.files, 'file')} could not be read{outcome.errors.sample ? `: ${outcome.errors.sample}` : ''}.</li>
        )}
        {outcome.lockedOnly > 0 && (
          <li>{plural(outcome.lockedOnly, 'file')} would change only in locked fields; locks always win ({plural(outcome.lockedChanges, 'change')} kept back).</li>
        )}
        {outcome.lockedOnly === 0 && outcome.lockedChanges > 0 && (
          <li>{plural(outcome.lockedChanges, 'change')} kept back by locked fields.</li>
        )}
        {outcome.nothing && (outcome.alreadyCorrect ?? 0) > 0 && (
          <li>{plural(outcome.alreadyCorrect!, 'file')} already {verb(outcome.alreadyCorrect!, 'carries', 'carry')} {manual ? 'the values you set' : 'the canonical values under this policy'}.</li>
        )}
      </ul>
    </Banner>
  );
}

function scopeLabel(scope: Record<string, unknown> | undefined): string {
  const type = scope?.type as string | undefined;
  switch (type) {
    case 'library': return 'Entire library';
    case 'artist': return 'One artist';
    case 'albumIds': return plural((scope?.albumIds as string[] | undefined)?.length ?? 0, 'album');
    case 'filterQuery': return 'Filtered albums';
    case 'folder': return `Folder ${String(scope?.dirPath ?? '')}`;
    default: return '';
  }
}

const reasonLabel = (r: string) => r.replace('policy:', '');
const FIELD_LABELS: Record<string, string> = {
  // Basic metadata
  title: 'Track title',
  artist: 'Track artist',
  artistsort: 'Artist sort name',
  album: 'Album title',
  albumartist: 'Album artist',
  albumartistsort: 'Album artist sort name',
  // Dates
  date: 'Release date',
  originaldate: 'Original date',
  // Track and disc positioning
  tracknumber: 'Track number',
  totaltracks: 'Total tracks',
  discnumber: 'Disc number',
  totaldiscs: 'Total discs',
  discsubtitle: 'Disc subtitle',
  // Classification
  genre: 'Genre',
  compilation: 'Compilation',
  // Release metadata
  label: 'Record label',
  catalognumber: 'Catalog number',
  barcode: 'Barcode',
  media: 'Media format',
  releasecountry: 'Release country',
  releasestatus: 'Release status',
  releasetype: 'Release type',
  // Recording identifiers
  isrc: 'ISRC',
  musicbrainz_albumid: 'MusicBrainz release ID',
  musicbrainz_releasegroupid: 'MusicBrainz release group ID',
  musicbrainz_albumartistid: 'MusicBrainz album artist ID',
  musicbrainz_artistid: 'MusicBrainz artist ID',
  musicbrainz_recordingid: 'MusicBrainz recording ID',
  musicbrainz_releasetrackid: 'MusicBrainz release track ID',
  // External identifiers
  acoustid_id: 'AcoustID',
  discogs_release_id: 'Discogs release ID',
  discogs_master_id: 'Discogs master ID',
};

// Hover text for a file row: the first few field names, then a count.
// The full list is one click away in the expanded diff.
const FIELD_LIST_MAX = 6;
function shortFieldList(fields: string[]): string {
  const labels = fields.map((f) => FIELD_LABELS[f] ?? f);
  if (labels.length <= FIELD_LIST_MAX) return labels.join(', ');
  return `${labels.slice(0, FIELD_LIST_MAX).join(', ')} and ${labels.length - FIELD_LIST_MAX} more`;
}


export function PlanPage() {
  const { planId } = useParams({ strict: false }) as { planId: string };
  const { libraryId } = useCurrentLibrary();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [field, setField] = useState('');
  const [itemStatus, setItemStatus] = useState('');
  const [offset, setOffset] = useState(0);
  const [pathFilter, setPathFilter] = useState('');
  const [previewRequested, setPreviewRequested] = useState(false);
  const [previewTimedOut, setPreviewTimedOut] = useState(false);
  const [previewAttempt, setPreviewAttempt] = useState(0);
  const [runningStale, setRunningStale] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [allOpen, setAllOpen] = useState(false);
  // Status at the moment an action was sent; the page polls until it changes
  // (the worker flips it a few seconds after the 202), or gives up after AWAIT_MS.
  const [awaiting, setAwaiting] = useState<string | null>(null);
  // For delete confirmation: two-step inline (first click shows "Really delete?")
  const [confirmDelete, setConfirmDelete] = useState(false);
  // A plan that wrote files is kept; pressing its Delete says why.
  const [keptNote, setKeptNote] = useState(false);
  // Track whether we've fired auto-preview for this mount to prevent re-firing
  const previewAutoFiredRef = useRef(false);
  const [editingValues, setEditingValues] = useState(false);
  const [identifyNote, setIdentifyNote] = useState<string | null>(null);
  const identifyAlbums = useIdentifyAlbums(libraryId);
  // Revert builds a new, already previewed plan from the journal; open it
  // as soon as the worker has written it.
  const [revertPlanId, setRevertPlanId] = useState<string | null>(null);
  const revertPlan = usePlanAppears(libraryId, revertPlanId);
  useEffect(() => {
    if (revertPlanId && revertPlan.data) {
      setRevertPlanId(null);
      void navigate({ to: '/plans/$planId', params: { planId: revertPlanId } });
    }
  }, [revertPlanId, revertPlan.data, navigate]);
  useEffect(() => {
    if (!revertPlanId) return;
    const t = setTimeout(() => {
      setRevertPlanId(null);
      setError('The revert plan is taking long to build. It will appear under Tag changes when it is ready.');
    }, AWAIT_MS);
    return () => clearTimeout(t);
  }, [revertPlanId]);

  const planQ = useTagPlan(libraryId, planId, { refetchInterval: 0 });
  const status = planQ.data?.status;
  const statusRef = useRef(status);
  statusRef.current = status;
  // The status the auto-preview effect last acted on: its reset branch runs
  // when the plan leaves draft, not on every re-render of a previewed plan.
  const lastPreviewStatusRef = useRef<string | undefined>(undefined);
  // A draft's preview job as the API reports it: queue state plus what the
  // worker says it is doing. Both queries share one cache entry.
  const job = status === 'draft' ? planQ.data?.previewJob : undefined;
  const jobActive = job?.state === 'queued' || job?.state === 'running';
  const polling = shouldPollPlan({ previewRequested, jobActive, awaiting, status });
  const liveQ = useTagPlan(libraryId, planId, { refetchInterval: polling ? 2000 : false });
  const p = liveQ.data ?? planQ.data;

  useEffect(() => {
    if (awaiting !== null && status !== undefined && status !== awaiting) setAwaiting(null);
  }, [awaiting, status]);
  useEffect(() => {
    if (awaiting === null) return;
    const t = setTimeout(() => {
      setAwaiting(null);
      // A re-preview the page never saw leave 'previewed' must not leave the
      // button saying "Previewing…" for good.
      if (statusRef.current !== 'draft') setPreviewRequested(false);
    }, AWAIT_MS);
    return () => clearTimeout(t);
  }, [awaiting]);
  // Items and the summary change together with the plan status.
  useEffect(() => {
    void qc.invalidateQueries({ queryKey: ['tag-plan-items', libraryId, planId] });
    void qc.invalidateQueries({ queryKey: ['tag-plan-summary', libraryId, planId] });
    void qc.invalidateQueries({ queryKey: ['tag-plan-results', libraryId, planId] });
  }, [status, libraryId, planId, qc]);

  const settings = useLibrarySettings(libraryId);
  const roots = useScanRoots(libraryId);
  const previewM = usePreviewTagPlan(libraryId, planId);
  const applyM = useApplyTagPlan(libraryId, planId);
  const pauseM = usePauseTagPlan(libraryId, planId);
  const resumeM = useResumeTagPlan(libraryId, planId);
  const cancelM = useCancelTagPlan(libraryId, planId);
  const revertM = useRevertTagPlan(libraryId, planId);
  const deleteM = useDeleteTagPlan(libraryId, planId);
  const renameM = useRenameTagPlan(libraryId);
  const hasResults = !!status && RESULT_STATUSES.has(status);
  const results = useTagPlanResults(libraryId, planId, { enabled: hasResults });

  const previewed = !!p && p.status !== 'draft';
  const summary = useTagPlanSummary(libraryId, planId, { enabled: previewed, refetchInterval: polling ? 4000 : false });
  const items = useTagPlanItems(libraryId, planId, {
    ...(field ? { fieldFilter: field } : {}),
    ...(itemStatus ? { statusFilter: itemStatus } : {}),
    limit: PAGE_SIZE,
    offset,
    enabled: previewed,
    refetchInterval: polling ? 4000 : false,
  });

  // A freshly created plan (or one reverted to draft) previews itself once.
  // Use progress.total to detect if a job is already running rather than just status.
  const previewMutate = previewM.mutateAsync;
  const previewPending = previewM.isPending;
  useEffect(() => {
    const statusChanged = lastPreviewStatusRef.current !== p?.status;
    lastPreviewStatusRef.current = p?.status;
    if (p?.status === 'draft') {
      const previewJobRunning = jobActive || (p.progress?.total ?? 0) > 0;

      // Once per plan, not once per mount. A ref is created fresh on every
      // mount, so navigating away and back re-fired the preview; three visits
      // to one plan queued three jobs against the same files. Key the guard to
      // the plan id in session storage so a remount, a back button or a second
      // tab all count as the same request. The server refuses duplicates too;
      // this just stops us asking.
      const guardKey = previewGuardKey(planId);
      const alreadyAsked = (() => {
        try { return sessionStorage.getItem(guardKey) === '1'; } catch { return previewAutoFiredRef.current; }
      })();

      if (!previewJobRunning && !alreadyAsked && !previewAutoFiredRef.current && !previewPending) {
        previewAutoFiredRef.current = true;
        try { sessionStorage.setItem(guardKey, '1'); } catch { /* private mode: the ref still guards this mount */ }
        setPreviewRequested(true);
        previewMutate().catch((e: { detail?: string; message?: string }) => {
          // Same as a click that fails: nothing is on its way, so the button
          // comes back and no timeout warning follows.
          setPreviewRequested(false);
          setError(e?.detail ?? e?.message ?? 'The preview could not be started.');
        });
      }
    } else if (statusChanged) {
      // Plan left draft state; clear the guard so a later revert to draft
      // auto-previews once again. Only on the change itself: this effect
      // also re-runs while a re-preview of a previewed plan is in flight,
      // and resetting then would drop the request the click just made.
      previewAutoFiredRef.current = false;
      try { sessionStorage.removeItem(previewGuardKey(planId)); } catch { /* nothing to clear */ }
      setPreviewRequested(false);
      setPreviewTimedOut(false);
    }
  }, [p?.status, p?.progress?.total, jobActive, previewMutate, previewPending, planId]);

  // Timeout for draft previews: after PREVIEW_TIMEOUT_MS with no progress, show timeout state.
  // Each request (auto or a click) restarts the clock.
  useEffect(() => {
    if (previewRequested && p?.status === 'draft') {
      setPreviewTimedOut(false);
      const t = setTimeout(() => setPreviewTimedOut(true), PREVIEW_TIMEOUT_MS);
      return () => clearTimeout(t);
    }
    setPreviewTimedOut(false);
  }, [previewRequested, previewAttempt, p?.status]);

  const startPreview = async () => {
    const before = p?.status;
    setError(null);
    setPreviewRequested(true);
    setPreviewAttempt((n) => n + 1);
    if (before === 'previewed') {
      // The server puts the plan back to draft before it answers. This click
      // is that draft's preview, so the draft must not auto-preview again.
      previewAutoFiredRef.current = true;
      try { sessionStorage.setItem(previewGuardKey(planId), '1'); } catch { /* the ref guards this mount */ }
    }
    try {
      await previewM.mutateAsync();
      // Keep polling until the page sees the plan leave 'previewed'; the
      // mutation also refetches the plan, its items and its summary.
      const wait = awaitAfterPreview(before);
      if (wait) setAwaiting(wait);
    } catch (e) {
      setPreviewRequested(false);
      setError((e as { detail?: string; message?: string })?.detail ?? (e as Error).message);
    }
  };

  // A running job whose progress has not moved for PREVIEW_STALE_MS: the
  // clock restarts on every change the page sees. A worker that dies mid-run
  // leaves the job "running" until the queue expires it, so without this the
  // banner would keep saying "Computing" over a frozen message.
  const jobSignature = job?.state === 'running' ? progressSignature(job) : '';
  useEffect(() => {
    setRunningStale(false);
    if (!jobSignature) return;
    const t = setTimeout(() => setRunningStale(true), PREVIEW_STALE_MS);
    return () => clearTimeout(t);
  }, [jobSignature]);

  const {
    current,
    failed: previewFailed,
    stalled: previewStalled,
    busy: previewBusy,
    buttonLabel: previewButtonLabel,
  } = derivePreviewState({
    job,
    requestedJobId: previewM.data?.jobId,
    requestPending: previewM.isPending,
    requested: previewRequested,
    timedOut: previewTimedOut,
    runningStale,
    previewed,
  });
  const jobLink = (label: string) => (
    <Link
      to="/settings/$section"
      params={{ section: 'activity' }}
      search={current?.jobRunId ? { job: current.jobRunId } : {}}
      className={styles.bannerLink}
    >{label}</Link>
  );

  const stats = p?.stats;
  const progress = p?.progress;
  const tagWritesDisabled = settings.data !== undefined && !settings.data.tagWritesEnabled;
  const noWritableRoots = roots.data !== undefined && !roots.data.some((r) => r.writable);
  const nothingToDo = previewed && stats !== undefined && stats.filesTouched === 0;
  const outcome = previewed ? explainPreview(stats) : null;
  const isManual = p?.policy.preset === 'manual';
  const isRevert = p?.policy.preset === 'revert';
  // "Set the values yourself" edits the albums this plan covers.
  const planAlbumIds = p?.scope?.type === 'albumIds' ? (p.scope as { albumIds: string[] }).albumIds : null;
  const planFolder = p?.scope?.type === 'folder' ? (p.scope as { dirPath: string; scanRootId?: string }) : null;
  const valueScopes: EditScopeOption[] = planAlbumIds
    ? [{ key: 'plan', label: `The ${planAlbumIds.length === 1 ? 'album' : `${planAlbumIds.length} albums`} in this plan`, scope: { type: 'albumIds', albumIds: planAlbumIds } }]
    : planFolder
      ? [{ key: 'plan', label: `Every file in ${planFolder.dirPath}`, scope: { type: 'folder', dirPath: planFolder.dirPath, ...(planFolder.scanRootId ? { scanRootId: planFolder.scanRootId } : {}) } }]
    : outcome && outcome.notIdentified.albumIds.length > 0
      ? [{ key: 'unidentified', label: 'The albums that are not identified', scope: { type: 'albumIds', albumIds: outcome.notIdentified.albumIds } }]
      : [];
  const identify = async (albumIds: string[]) => {
    setIdentifyNote(null);
    const capped = albumIds.slice(0, 50);
    try {
      const r = await identifyAlbums.mutateAsync(capped);
      setIdentifyNote(`Identification queued for ${plural(r.queued, 'album')}${albumIds.length > capped.length ? ` (the first ${capped.length})` : ''}. Preview again once they are matched.`);
    } catch (e) {
      setIdentifyNote((e as { detail?: string })?.detail ?? 'Identification could not be queued.');
    }
  };
  const canApply = p?.status === 'previewed' && !nothingToDo && !tagWritesDisabled && !noWritableRoots;
  const applyTitle = !previewed ? 'Preview has not finished yet'
    : nothingToDo ? 'Nothing to change'
      : tagWritesDisabled ? 'Tag writes are off in Settings › Tag preferences'
        : noWritableRoots ? 'No scan root allows writes (Settings › Tag preferences)'
          : p?.status !== 'previewed' ? `Plan is ${p?.status}` : undefined;

  const run = (m: { mutateAsync: () => Promise<unknown> }, ask?: ConfirmOptions) => async () => {
    if (ask && !(await confirmDialog(ask))) return;
    setError(null);
    try {
      await m.mutateAsync();
      setAwaiting(p?.status ?? null);
    } catch (e) {
      setError((e as { detail?: string; message?: string })?.detail ?? (e as Error).message);
    }
  };

  const byField = useMemo(() => {
    const map = new Map<string, { files: number; reasons: Record<string, number> }>();
    for (const r of summary.data?.fields ?? []) {
      const cur = map.get(r.field) ?? { files: 0, reasons: {} };
      cur.files += r.files;
      cur.reasons[r.reason] = (cur.reasons[r.reason] ?? 0) + r.files;
      map.set(r.field, cur);
    }
    return [...map.entries()].sort((a, b) => b[1].files - a[1].files || a[0].localeCompare(b[0]));
  }, [summary.data]);
  const statusCounts = summary.data?.statuses ?? {};

  const pageItems = items.data?.items ?? [];
  const visibleItems = pathFilter
    ? pageItems.filter((it) => (it.relPath ?? '').toLowerCase().includes(pathFilter.toLowerCase()))
    : pageItems;
  const total = items.data?.total ?? 0;
  const pageEnd = Math.min(offset + PAGE_SIZE, total);
  const done = (progress?.applied ?? 0) + (progress?.failed ?? 0) + (progress?.skipped ?? 0);
  const pct = progress && progress.total > 0 ? Math.round((done / progress.total) * 100) : 0;

  const isOpen = (id: string) => (allOpen ? !expanded.has(id) : expanded.has(id));
  const toggle = (id: string) => setExpanded((prev) => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const toggleAll = () => { setAllOpen((v) => !v); setExpanded(new Set()); };

  if (!libraryId || planQ.isLoading) return <PageShell title="Loading">Loading plan…</PageShell>;
  if (planQ.isError || !p) {
    return (
      <PageShell title="Plan not found">
        <div className={styles.body}>
          <Link to="/plans" className={styles.back}>← Tag changes</Link>
          <p className={styles.error}>This plan could not be loaded.</p>
        </div>
      </PageShell>
    );
  }

  const statusView = planStatusView(p.status, progress);
  // A plan that wrote files keeps its journal for Revert; the API refuses to
  // delete it, so the page does not offer it (a reverted plan can go).
  const wroteFiles = (progress?.applied ?? 0) > 0 && p.status !== 'reverted';
  const deletableStatus = ['draft', 'previewed', 'reverted', 'cancelled', 'applied', 'partially_failed'].includes(p.status);
  const canDelete = deletableStatus && !wroteFiles;
  const when = p.appliedAt
    ? <>applied <span title={formatDateTime(p.appliedAt)}>{formatRelativeTime(p.appliedAt)}</span></>
    : <>created <span title={formatDateTime(p.createdAt)}>{formatRelativeTime(p.createdAt)}</span></>;
  const scopeText = p.scopeLabel || scopeLabel(p.scope as Record<string, unknown>);
  const values = isManual ? manualValues(p.policy.values as Record<string, string | string[] | undefined>) : [];
  const confirmStop: ConfirmOptions = { title: 'Stop applying?', message: 'Files already written stay written. You can revert them afterwards.', confirmLabel: 'Stop applying', cancelLabel: 'Keep going', tone: 'danger' };

  return (
    <PageShell
      title={<span className={styles.title}>
        <InlineRename
          value={p.name || 'Untitled plan'}
          label="Rename plan"
          onSave={(name) => renameM.mutateAsync({ planId, name })}
        />
        <Badge tone={statusView.tone}>{statusView.label}</Badge>
      </span>}
      subtitle={
        <span className={styles.meta}>
          <Link to="/plans" className={styles.back}>Tag changes</Link>
          {' › '}{scopeText ? <>{scopeText} · </> : null}{when}
        </span>
      }
      actions={
        <div className={styles.headerActions}>
          {!isRevert && canPreview(p.status) && (
            <Button variant="secondary" loading={previewM.isPending} onClick={startPreview} disabled={previewBusy}>
              {previewButtonLabel}
            </Button>
          )}
          {p.status === 'previewed' && (
            <Button variant="primary" loading={applyM.isPending} onClick={run(applyM, { title: `Write the previewed changes to ${plural(stats?.filesTouched ?? 0, 'file')}?`, message: 'Every write is journaled and can be reverted from this page.', confirmLabel: 'Apply changes' })} disabled={!canApply || applyM.isPending || awaiting !== null} title={applyTitle}>
              {applyM.isPending || awaiting !== null ? 'Starting…' : 'Apply now'}
            </Button>
          )}
          {p.status === 'applying' && (
            <>
              <Button variant="secondary" onClick={run(pauseM)} disabled={pauseM.isPending}>Pause</Button>
              <Button variant="danger" onClick={run(cancelM, confirmStop)} disabled={cancelM.isPending}>Cancel</Button>
            </>
          )}
          {p.status === 'paused' && (
            <>
              <Button variant="primary" onClick={run(resumeM)} disabled={resumeM.isPending || awaiting !== null}>{awaiting !== null ? 'Resuming…' : 'Resume'}</Button>
              <Button variant="danger" onClick={run(cancelM, confirmStop)} disabled={cancelM.isPending}>Cancel</Button>
            </>
          )}
          {(p.status === 'applied' || p.status === 'partially_failed' || p.status === 'cancelled') && (progress?.applied ?? 0) > 0 && (
            <Button
              variant="danger"
              loading={revertM.isPending || revertPlanId !== null}
              onClick={async () => {
                if (!(await confirmDialog({ title: 'Prepare a revert plan?', message: `It restores the previous tags on ${plural(progress?.applied ?? 0, 'file')}. You will see it before anything is written.`, confirmLabel: 'Prepare revert' }))) return;
                setError(null);
                try {
                  const r = await revertM.mutateAsync();
                  if (r.revertPlanId) setRevertPlanId(r.revertPlanId);
                  else await navigate({ to: '/plans' });
                } catch (e) {
                  setError((e as { detail?: string; message?: string })?.detail ?? (e as Error).message);
                }
              }}
              disabled={revertM.isPending || revertPlanId !== null || awaiting !== null}
            >
              {revertM.isPending || revertPlanId !== null ? 'Preparing…' : 'Revert'}
            </Button>
          )}
          {canDelete && (
            /* Quiet until confirmed: a destructive drop never sits right next
               to the primary; the second press turns it into the red drop. */
            <Button
              variant={confirmDelete ? 'danger' : 'quiet'}
              className={confirmDelete ? undefined : styles.dangerQuiet}
              loading={deleteM.isPending}
              onClick={async () => {
                if (!confirmDelete) {
                  setConfirmDelete(true);
                  return;
                }
                setError(null);
                try {
                  await deleteM.mutateAsync();
                  await navigate({ to: '/plans' });
                } catch (e) {
                  setError((e as { detail?: string; message?: string })?.detail ?? (e as Error).message);
                  setConfirmDelete(false);
                }
              }}
              disabled={deleteM.isPending}
            >
              {deleteM.isPending ? 'Deleting…' : confirmDelete ? 'Really delete?' : 'Delete'}
            </Button>
          )}
          {deletableStatus && wroteFiles && (
            /* Kept, but not silently: the owner used Delete here before, so it
               stays where it was and says why instead of vanishing. */
            <Button
              variant="quiet"
              className={styles.keptDelete}
              aria-disabled="true"
              aria-expanded={keptNote}
              title={KEPT_PLAN_NOTE}
              onClick={() => setKeptNote((v) => !v)}
            >
              Delete
            </Button>
          )}
          {confirmDelete && (
            <Button
              variant="secondary"
              onClick={() => setConfirmDelete(false)}
              disabled={deleteM.isPending}
              size="sm"
            >
              Cancel
            </Button>
          )}
        </div>
      }
    >
      <div className={styles.body}>
        {/* Only while there is still something to apply: on a finished plan it is noise. */}
        {(tagWritesDisabled || noWritableRoots) && (p.status === 'draft' || p.status === 'previewed') && (
          <Banner tone="warning">
            <strong>This plan can be previewed but not applied yet.</strong>
            <ul style={{ margin: '0.4rem 0 0 0', paddingLeft: '1.1rem' }}>
              {tagWritesDisabled && <li>Tag writes are off — <Link to="/settings/$section" params={{ section: 'metadata' }}>Settings › Tag preferences › Tag writes</Link></li>}
              {noWritableRoots && <li>No scan root allows writes — <Link to="/settings/library">Settings › Music folders</Link></li>}
            </ul>
          </Banner>
        )}

        {error && <Banner tone="danger">{error}</Banner>}
        {keptNote && wroteFiles && <p className={styles.keptNote} role="status">{KEPT_PLAN_NOTE}</p>}

        {hasResults && (progress?.applied ?? 0) > 0 && (
          <PlanResults results={results.data} loading={results.isLoading} />
        )}
        {p.status === 'reverted' && <PlanReverted filesWritten={progress?.applied ?? 0} />}

        {!previewed && (
          <Banner tone={previewFailed ? 'danger' : previewStalled ? 'warning' : 'info'}>
            {previewFailed ? (
              <>
                <strong>The preview stopped with an error{current?.error ? `: ${current.error}` : '.'}</strong>{' '}
                Nothing was written. {jobLink('See the job in Background activity')}, or use Retry preview above.
              </>
            ) : previewStalled === 'no-progress' && current ? (
              <>
                <strong>The preview has not reported progress for over a minute.</strong>{' '}
                {current.message ? `Last update: ${current.message}. ` : ''}The background worker may have stopped.{' '}
                {jobLink('Check Background activity')}, or use Retry preview above.
              </>
            ) : previewStalled ? (
              <>
                <strong>
                  {previewStalled === 'queued' && current
                    ? `The preview was queued ${formatRelativeTime(current.queuedAt)} and the background worker has not started it yet.`
                    : `The preview did not report back within ${PREVIEW_TIMEOUT_MS / 1000} seconds.`}
                </strong>{' '}
                The worker may be busy with other jobs or stopped. {jobLink('Check Background activity')}, or use Retry preview above.
              </>
            ) : previewBusy ? (
              <>
                <strong>Computing the preview…</strong>{' '}
                {current?.state === 'running' ? (
                  <>
                    {current.message ?? 'Running'}
                    {current.startedAt ? ` · started ${formatRelativeTime(current.startedAt)}` : ''}.{' '}
                  </>
                ) : current?.state === 'queued' ? (
                  <>Waiting for the background worker to start it. </>
                ) : null}
                Nothing is written. {jobLink('Follow it in Background activity')}.
              </>
            ) : (
              <>
                <strong>No preview yet.</strong>{' '}
                Every file in scope is read once; a whole-library plan can take a few minutes. Nothing is written.
              </>
            )}
          </Banner>
        )}

        {p.status === 'paused' && stats?.lastError && (
          <Banner tone="danger">The last run stopped early: {stats.lastError}. Resume retries the files that were not written.</Banner>
        )}

        {p.status === 'partially_failed' && (
          <Banner tone={statusView.allFailed ? 'danger' : 'warning'}>
            <strong>{statusView.allFailed ? 'No file was written: ' : ''}{(statusCounts['failed'] ?? progress?.failed ?? 0).toLocaleString()} file(s) failed.</strong>{' '}
            Filter the list by status "failed" to see why. A new plan over the same scope previews only what is still different.
          </Banner>
        )}

        {outcome?.explained ? (
          <PreviewOutcomeNotice
            outcome={outcome}
            manual={isManual}
            onIdentify={(ids) => void identify(ids)}
            identifying={identifyAlbums.isPending}
            identifyNote={identifyNote}
            onSetValues={valueScopes.length > 0 && libraryId ? () => setEditingValues(true) : null}
          />
        ) : nothingToDo ? (
          <Banner tone="info">Every file in scope already carries {isManual ? 'the values you set' : 'the canonical values under this policy'}. Nothing to apply.</Banner>
        ) : null}

        {editingValues && libraryId && valueScopes.length > 0 && (
          <BulkTagEditor libraryId={libraryId} scopes={valueScopes} title="Set the values yourself" onClose={() => setEditingValues(false)} />
        )}

        {/* Before apply the counts say what will happen; after it the
            result section says what did, so the cards step aside. */}
        {previewed && stats && !hasResults && p.status !== 'reverted' && !nothingToDo && (
          <div className={styles.stats}>
            <StatCard label="Files affected" value={stats.filesTouched.toLocaleString()} />
            <StatCard label="Field changes" value={stats.fieldsModified.toLocaleString()} />
            {stats.lockedFieldsRespected > 0 && <StatCard label="Locked fields kept" value={stats.lockedFieldsRespected.toLocaleString()} />}
            {stats.filesSkipped.length > 0 && <StatCard label="Files skipped" value={stats.filesSkipped.length.toLocaleString()} tone="warning" />}
          </div>
        )}

        <details className={styles.details}>
          <summary className={styles.detailsSummary}>Details</summary>
          <dl className={styles.detailsList}>
            <dt>Scope</dt><dd>{scopeText || '—'}</dd>
            <dt>Policy</dt><dd>{PRESET_LABEL[p.policy.preset] ?? p.policy.preset}</dd>
            {values.map(([k, v]) => <Fragment key={k}><dt>{k}</dt><dd>{v}</dd></Fragment>)}
            {planUsesId3(p.formats) && <><dt>ID3 version</dt><dd>ID3v{p.policy.id3Version}</dd></>}
            <dt>Created</dt><dd>{formatDateTime(p.createdAt)}</dd>
            {p.appliedAt && <><dt>Applied</dt><dd>{formatDateTime(p.appliedAt)}</dd></>}
          </dl>
        </details>

        {progress && BUSY.has(p.status) && (
          <div className={styles.progress}>
            <div className={styles.bar} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pct)}>
              <div className={styles.fill} style={{ ['--scale' as string]: `${pct / 100}` }} />
            </div>
            <span>{done.toLocaleString()} / {progress.total.toLocaleString()} files{p.status === 'paused' ? ' · paused' : ''}</span>
          </div>
        )}

        {previewed && !nothingToDo && byField.length > 0 && (
          <Card title="Changes by field" actions={field ? <Button variant="ghost" size="sm" onClick={() => { setField(''); setOffset(0); }}>Show all fields</Button> : undefined}>
            <div className={styles.chips}>
              {byField.map(([f, v]) => (
                <button
                  key={f}
                  type="button"
                  className={`${styles.chip} ${field === f ? styles.chipActive : ''}`}
                  onClick={() => { setField(field === f ? '' : f); setOffset(0); }}
                  title={Object.entries(v.reasons).map(([r, n]) => `${n.toLocaleString()} ${reasonLabel(r)}`).join(' · ')}
                  aria-label={`Filter files by ${FIELD_LABELS[f] ?? f}`}
                  aria-pressed={field === f}
                >
                  <span className={styles.chipField}>{FIELD_LABELS[f] ?? f}</span>
                  <span className={styles.chipCount}>{v.files.toLocaleString()}</span>
                  <span className={styles.chipReason}>{Object.keys(v.reasons).map(reasonLabel).join('/')}</span>
                </button>
              ))}
            </div>
          </Card>
        )}

        {previewed && !nothingToDo && (
          <>
            <div className={styles.tools}>
              <Select aria-label="Filter by write status" className={styles.select} value={itemStatus} onChange={(e) => { setItemStatus(e.target.value); setOffset(0); }}>
                <option value="">all files</option>
                {(['pending', 'applying', 'applied', 'failed', 'skipped'] as ItemStatus[]).filter((s) => (statusCounts[s] ?? 0) > 0).map((s) => (
                  <option key={s} value={s}>{s} · {(statusCounts[s] ?? 0).toLocaleString()}</option>
                ))}
              </Select>
              <Input className={styles.input} type="search" placeholder="Filter this page by path…" value={pathFilter} onChange={(e) => setPathFilter(e.target.value)} />
              <Button variant="ghost" size="sm" onClick={toggleAll}>{allOpen ? 'Collapse all' : 'Expand all'}</Button>
              <span className={styles.count}>
                {items.isLoading ? 'Loading…' : total === 0 ? 'No files' : `${(offset + 1).toLocaleString()}–${pageEnd.toLocaleString()} of ${total.toLocaleString()} files`}
              </span>
              <span className={styles.pager}>
                <Button variant="secondary" size="sm" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}>‹</Button>
                <Button variant="secondary" size="sm" disabled={pageEnd >= total} onClick={() => setOffset(offset + PAGE_SIZE)}>›</Button>
              </span>
            </div>

            <div className={styles.files}>
              {visibleItems.length === 0 && !items.isLoading && <div className={styles.empty}>No files match.</div>}
              {visibleItems.map((it) => {
                const rows = (it.diffs as TagDiffEntry[]).filter((d) => d.reason !== 'no-change');
                const open = isOpen(it.id);
                const dir = (it.relPath ?? '').split('/').slice(0, -1).join('/');
                const name = (it.relPath ?? it.audioFileId).split('/').pop();
                const st = (it.status ?? 'pending') as ItemStatus;
                const fieldList = shortFieldList(rows.map((d) => d.field));
                return (
                  <div key={it.id} className={styles.file}>
                    <button type="button" className={styles.fileRow} onClick={() => toggle(it.id)} aria-expanded={open}>
                      <span className={`${styles.caret} ${open ? styles.caretOpen : ''}`}>▶</span>
                      <span><Badge tone={ITEM_TONE[st]}>{st}</Badge></span>
                      <span className={styles.path} title={it.relPath ?? it.audioFileId}>
                        <span className={styles.pathDir}>{dir}</span>
                        <span className={styles.pathFile}>{name}</span>
                        {it.error && <span className={styles.fileError} title={it.error}>{it.error}</span>}
                      </span>
                      <span className={styles.fileFields}>
                        {rows.length === 0 ? (
                          <span className={styles.nChanges}>No changes</span>
                        ) : (
                          <span className={styles.nChanges} title={fieldList}>
                            {rows.length} {rows.length === 1 ? 'change' : 'changes'}
                            <span className="visually-hidden">: {fieldList}</span>
                          </span>
                        )}
                      </span>
                    </button>
                    {open && (
                      <table className={styles.diff}>
                        <colgroup><col className={styles.colField} /><col /><col /><col className={styles.colWhy} /></colgroup>
                        <thead><tr><th>Field</th><th>Before</th><th>After</th><th>Why</th></tr></thead>
                        <tbody>
                          {rows.map((d) => (
                            <tr key={d.field}>
                              <td className={styles.cellField}>{d.field}</td>
                              <td className={styles.cellBefore} data-label="Before">{diffValueText(d.before)}</td>
                              <td className={styles.cellAfter} data-label="After">{d.reason === 'locked' ? <em>kept (locked)</em> : diffValueText(d.after)}</td>
                              <td className={styles.cellWhy} data-label="Why">{diffRowKind(d)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}
                  </div>
                );
              })}
            </div>
          </>
        )}
      </div>
    </PageShell>
  );
}
