/**
 * Tag (vault "tagave - Tag Flow"; owner 2026-11-05: "open up the modal and
 * show the default settings … only if the user wants to edit something then
 * they can tinker with it in the submenus. Otherwise just get me to tag
 * page"). One sheet that already holds the defaults: a new plan for these
 * albums, the album's matched release, the library's default tag settings
 * (Settings › Tag preferences). Preview creates the plan and opens its page,
 * which previews; for a matched album that is one click.
 *
 * Every other choice is a collapsed row with its value on it: Plan (add to
 * one not applied yet), Albums, Release, Split first, Fields, Paths, Name.
 * An album without a match says so in one line and its button picks a
 * release. An album that is one FLAC holding the whole album says how many
 * tracks the plan splits it into (finding the cut points at once).
 *
 * Enter is the primary action, Escape closes, focus goes back to what opened
 * it. A bottom sheet on a phone, a side sheet on a desktop.
 *
 * Import this file directly or lazily: it pulls in the drawer (Sheet).
 */
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { splitFirstLine, type TagPlan } from '@tagave/shared';
import { Sheet } from './ui/Sheet';
import { Button, Collapse, SegmentedControl, ChevronDownIcon } from './ui';
import { api } from '../services/api';
import { useCan } from '../hooks/usePermissions';
import { useCreateTagPlan, useLibrarySettings, useAddToTagPlan, useOpenTagPlans } from '../hooks/usePlanWizard';
import { useScanRoots } from '../hooks/useLibrary';
import { useNaming } from '../hooks/useNaming';
import { useAlbumSplit, useAnalyzeSplit } from '../hooks/useAlbumSplit';
import { CandidateTable } from '../pages/AlbumMatchTable';
import type { AlbumDetail } from '../pages/albumDetailTypes';
import { planDoneNavigation } from './planWizardHistory';
import { defaultPresetOf, PlanPicker, PolicyPicker, ScopePicker, type PolicyState, type ScopeState } from './tagPlanControls';
import { createPayload, enterIsPrimary, policySummary, primaryAction, releaseSummary, scopeSummary, suggestedName } from './tagSheetModel';
import styles from './TagSheet.module.css';
import controls from './tagPlanControls.module.css';

export interface TagSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  libraryId: string;
  /** the albums to tag (album page, a selection); absent: the owner picks what the plan covers */
  albums?: { ids: string[]; labels?: Record<string, string> } | undefined;
  side?: 'bottom' | 'right';
  returnFocus?: RefObject<HTMLElement | null> | undefined;
  /** called once the plan exists, just before the plan page opens */
  onDone?: () => void;
  /** the history entry only showed this sheet (/plans?album=): the plan page replaces it */
  replaceHistoryOnDone?: boolean;
  /** rows open from the start (stories); none otherwise, but what the plan covers when nothing is chosen */
  initialRows?: readonly TagRowId[];
}

export type TagRowId = RowId;
type RowId = 'plan' | 'albums' | 'release' | 'split' | 'fields' | 'paths' | 'name';

/** One collapsed row: its name, its value, and its controls once opened. */
function Row({ id, label, summary, open, onToggle, children, tone }: {
  id: RowId; label: string; summary: ReactNode; open: boolean; onToggle: (id: RowId) => void; children: ReactNode; tone?: 'warning' | undefined;
}) {
  const bodyId = useId();
  return (
    <li className={styles.row} data-row={id} data-open={open || undefined}>
      <button type="button" className={styles.rowHead} aria-expanded={open} aria-controls={bodyId} onClick={() => onToggle(id)}>
        <span className={styles.rowLabel}>{label}</span>
        <span className={tone === 'warning' ? `${styles.rowValue} ${styles.rowValueWarn}` : styles.rowValue}>{summary}</span>
        <span className={styles.chevron} aria-hidden="true"><ChevronDownIcon /></span>
      </button>
      <Collapse open={open} id={bodyId}>
        <div className={styles.rowBody}>{children}</div>
      </Collapse>
    </li>
  );
}

function errorText(e: unknown, fallback: string): string {
  const x = e as { status?: number; detail?: string } | null;
  if (x?.status === 400 && x.detail && x.detail !== 'Request validation failed') return x.detail;
  if (x?.status === 409) return x.detail ?? 'That plan can no longer take albums';
  return fallback;
}

/** The release picker for an album without a match: the possible releases, or a pasted link. */
function ReleasePicker({ libraryId, album }: { libraryId: string; album: AlbumDetail }) {
  const qc = useQueryClient();
  const [showExcluded, setShowExcluded] = useState(false);
  const [input, setInput] = useState('');
  const refresh = () => void qc.invalidateQueries({ queryKey: ['album', album.id] });
  const accept = useMutation({ mutationFn: (candidateId: string) => api.post(`/albums/${album.id}/match`, { candidateId }), onSuccess: refresh });
  const exclude = useMutation({ mutationFn: (candidateId: string) => api.post(`/albums/${album.id}/exclude-candidate`, { candidateId }), onSuccess: refresh });
  const byLink = useMutation({
    mutationFn: () => api.post(`/libraries/${libraryId}/albums/${album.id}/match-mbid`, { input }),
    onSuccess: () => { setInput(''); refresh(); },
  });
  const live = !!album.identifyRequest && album.identifyRequest.status !== 'done';
  return (
    <div className={styles.release}>
      {album.candidates.length > 0 && (
        <CandidateTable
          candidates={album.candidates}
          localTrackCount={album.trackCount}
          localTracks={album.tracks}
          showExcluded={showExcluded}
          onToggleExcluded={() => setShowExcluded((v) => !v)}
          onAccept={(id) => accept.mutate(id)}
          onExclude={(id) => exclude.mutate(id)}
          busy={accept.isPending || exclude.isPending}
        />
      )}
      <div className={styles.linkRow}>
        <input
          type="search"
          className={controls.input}
          aria-label="Release link or ID"
          placeholder="MusicBrainz or Discogs link"
          value={input}
          disabled={live}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && input.trim() && !live) { e.preventDefault(); byLink.mutate(); } }}
        />
        <Button variant="secondary" onClick={() => byLink.mutate()} disabled={!input.trim() || byLink.isPending || live} loading={byLink.isPending}>Match</Button>
      </div>
      {live && <p className={styles.line} role="status">Matching…</p>}
      {byLink.isError && <p className={styles.lineWarn} role="alert">{(byLink.error as { detail?: string })?.detail ?? 'Not matched'}</p>}
    </div>
  );
}

export function TagSheet({ open, onOpenChange, libraryId, albums, side = 'right', returnFocus, onDone, replaceHistoryOnDone = false, initialRows }: TagSheetProps) {
  const navigate = useNavigate();
  const owner = useCan('system.manage');
  const primaryRef = useRef<HTMLButtonElement>(null);
  const single = albums?.ids.length === 1 ? albums.ids[0]! : null;

  const [scope, setScope] = useState<ScopeState>(albums
    ? { scopeType: 'albumIds', albumIds: albums.ids, ...(albums.labels ? { albumLabels: albums.labels } : {}) }
    : { scopeType: null });
  const [policy, setPolicy] = useState<PolicyState>({ preset: 'canonical_ids_and_fill', id3Version: '2.4', multiValueSeparator: '; ' });
  const [name, setName] = useState('');
  const [planChoice, setPlanChoice] = useState('new');
  const [organize, setOrganize] = useState<boolean | null>(null);
  const [split, setSplit] = useState(true);
  const [rows, setRows] = useState<Set<RowId>>(new Set(initialRows ?? (albums ? [] : ['albums'])));
  const [error, setError] = useState<string | null>(null);
  const toggle = (id: RowId) => setRows((cur) => {
    const next = new Set(cur);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  // the library's default policy (Settings › Tag preferences), once it arrives
  const settings = useLibrarySettings(libraryId);
  const seeded = useRef(false);
  useEffect(() => {
    const p = settings.data?.tagPolicy;
    if (seeded.current || !p) return;
    seeded.current = true;
    setPolicy({ preset: defaultPresetOf(p), id3Version: p.id3Version, multiValueSeparator: p.multiValueSeparator, ...(p.overrides ? { overrides: p.overrides } : {}) });
  }, [settings.data]);
  const roots = useScanRoots(libraryId);
  const naming = useNaming(libraryId);
  const openPlansQ = useOpenTagPlans(libraryId);
  const openPlans: TagPlan[] = albums ? openPlansQ.data?.items ?? [] : [];

  // one album: its match (shared with the album page's query) and, for the owner, whether it is one file
  const album = useQuery({
    queryKey: ['album', single],
    queryFn: () => api.get<AlbumDetail>(`/libraries/${libraryId}/albums/${single}`),
    enabled: open && !!single,
    refetchInterval: (q) => {
      const r = (q.state.data as AlbumDetail | undefined)?.identifyRequest;
      return r && r.status !== 'done' ? 2500 : false;
    },
  });
  const splitView = useAlbumSplit(libraryId, single ?? undefined, open && !!single && owner);
  const analyze = useAnalyzeSplit(libraryId, single ?? undefined);
  const splitData = splitView.data;
  const eligible = !!splitData?.eligible;
  // Detection when it matters: the live rule says one file; find the cut points now if they are not found yet
  const asked = useRef(false);
  useEffect(() => {
    if (!open || !splitData || asked.current || analyze.isPending) return;
    const s = splitData.split?.state;
    if (splitData.eligible && (!s || s === 'done' || s === 'failed' || s === 'undone')) {
      asked.current = true;
      analyze.mutate();
    }
  }, [open, splitData, analyze]);
  const splitTracks = splitData?.split?.plan?.tracks.length ?? splitData?.tracks ?? null;

  const create = useCreateTagPlan(libraryId);
  const addTo = useAddToTagPlan(libraryId);

  const a = album.data;
  const unmatched = !!single && !!a && (a.state !== 'matched' || !a.release);
  const addToPlan = planChoice !== 'new' ? openPlans.find((p) => p.id === planChoice) ?? null : null;
  const payload = useMemo(() => createPayload({ scope, policy, name, organize, split: split || !eligible }), [scope, policy, name, organize, split, eligible]);
  const action = primaryAction({ unmatched, scopeReady: !!payload, addTo: !!addToPlan });
  const busy = create.isPending || addTo.isPending;
  const writesOff = settings.data !== undefined && !settings.data.tagWritesEnabled;
  const noRoots = roots.data !== undefined && !roots.data.some((r) => r.writable);
  const organizeOn = organize ?? naming.data?.saved ?? false;

  const go = async () => {
    setError(null);
    if (action.kind === 'pick-release') { setRows((cur) => new Set(cur).add('release')); return; }
    if (action.kind === 'pick-scope') { setRows((cur) => new Set(cur).add('albums')); return; }
    try {
      if (action.kind === 'add' && addToPlan) {
        await addTo.mutateAsync({ planId: addToPlan.id, albumIds: scope.albumIds ?? [] });
        onDone?.();
        void navigate(planDoneNavigation(addToPlan.id, replaceHistoryOnDone));
        return;
      }
      if (!payload) return;
      const plan = await create.mutateAsync(payload);
      // the plan page runs the preview; the route change unmounts the sheet
      onDone?.();
      void navigate(planDoneNavigation(plan.id, replaceHistoryOnDone));
    } catch (e) {
      setError(errorText(e, action.kind === 'add' ? 'Not added' : 'Plan not created'));
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Enter' || e.defaultPrevented || e.nativeEvent.isComposing) return;
    if (!enterIsPrimary(e.target as HTMLInputElement)) return;
    e.preventDefault();
    if (!busy) void go();
  };

  const title = single ? a?.release?.title ?? a?.title ?? albums?.labels?.[single] ?? 'This album' : albums ? `${albums.ids.length} albums` : 'New tag plan';
  const artist = single ? a?.artistCredit ?? null : null;

  return (
    <Sheet open={open} onOpenChange={onOpenChange} title="Tag" side={side} returnFocus={returnFocus} initialFocus={primaryRef}>
      <div className={styles.sheet} data-tag-sheet="" onKeyDown={onKeyDown}>
        <header className={styles.head}>
          <span className={styles.kicker}>Tag</span>
          <h2 className={styles.title}>{title}</h2>
          {artist && <div className={styles.sub}>{artist}</div>}
        </header>

        <div className={styles.lines}>
          {(writesOff || noRoots) && (
            <p className={styles.lineWarn}>
              {writesOff ? 'Tag writes are off' : 'No music folder allows writes'} · <Link to={writesOff ? '/settings/$section' : '/settings/library'} params={writesOff ? { section: 'metadata' } : {}}>Settings</Link>
            </p>
          )}
          {unmatched && <p className={styles.lineWarn} data-line="no-match">No release matched</p>}
          {!unmatched && eligible && split && splitTracks && <p className={styles.line} data-line="split">{splitFirstLine(splitTracks)}</p>}
        </div>

        <ul className={styles.rows}>
          {openPlans.length > 0 && (
            <Row id="plan" label="Plan" summary={addToPlan ? addToPlan.name || 'Untitled plan' : 'New plan'} open={rows.has('plan')} onToggle={toggle}>
              <PlanPicker openPlans={openPlans} total={openPlansQ.data?.total ?? 0} albumIds={scope.albumIds ?? []} value={planChoice} onChange={setPlanChoice} />
            </Row>
          )}
          {!addToPlan && (
            <Row id="albums" label="Albums" summary={scopeSummary(scope) ?? 'Pick'} open={rows.has('albums')} onToggle={toggle}>
              <ScopePicker libraryId={libraryId} state={scope} onChange={setScope} />
            </Row>
          )}
          {single && a && (
            <Row id="release" label="Release" summary={releaseSummary(a.release) ?? 'None'} tone={unmatched ? 'warning' : undefined} open={rows.has('release')} onToggle={toggle}>
              <ReleasePicker libraryId={libraryId} album={a} />
            </Row>
          )}
          {!unmatched && eligible && (
            <Row id="split" label="Split first" summary={split ? (splitTracks ? `On · ${splitTracks} tracks` : 'On') : 'Off'} open={rows.has('split')} onToggle={toggle}>
              <SegmentedControl label="Split first" value={split ? 'on' : 'off'} onChange={(v) => setSplit(v === 'on')} options={[{ value: 'off', label: 'Off' }, { value: 'on', label: 'On' }]} />
            </Row>
          )}
          {!addToPlan && (
            <Row id="fields" label="Fields" summary={policySummary(policy)} open={rows.has('fields')} onToggle={toggle}>
              <PolicyPicker state={policy} onChange={setPolicy} defaultPreset={defaultPresetOf(settings.data?.tagPolicy)} />
            </Row>
          )}
          {!addToPlan && owner && (
            <Row id="paths" label="Paths" summary={organizeOn ? 'Organize · On' : 'Organize · Off'} open={rows.has('paths')} onToggle={toggle}>
              <SegmentedControl label="Organize files" value={organizeOn ? 'on' : 'off'} onChange={(v) => setOrganize(v === 'on')} options={[{ value: 'off', label: 'Off' }, { value: 'on', label: 'On' }]} />
            </Row>
          )}
          {!addToPlan && (
            <Row id="name" label="Name" summary={name.trim() || suggestedName(scope)} open={rows.has('name')} onToggle={toggle}>
              <input className={controls.input} aria-label="Plan name" value={name} placeholder={suggestedName(scope)} onChange={(e) => setName(e.target.value)} />
            </Row>
          )}
        </ul>

        {error && <p className={styles.lineWarn} role="alert">{error}</p>}

        <footer className={styles.foot}>
          <Button ref={primaryRef} variant="primary" data-tag-primary="" onClick={() => void go()} loading={busy} disabled={busy}>
            {action.label}
          </Button>
        </footer>
      </div>
    </Sheet>
  );
}
